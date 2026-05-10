// src/server.ts — inlined from src/server/{event-store,task-store,task-orchestrator,roots-manager,bootstrap}.ts
import { hostHeaderValidation, localhostHostValidation } from '@modelcontextprotocol/express';
import { NodeStreamableHTTPServerTransport } from '@modelcontextprotocol/node';
import {
  type CallToolResult,
  type CreateTaskResult,
  type CreateTaskServerContext,
  type GetTaskResult,
  InMemoryTaskMessageQueue,
  InMemoryTaskStore,
  isInitializeRequest,
  type JSONRPCMessage,
  McpServer,
  ProtocolErrorCode,
  RELATED_TASK_META_KEY,
  type Root,
  type SetLevelRequest,
  type StandardSchemaWithJSON,
  StdioServerTransport,
  type Task,
  type TaskServerContext,
  type ToolTaskHandler,
} from '@modelcontextprotocol/server';

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';
import { EventEmitter } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';

import express, {
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';
import { z } from 'zod/v4';

import { assertNotAborted, createTimedAbortSignal, withAbort } from './core/concurrency.js';
import { ErrorCode, formatUnknownErrorMessage, McpError } from './core/errors.js';
import {
  createLoggingState,
  Logger,
  type LoggingState,
  LogRouter,
  type LogTarget,
  logToMcp,
  SessionContext,
} from './core/observability.js';
import {
  getValidRootDirectories,
  isPathWithinDirectories,
  normalizePath,
  PathGuard,
  resolveAllowedDirectoriesState,
} from './core/path.js';
import { createInMemoryResourceStore } from './core/store.js';
import {
  debounce,
  DEFAULT_LOG_LEVEL,
  DEFAULT_TASK_TTL_MS,
  getInitHandshakeTimeoutMs,
  INIT_TIMEOUT_CLOSE,
  isRecord,
  MAX_CONCURRENT_TASKS,
  MAX_TASK_TTL_MS,
  maybeStripStructuredContentFromResult,
  parseEnvInt,
  SENSITIVE_FILE_DENYLIST,
} from './core/util.js';
import { pkgInfo } from './pkg-info.js';
import { registerAllPrompts } from './prompts.js';
import {
  registerAllResources,
  type ResourcesHandle,
  serverInstructionsContent,
} from './resources.js';
import { registerAllTools } from './tools.js';
import {
  type IconInfo,
  type ToolContext,
  type ToolResult,
  toToolContext,
  withDefaultIcons,
} from './tools/_helpers.js';

// ═══════════════════════════════════════════════════════════════
// event-store
// ═══════════════════════════════════════════════════════════════

const MAX_EVENTS_PER_STREAM = 1000;

interface StoredEvent {
  id: string;
  message: JSONRPCMessage;
}

export class InMemoryEventStore {
  // Map of streamId -> StoredEvent[]
  private streams = new Map<string, StoredEvent[]>();
  // Map of eventId -> streamId for fast lookup
  private eventIdToStreamId = new Map<string, string>();

  storeEvent(streamId: string, message: JSONRPCMessage): Promise<string> {
    const eventId = randomUUID();
    let stream = this.streams.get(streamId);

    if (!stream) {
      stream = [];
      this.streams.set(streamId, stream);
    }

    // Add new event
    stream.push({ id: eventId, message });
    this.eventIdToStreamId.set(eventId, streamId);

    // Enforce limits
    if (stream.length > MAX_EVENTS_PER_STREAM) {
      const removed = stream.shift();
      if (removed) {
        this.eventIdToStreamId.delete(removed.id);
      }
    }

    return Promise.resolve(eventId);
  }

  getStreamIdForEventId(eventId: string): Promise<string | undefined> {
    return Promise.resolve(this.eventIdToStreamId.get(eventId));
  }

  async replayEventsAfter(
    lastEventId: string,
    callbacks: {
      send: (eventId: string, message: JSONRPCMessage) => Promise<void>;
    },
  ): Promise<string> {
    const streamId = this.eventIdToStreamId.get(lastEventId);
    if (!streamId) {
      throw new Error(`Event ID ${lastEventId} not found or expired`);
    }

    const stream = this.streams.get(streamId);
    if (!stream) {
      throw new Error(`Stream ${streamId} not found`);
    }

    const eventIndex = stream.findIndex((e) => e.id === lastEventId);
    if (eventIndex === -1) {
      throw new Error(`Event ID ${lastEventId} not found in stream ${streamId}`);
    }

    // Replay all events after the found index
    for (let i = eventIndex + 1; i < stream.length; i++) {
      const event = stream[i];
      if (event) {
        await callbacks.send(event.id, event.message);
      }
    }

    return streamId;
  }

  /**
   * Cleans up all events for a given streamId.
   */
  delete(streamId: string): void {
    const stream = this.streams.get(streamId);
    if (stream) {
      for (const event of stream) {
        this.eventIdToStreamId.delete(event.id);
      }
      this.streams.delete(streamId);
    }
  }

  /**
   * Cleans up all streams.
   */
  clear(): void {
    this.streams.clear();
    this.eventIdToStreamId.clear();
  }
}

// ═══════════════════════════════════════════════════════════════
// task-store
// ═══════════════════════════════════════════════════════════════

export class EventedTaskStore extends InMemoryTaskStore {
  public readonly events = new EventEmitter();

  override async updateTaskStatus(
    taskId: string,
    status: Task['status'],
    statusMessage?: string,
    sessionId?: string,
  ): Promise<void> {
    await super.updateTaskStatus(taskId, status, statusMessage, sessionId);

    if (status === 'cancelled') {
      this.events.emit('cancelled', taskId);
    }
  }
}

export function createTaskStore(): EventedTaskStore {
  return new EventedTaskStore();
}

// ═══════════════════════════════════════════════════════════════
// task-orchestrator
// ═══════════════════════════════════════════════════════════════

/**
 * TaskOrchestrator manages the lifecycle of background tasks.
 * It connects the EventedTaskStore with the AbortControllers for cancellation,
 * and intercepts progress notifications to update task status in the store.
 */
export class TaskOrchestrator {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly store: EventedTaskStore) {
    this.store.events.on('cancelled', (taskId: string) => {
      const controller = this.controllers.get(taskId);
      if (controller) {
        // Abort the background execution with a cancellation reason.
        controller.abort(new McpError(ErrorCode.CANCELLED, 'Task execution cancelled.'));
        this.controllers.delete(taskId);
      }
    });
  }

  private creationPromise: Promise<unknown> = Promise.resolve();

  /**
   * Wraps a pure tool handler into an MCP-compliant ToolTaskHandler.
   * This handles the background execution logic, state management, and interception.
   * Supports both (ctx, args) and (args, ctx) signatures from the SDK.
   */
  public wrapToolTask<
    Args extends StandardSchemaWithJSON | undefined,
    Result extends Record<string, unknown>,
  >(
    handler: (args: unknown, ctx: ToolContext) => Promise<ToolResult<Result>>,
    options: { toolName: string },
  ): ToolTaskHandler<Args> {
    const createTask = (async (
      ...params: [unknown, CreateTaskServerContext] | [CreateTaskServerContext]
    ): Promise<CreateTaskResult> => {
      let args: unknown;
      let ctx: CreateTaskServerContext;
      if (params.length === 1) {
        ctx = params[0];
        args = undefined;
      } else {
        [args, ctx] = params;
      }

      const { task } = ctx;

      const mcpTask = (await (this.creationPromise = this.creationPromise
        .catch(() => undefined)
        .then(async () => {
          // Check max concurrent tasks
          let activeCount = 0;
          let cursor: string | undefined;
          do {
            const page = await task.store.listTasks(cursor);
            activeCount += page.tasks.filter((t: Task) => t.status === 'working').length;
            cursor = page.nextCursor;
          } while (cursor);

          if (activeCount >= MAX_CONCURRENT_TASKS) {
            throw new McpError(ErrorCode.INVALID_INPUT, `Too many active tasks (${activeCount})`);
          }

          const requestedTtl =
            'taskRequestedTtl' in ctx && typeof ctx.taskRequestedTtl === 'number'
              ? ctx.taskRequestedTtl
              : DEFAULT_TASK_TTL_MS;
          const ttl = Math.min(requestedTtl, MAX_TASK_TTL_MS);

          // Create the task record in the store.
          return task.store.createTask({
            ttl,
          });
        }))) as Task;

      const controller = new AbortController();
      this.controllers.set(mcpTask.taskId, controller);

      // Start background execution without awaiting it.
      this.executeBackground(mcpTask.taskId, handler, args, ctx, options.toolName).catch(
        (error: unknown) => {
          console.error(
            `[TaskOrchestrator] Fatal error in background task ${mcpTask.taskId}:`,
            error,
          );
        },
      );

      return { task: mcpTask };
    }) as ToolTaskHandler<Args>['createTask'];

    const getTask = (async (
      ...params: [unknown, TaskServerContext] | [TaskServerContext]
    ): Promise<GetTaskResult> => {
      const ctx = params.length === 1 ? params[0] : params[1];
      const { task } = ctx;
      return task.store.getTask(task.id);
    }) as ToolTaskHandler<Args>['getTask'];

    const getTaskResult = (async (
      ...params: [unknown, TaskServerContext] | [TaskServerContext]
    ): Promise<CallToolResult | undefined> => {
      const ctx = params.length === 1 ? params[0] : params[1];
      const { task } = ctx;
      return task.store.getTaskResult(task.id) as Promise<CallToolResult | undefined>;
    }) as ToolTaskHandler<Args>['getTaskResult'];

    return {
      createTask,
      getTask,
      getTaskResult,
    };
  }

  /**
   * Executes the tool handler in the background, handling progress and results.
   */
  private async executeBackground<Args, Result extends Record<string, unknown>>(
    taskId: string,
    handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>,
    args: Args,
    serverCtx: CreateTaskServerContext,
    toolName: string,
  ): Promise<void> {
    const { task } = serverCtx;

    const controller = this.controllers.get(taskId);
    const signal = controller?.signal;

    try {
      // Set initial status message
      await task.store.updateTaskStatus(taskId, 'working', `${toolName}: starting`);

      const toolCtx = toToolContext(serverCtx);
      const interceptedCtx: ToolContext = {
        ...toolCtx,
        ...(signal ? { signal } : {}),
        sendNotification: async (notification) => {
          // Intercept progress notifications to update task status
          if (notification.method === 'notifications/tasks/status') {
            const params = notification.params as Record<string, unknown>;
            const status = (
              typeof params.status === 'string' ? params.status : 'working'
            ) as Task['status'];
            const statusMessage =
              typeof params.statusMessage === 'string' ? params.statusMessage : '';

            await task.store.updateTaskStatus(taskId, status, `${toolName}: ${statusMessage}`);
          } else {
            // Forward other notifications normally
            await toolCtx.sendNotification?.(notification);
          }
        },
      };

      const result = await handler(args, interceptedCtx);

      const strippedResult = maybeStripStructuredContentFromResult(result);
      if (
        strippedResult._meta &&
        typeof strippedResult._meta === 'object' &&
        'io.modelcontextprotocol/model-immediate-response' in strippedResult._meta
      ) {
        // Create a copy to avoid mutating the original
        strippedResult._meta = { ...strippedResult._meta };
        delete (strippedResult._meta as Record<string, unknown>)[
          'io.modelcontextprotocol/model-immediate-response'
        ];
      }

      // Ensure _meta exists and attach RELATED_TASK_META_KEY
      strippedResult._meta = {
        ...(typeof strippedResult._meta === 'object' && strippedResult._meta !== null
          ? strippedResult._meta
          : {}),
        [RELATED_TASK_META_KEY]: { taskId },
      };

      if (strippedResult.isError) {
        const isCancelled = strippedResult.errorCode === ErrorCode.CANCELLED;
        if (isCancelled) {
          try {
            await task.store.updateTaskStatus(taskId, 'cancelled', `${toolName}: cancelled`);
          } catch {
            // ignore
          }
        } else {
          await task.store.storeTaskResult(taskId, 'failed', strippedResult);
        }
      } else {
        await task.store.storeTaskResult(taskId, 'completed', strippedResult);
      }
    } catch (error: unknown) {
      // If we are here, the task might have been cancelled from the outside (store event)
      // or the handler failed.
      const isCancelled =
        (isRecord(error) && error.code === ErrorCode.CANCELLED) || signal?.aborted === true;

      if (isCancelled) {
        try {
          // Only update status if it's not already cancelled or terminal.
          const current = await task.store.getTask(taskId);
          if (current.status !== 'cancelled') {
            await task.store.updateTaskStatus(taskId, 'cancelled', `${toolName}: cancelled`);
          }
        } catch {
          // Best effort for terminal tasks
        }
      } else {
        const message =
          isRecord(error) && typeof error.message === 'string' ? error.message : String(error);
        const code = (
          isRecord(error) && typeof error.code === 'string' ? error.code : ErrorCode.UNKNOWN
        ) as ErrorCode;

        // Store the failure result
        const errorResult = {
          isError: true as const,
          content: [{ type: 'text' as const, text: message }],
          errorCode: code,
          _meta: {
            [RELATED_TASK_META_KEY]: { taskId },
          },
        };
        await task.store.storeTaskResult(
          taskId,
          'failed',
          maybeStripStructuredContentFromResult(errorResult),
        );
      }
    } finally {
      this.controllers.delete(taskId);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// roots-manager
// ═══════════════════════════════════════════════════════════════

const ROOTS_TIMEOUT_MS = 5000;
const ROOTS_DEBOUNCE_MS = 100;

const LIFECYCLE_CHANNEL = channel('filesystem-mcp:lifecycle');

export interface ServerOptions {
  allowCwd?: boolean;
  cliAllowedDirs?: string[];
}

function normalizeCLIDirectories(dirs: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (trimmed.length === 0) continue;
    normalized.push(normalizePath(trimmed));
  }
  return normalized;
}

const RootSchema = z.strictObject({
  uri: z.string(),
  name: z.string().optional(),
});

const RootsResponseSchema = z.strictObject({
  roots: z.array(RootSchema).optional(),
});

function isRoot(value: unknown): value is Root {
  return isRecord(value) && typeof value.uri === 'string';
}

function normalizeRoot(root: Root): Root {
  return root.name ? { uri: root.uri, name: root.name } : { uri: root.uri };
}

function extractRoots(value: unknown): Root[] {
  const parsed = RootsResponseSchema.safeParse(value);
  if (!parsed.success || !parsed.data.roots) {
    return [];
  }
  const roots: Root[] = [];
  for (const root of parsed.data.roots) {
    if (isRoot(root)) {
      roots.push(normalizeRoot(root));
    }
  }
  return roots;
}

async function resolveRootDirectories(roots: Root[]): Promise<string[]> {
  if (roots.length === 0) return [];
  const { signal, cleanup } = createTimedAbortSignal(undefined, ROOTS_TIMEOUT_MS);
  try {
    return await getValidRootDirectories(roots, signal);
  } finally {
    cleanup();
  }
}

async function isRootWithinBaseline(
  normalizedRoot: string,
  baseline: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isPathWithinDirectories(normalizedRoot, baseline)) {
    return false;
  }

  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalizedRoot), signal);
    const normalizedReal = normalizePath(realPath);
    return isPathWithinDirectories(normalizedReal, baseline);
  } catch {
    return false;
  }
}

async function filterRootsWithinBaseline(
  roots: readonly string[],
  baseline: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const normalizedBaseline = normalizeCLIDirectories(baseline);
  const normalizedRoots = roots.map(normalizePath);
  if (normalizedRoots.length === 0) return [];

  const results = await Promise.allSettled(
    normalizedRoots.map((normalizedRoot) =>
      isRootWithinBaseline(normalizedRoot, normalizedBaseline, signal),
    ),
  );

  return normalizedRoots.filter((_, i) => {
    const result = results[i];
    return result?.status === 'fulfilled' && result.value;
  });
}

export class RootsManager {
  private _debouncedUpdate: { (server: McpServer): void; cancel: () => void } | undefined;
  private rootDirectories: string[] = [];
  readonly pathGuard: PathGuard = new PathGuard(SENSITIVE_FILE_DENYLIST);
  private clientInitialized = false;
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  // Guard concurrent root refreshes; if one is already running we queue one
  // replay so the last-known state still gets applied after completion.
  private updatingRoots = false;
  // Tracks whether a roots change arrived while the previous refresh ran.
  private pendingRootsUpdate = false;
  private readonly options: ServerOptions;
  readonly loggingState: LoggingState;

  constructor(options: ServerOptions, loggingState: LoggingState) {
    this.options = options;
    this.loggingState = loggingState;
  }

  isInitialized(): boolean {
    return this.clientInitialized;
  }

  destroy(): void {
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = undefined;
    }
    if (this._debouncedUpdate) {
      this._debouncedUpdate.cancel();
      this._debouncedUpdate = undefined;
    }
  }

  logMissingDirectoriesIfNeeded(server: McpServer): void {
    if (this.pathGuard.getAllowedDirectories().length === 0) {
      this.logMissingDirectories(server);
    }
  }

  registerHandlers(server: McpServer, onInitTimeout?: () => void): void {
    const initHandshakeTimeoutMs = getInitHandshakeTimeoutMs();

    server.server.setNotificationHandler('notifications/initialized', async () => {
      if (this.initTimer) {
        clearTimeout(this.initTimer);
        this.initTimer = undefined;
      }
      this.clientInitialized = true;
      await this.updateRootsFromClient(server);
    });

    server.server.setNotificationHandler('notifications/roots/list_changed', () => {
      if (!this.clientInitialized) return;
      this.scheduleRootsUpdate(server);
    });

    this.initTimer = setTimeout(() => {
      if (!this.clientInitialized) {
        if (LIFECYCLE_CHANNEL.hasSubscribers) {
          LIFECYCLE_CHANNEL.publish({
            phase: 'init_timeout',
            timeoutMs: initHandshakeTimeoutMs,
          });
        }
        logToMcp(
          server,
          'warning',
          `Client did not send notifications/initialized within ${String(initHandshakeTimeoutMs)}ms`,
          this.loggingState.minimumLevel,
        );
        onInitTimeout?.();
      }
      this.initTimer = undefined;
    }, initHandshakeTimeoutMs);
    this.initTimer.unref();
  }

  async recomputeAllowedDirectories(): Promise<void> {
    const cliAllowedDirs = normalizeCLIDirectories(this.options.cliAllowedDirs ?? []);
    const allowCwd = Boolean(this.options.allowCwd);
    const allowCwdDirs = allowCwd ? [normalizePath(process.cwd())] : [];
    const baseline = [...cliAllowedDirs, ...allowCwdDirs];
    const { signal, cleanup } = createTimedAbortSignal(undefined, ROOTS_TIMEOUT_MS);
    try {
      const rootsToInclude =
        baseline.length > 0
          ? await filterRootsWithinBaseline(this.rootDirectories, baseline, signal)
          : this.rootDirectories;

      const combined = [...baseline, ...rootsToInclude];
      const nextState = await resolveAllowedDirectoriesState(combined, signal);
      this.pathGuard.initialize(nextState);
    } finally {
      cleanup();
    }
  }

  private scheduleRootsUpdate(server: McpServer): void {
    this._debouncedUpdate ??= debounce((s: McpServer) => {
      void this.updateRootsFromClient(s);
    }, ROOTS_DEBOUNCE_MS);
    this._debouncedUpdate(server);
  }

  private logMissingDirectories(server?: McpServer): void {
    if (this.options.allowCwd) {
      logToMcp(
        server,
        'notice',
        'No allowed directories specified. Using the current working directory as an allowed directory.',
        this.loggingState.minimumLevel,
      );
      return;
    }

    logToMcp(
      server,
      'warning',
      'No allowed directories specified. Please provide directories as command-line arguments or enable --allow-cwd to use the current working directory.',
      this.loggingState.minimumLevel,
    );
  }

  private async updateRootsFromClient(server: McpServer): Promise<void> {
    // Guard against concurrent executions: if one is already running, queue a
    // single retry so the last-known state is always applied after completion.
    if (this.updatingRoots) {
      this.pendingRootsUpdate = true;
      return;
    }
    this.updatingRoots = true;
    try {
      const clientCapabilities = server.server.getClientCapabilities();
      if (!clientCapabilities?.roots) {
        this.rootDirectories = [];
      } else {
        const rootsResult = await server.server.listRoots(undefined, {
          timeout: ROOTS_TIMEOUT_MS,
        });
        const roots = extractRoots(rootsResult);
        this.rootDirectories = await resolveRootDirectories(roots);
      }
    } catch (error) {
      logToMcp(
        server,
        'debug',
        `[DEBUG] MCP Roots protocol unavailable or failed: ${formatUnknownErrorMessage(error)}`,
        this.loggingState.minimumLevel,
      );
    } finally {
      await this.recomputeAllowedDirectories();
      Logger.info(
        `Roots updated: ${this.rootDirectories.length} root(s), ${this.pathGuard.getAllowedDirectories().length} allowed dir(s)`,
      );
      this.updatingRoots = false;
      // If a change arrived while we were running, apply it now.
      if (this.pendingRootsUpdate) {
        this.pendingRootsUpdate = false;
        void this.updateRootsFromClient(server);
      }
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// bootstrap
// ═══════════════════════════════════════════════════════════════

interface CapabilityOptions {
  enablePromptListChanged?: boolean;
  enableTaskToolRequests?: boolean;
}

type ServerCapabilities = NonNullable<ConstructorParameters<typeof McpServer>[1]>['capabilities'];

type NonOptionalServerCapabilities = NonNullable<ServerCapabilities>;

function buildServerCapabilities(options: CapabilityOptions = {}): NonOptionalServerCapabilities {
  const capabilities: NonOptionalServerCapabilities = {
    logging: {},
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: options.enablePromptListChanged ? { listChanged: true } : {},
    completions: {},
    extensions: {},
  };

  if (options.enableTaskToolRequests) {
    capabilities.tasks = {
      list: {},
      cancel: {},
      requests: { tools: { call: {} } },
    };
  }

  return capabilities;
}

const logRouter = LogRouter.global();

const {
  version: SERVER_VERSION,
  description: SERVER_DESCRIPTION,
  homepage: SERVER_HOMEPAGE,
} = pkgInfo;

const rootsManagers = new WeakMap<McpServer, RootsManager>();
const resourceHandles = new WeakMap<McpServer, ResourcesHandle>();

function getRootsManager(server: McpServer): RootsManager {
  const manager = rootsManagers.get(server);
  if (!manager) {
    throw new Error('Roots manager not initialized for server instance');
  }
  return manager;
}

let cachedIconInfo: Promise<IconInfo | undefined> | undefined;

function getLocalIconInfo(): Promise<IconInfo | undefined> {
  if (cachedIconInfo !== undefined) {
    return cachedIconInfo;
  }

  cachedIconInfo = (async () => {
    const name = 'logo.svg';
    const mime = 'image/svg+xml';
    // From src/server.ts, ../assets/ resolves to the root-level assets/ folder
    const candidates = [`../assets/${name}`];

    for (const candidate of candidates) {
      try {
        const iconPath = new URL(candidate, import.meta.url);
        const buffer = await readFile(iconPath);
        return {
          src: `data:${mime};base64,${buffer.toString('base64')}`,
          mimeType: mime,
        };
      } catch {
        // Try next candidate.
      }
    }

    return undefined;
  })();

  return cachedIconInfo;
}

export async function createServer(
  options: ServerOptions & { isInitialized?: () => boolean } = {},
): Promise<{ server: McpServer }> {
  const resourceStore = createInMemoryResourceStore();
  const localIcon = await getLocalIconInfo();
  const capabilities = buildServerCapabilities({
    enablePromptListChanged: false,
    enableTaskToolRequests: true,
  });

  let taskStore: EventedTaskStore | undefined;
  if (capabilities.tasks) {
    taskStore = createTaskStore();
    capabilities.tasks = {
      ...capabilities.tasks,
      taskStore,
      taskMessageQueue: new InMemoryTaskMessageQueue(),
    };
  }

  const hasTaskSupport = capabilities.tasks?.requests?.tools?.call !== undefined;
  const orchestrator = taskStore ? new TaskOrchestrator(taskStore) : undefined;

  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities,
    enforceStrictCapabilities: true,
  };

  serverConfig.instructions =
    'filesystem-mcp: Secure local filesystem MCP server. ' +
    'Start with: roots -> ls/find -> stat -> read. Never guess paths. ' +
    'For full guidance, read internal://instructions or run the get-help prompt.';

  const server = new McpServer(
    withDefaultIcons(
      {
        name: 'filesystem-mcp',
        title: 'Filesystem MCP',
        version: SERVER_VERSION,
        ...(SERVER_DESCRIPTION ? { description: SERVER_DESCRIPTION } : {}),
        ...(SERVER_HOMEPAGE ? { websiteUrl: SERVER_HOMEPAGE } : {}),
      },
      localIcon,
    ),
    serverConfig,
  );

  const loggingState = createLoggingState(DEFAULT_LOG_LEVEL);
  const rootsManager = new RootsManager(options, loggingState);
  rootsManagers.set(server, rootsManager);

  await rootsManager.recomputeAllowedDirectories();

  server.server.setRequestHandler('logging/setLevel', (req: SetLevelRequest) => {
    loggingState.minimumLevel = req.params.level;
    Logger.notice(`Log level set to ${req.params.level}`);
    return {};
  });

  // Track stdio server by default; HTTP overrides per-session via the registry.
  logRouter.attachStdio({ server, loggingState });

  const resourcesHandle = registerAllResources(server, {
    resourceStore,
    pathGuard: rootsManager.pathGuard,
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });
  resourceHandles.set(server, resourcesHandle);

  registerAllPrompts(server, {
    pathGuard: rootsManager.pathGuard,
    instructions: serverInstructionsContent,
    isInitialized: options.isInitialized ?? (() => rootsManager.isInitialized()),
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });
  registerAllTools(server, {
    pathGuard: rootsManager.pathGuard,
    resourceStore,
    isInitialized: options.isInitialized ?? (() => rootsManager.isInitialized()),
    hasTaskSupport,
    orchestrator,
    ...(localIcon ? { iconInfo: localIcon } : {}),
  });

  return { server };
}

export async function startServer(serverAndHandle: { server: McpServer }): Promise<void> {
  const { server } = serverAndHandle;
  const transport = new StdioServerTransport();
  const rootsManager = getRootsManager(server);

  rootsManager.registerHandlers(
    server,
    INIT_TIMEOUT_CLOSE
      ? () => {
          void server.close();
        }
      : undefined,
  );
  await rootsManager.recomputeAllowedDirectories();
  await server.connect(transport);
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    resourceHandles.get(server)?.destroy();
    rootsManager.destroy();
    logRouter.detachStdio();
    sdkOnClose?.();
  };

  rootsManager.logMissingDirectoriesIfNeeded(server);
}

const MAX_SESSION_ID_LENGTH = 256;
const MAX_BEARER_TOKEN_LENGTH = 4096;
const JSON_RPC_SERVER_ERROR = -32000;
const JSON_RPC_INVALID_REQUEST = ProtocolErrorCode.InvalidRequest;
const JSON_RPC_PARSE_ERROR = ProtocolErrorCode.ParseError;
const JSON_RPC_INTERNAL_ERROR = ProtocolErrorCode.InternalError;

const ALLOWED_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u,
];

function sendJsonRpcError(
  res: ServerResponse,
  status: number,
  code: number,
  message: string,
): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code, message },
      id: null,
    }),
  );
}

function getSessionId(req: IncomingMessage): string | undefined {
  const rawSessionId = req.headers['mcp-session-id'];
  return typeof rawSessionId === 'string' && rawSessionId.length <= MAX_SESSION_ID_LENGTH
    ? rawSessionId
    : undefined;
}

// ---------------------------------------------------------------------------
// HttpAuthGuard — pure auth + binding policy
// ---------------------------------------------------------------------------

/**
 * Pure HTTP auth and binding policy. Holds no state; all functions are
 * directly testable without spinning up a server.
 */
export function isLoopbackHttpHost(host: string): boolean {
  const normalized = host.trim().toLowerCase();
  return (
    normalized === '127.0.0.1' ||
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized === '[::1]'
  );
}

export function isAllowedLocalhostOrigin(origin: string): boolean {
  return ALLOWED_ORIGIN_PATTERNS.some((pattern) => pattern.test(origin));
}

let cachedApiKey: string | undefined;
let cachedExpectedHash: Buffer | undefined;

export function validateBearerAuthorization(apiKey: string, authHeader: unknown): boolean {
  const bearerPrefix = 'Bearer ';
  if (typeof authHeader !== 'string' || !authHeader.startsWith(bearerPrefix)) {
    return false;
  }
  const userKey = authHeader.slice(bearerPrefix.length);
  if (userKey.length > MAX_BEARER_TOKEN_LENGTH) {
    return false;
  }

  let expectedHash: Buffer;
  if (apiKey === cachedApiKey && cachedExpectedHash !== undefined) {
    expectedHash = cachedExpectedHash;
  } else {
    expectedHash = createHash('sha256').update(apiKey).digest();
    cachedApiKey = apiKey;
    cachedExpectedHash = expectedHash;
  }

  const actualHash = createHash('sha256').update(userKey).digest();
  return timingSafeEqual(expectedHash, actualHash);
}

/**
 * Refuse to bind to a non-loopback host without an API key. Throws on
 * policy violation; returns silently when allowed.
 */
export function assertHttpBindingPolicy(host: string, apiKey: string | undefined): void {
  if (isLoopbackHttpHost(host)) return;
  if (apiKey) return;
  throw new Error(
    `Refusing to bind HTTP server to non-loopback host '${host}' without FILESYSTEM_MCP_API_KEY.`,
  );
}

/** Express middleware: reject browser origins outside localhost. */
function originGuardMiddleware(): RequestHandler {
  return (req: Request, res: Response, next: NextFunction): void => {
    const origin = req.get('origin');
    if (origin && !isAllowedLocalhostOrigin(origin)) {
      res.status(403).send('Forbidden: disallowed origin');
      return;
    }
    next();
  };
}

/**
 * Express middleware: when `FILESYSTEM_MCP_API_KEY` is set, require a
 * matching bearer token. No key set = open access (loopback dev mode).
 */
function bearerAuthMiddleware(): RequestHandler {
  const apiKey = process.env.FILESYSTEM_MCP_API_KEY;
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!apiKey) {
      next();
      return;
    }
    if (validateBearerAuthorization(apiKey, req.headers.authorization)) {
      next();
      return;
    }
    res.writeHead(401, {
      'Content-Type': 'application/json',
      'WWW-Authenticate': 'Bearer',
    });
    res.end(
      JSON.stringify({
        jsonrpc: '2.0',
        error: { code: JSON_RPC_SERVER_ERROR, message: 'Unauthorized' },
        id: null,
      }),
    );
  };
}

// ---------------------------------------------------------------------------
// HttpSessionRegistry — owns session map, sweep timer, log-router wiring
// ---------------------------------------------------------------------------

interface HttpSession {
  server: McpServer;
  rootsManager: RootsManager;
  transport: NodeStreamableHTTPServerTransport;
  createdAt: number;
  close: () => Promise<void>;
}

export type { HttpSession };

interface HttpSessionRegistryOptions {
  eventStore: InMemoryEventStore;
  logRouter: LogRouter;
  handshakeTimeoutMs: number;
  sweepIntervalMs?: number;
}

/**
 * Single source of truth for the live HTTP session set. Replaces the previous
 * pair of parallel maps (`sessions` + `activeServers`) and the inline sweep
 * timer in `startHttpServer`. HTTP-specific by design — stdio has no sessions.
 */
export class HttpSessionRegistry {
  private readonly sessions = new Map<string, HttpSession>();
  private readonly eventStore: InMemoryEventStore;
  private readonly logRouter: LogRouter;
  private readonly handshakeTimeoutMs: number;
  private readonly sweepIntervalMs: number;
  private sweepTimer: NodeJS.Timeout | undefined;

  constructor(opts: HttpSessionRegistryOptions) {
    this.eventStore = opts.eventStore;
    this.logRouter = opts.logRouter;
    this.handshakeTimeoutMs = opts.handshakeTimeoutMs;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? opts.handshakeTimeoutMs * 2;
  }

  size(): number {
    return this.sessions.size;
  }

  get(sessionId: string): HttpSession | undefined {
    return this.sessions.get(sessionId);
  }

  add(sessionId: string, session: HttpSession, logTarget: LogTarget): void {
    this.sessions.set(sessionId, session);
    this.logRouter.attachSession(sessionId, logTarget);
  }

  remove(sessionId: string): void {
    this.sessions.delete(sessionId);
    this.logRouter.detachSession(sessionId);
    this.eventStore.delete(sessionId);
  }

  getOrRespondNotFound(sessionId: string, res: ServerResponse): HttpSession | undefined {
    const session = this.sessions.get(sessionId);
    if (!session) {
      sendJsonRpcError(res, 404, JSON_RPC_SERVER_ERROR, 'Session not found');
      return undefined;
    }
    return session;
  }

  startSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => {
      this.sweepStale();
    }, this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  private sweepStale(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (
        !session.rootsManager.isInitialized() &&
        now - session.createdAt > this.handshakeTimeoutMs
      ) {
        Logger.warn(`[HTTP] Evicting stale session ${sessionId}`);
        session.close().catch((err: unknown) => {
          Logger.error(
            `[HTTP] Error closing stale session ${sessionId}:`,
            formatUnknownErrorMessage(err),
          );
          this.eventStore.delete(sessionId);
        });
      }
    }
  }

  async closeAll(): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = undefined;
    }
    const closes = Array.from(this.sessions.values()).map((session) =>
      session.close().catch((err: unknown) => {
        Logger.error('[HTTP] Error closing session on shutdown:', formatUnknownErrorMessage(err));
      }),
    );
    await Promise.allSettled(closes);
    this.eventStore.clear();
  }
}

const MAX_REQUEST_BODY_BYTES = parseEnvInt(
  'FS_CONTEXT_MAX_REQUEST_BYTES',
  4 * 1024 * 1024,
  1024,
  256 * 1024 * 1024,
);

async function createHttpSession(
  options: ServerOptions,
  registry: HttpSessionRegistry,
  eventStore: InMemoryEventStore,
): Promise<HttpSession> {
  const { server: mcpServer } = await createServer(options);
  const rootsManager = getRootsManager(mcpServer);

  rootsManager.registerHandlers(mcpServer);
  await rootsManager.recomputeAllowedDirectories();

  let cleanedUp = false;
  const cleanup = (): void => {
    if (cleanedUp) return;
    cleanedUp = true;
    resourceHandles.get(mcpServer)?.destroy();
    const { sessionId } = transport;
    if (sessionId) {
      registry.remove(sessionId);
    }
    rootsManager.destroy();
  };

  const close = async (): Promise<void> => {
    cleanup();
    await mcpServer.close();
  };

  const transport = new NodeStreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    eventStore,
    retryInterval: 2_000,
    onsessioninitialized: (sessionId) => {
      registry.add(
        sessionId,
        {
          server: mcpServer,
          rootsManager,
          transport,
          createdAt: Date.now(),
          close,
        },
        { server: mcpServer, loggingState: rootsManager.loggingState },
      );
      rootsManager.logMissingDirectoriesIfNeeded(mcpServer);
    },
    onsessionclosed: async (sessionId) => {
      const session = registry.get(sessionId);
      if (session) {
        await session.close();
      }
    },
  });

  transport.onclose = cleanup;

  await mcpServer.connect(transport);

  return {
    server: mcpServer,
    rootsManager,
    transport,
    createdAt: Date.now(),
    close,
  };
}

async function handleSessionTransportRequest(
  session: HttpSession,
  req: IncomingMessage,
  res: ServerResponse,
  body?: unknown,
): Promise<void> {
  const store = session.transport.sessionId ? { sessionId: session.transport.sessionId } : {};
  await SessionContext.run(store, async () => {
    await session.transport.handleRequest(req, res, body);
  });
}

export async function startHttpServer(port: number, options: ServerOptions): Promise<Server> {
  const eventStore = new InMemoryEventStore();
  const httpHost = process.env.FILESYSTEM_MCP_HTTP_HOST ?? '127.0.0.1';
  assertHttpBindingPolicy(httpHost, process.env.FILESYSTEM_MCP_API_KEY);

  const registry = new HttpSessionRegistry({
    eventStore,
    logRouter,
    handshakeTimeoutMs: getInitHandshakeTimeoutMs(),
  });

  const app = express();

  if (isLoopbackHttpHost(httpHost)) {
    app.use(localhostHostValidation());
  } else {
    app.use(hostHeaderValidation([httpHost]));
  }

  app.use(originGuardMiddleware());

  app.options('/mcp', (req: Request, res: Response) => {
    res.header('Access-Control-Allow-Origin', req.headers.origin ?? '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.header(
      'Access-Control-Allow-Headers',
      'Content-Type, Authorization, mcp-session-id, mcp-protocol-version',
    );
    res.status(204).end();
  });

  app.use('/mcp', bearerAuthMiddleware());

  app.use(express.json({ limit: MAX_REQUEST_BODY_BYTES }));

  // Body-parse error handler — translate to JSON-RPC error format
  app.use((err: Error & { status?: number }, _req: Request, res: Response, next: NextFunction) => {
    if (err.status === 413) {
      sendJsonRpcError(res, 413, JSON_RPC_INVALID_REQUEST, 'Request body too large');
      return;
    }
    if (err.status === 400) {
      sendJsonRpcError(res, 400, JSON_RPC_PARSE_ERROR, 'Invalid JSON in request body');
      return;
    }
    next(err);
  });

  app.post('/mcp', async (req: Request, res: Response) => {
    try {
      const sessionId = getSessionId(req);
      if (sessionId) {
        const session = registry.getOrRespondNotFound(sessionId, res);
        if (session) {
          await handleSessionTransportRequest(session, req, res, req.body);
        }
        return;
      }
      if (isInitializeRequest(req.body)) {
        const maxSessions = parseEnvInt('FILESYSTEM_MCP_MAX_HTTP_SESSIONS', 100, 1, 10_000);
        if (registry.size() >= maxSessions) {
          sendJsonRpcError(res, 503, JSON_RPC_SERVER_ERROR, 'Too many sessions');
          return;
        }
        const session = await createHttpSession(options, registry, eventStore);
        await handleSessionTransportRequest(session, req, res, req.body);
        return;
      }
      sendJsonRpcError(
        res,
        400,
        JSON_RPC_SERVER_ERROR,
        'Bad Request: No valid session ID provided',
      );
    } catch (error) {
      Logger.error('[HTTP] Error handling POST request:', formatUnknownErrorMessage(error));
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, JSON_RPC_INTERNAL_ERROR, 'Internal Server Error');
      }
    }
  });

  const handleGetOrDelete = async (req: Request, res: Response) => {
    try {
      const sessionId = getSessionId(req);
      if (!sessionId) {
        sendJsonRpcError(res, 400, JSON_RPC_SERVER_ERROR, 'Bad Request: Missing session ID');
        return;
      }
      const session = registry.getOrRespondNotFound(sessionId, res);
      if (session) {
        await handleSessionTransportRequest(session, req, res);
      }
    } catch (error) {
      Logger.error(
        `[HTTP] Error handling ${req.method} request:`,
        formatUnknownErrorMessage(error),
      );
      if (!res.headersSent) {
        sendJsonRpcError(res, 500, JSON_RPC_INTERNAL_ERROR, 'Internal Server Error');
      }
    }
  };

  app.get('/mcp', handleGetOrDelete);
  app.delete('/mcp', handleGetOrDelete);

  app.all('/mcp', (_req: Request, res: Response) => {
    res.status(405).set('Allow', 'GET, POST, DELETE, OPTIONS').end();
  });

  const httpServer = createHttpServer(app);
  httpServer.headersTimeout = 10_000;
  httpServer.requestTimeout = 30_000;
  httpServer.keepAliveTimeout = 5_000;

  registry.startSweep();

  httpServer.once('close', () => {
    void registry.closeAll();
  });

  const originalClose = httpServer.close.bind(httpServer);
  httpServer.close = function (callback?: (error?: Error) => void) {
    void registry.closeAll();
    return originalClose(callback);
  };

  return new Promise((resolve, reject) => {
    httpServer
      .listen(port, httpHost, () => {
        Logger.info(`[HTTP] Server listening on http://${httpHost}:${port}`);
        resolve(httpServer);
      })
      .on('error', reject);
  });
}
