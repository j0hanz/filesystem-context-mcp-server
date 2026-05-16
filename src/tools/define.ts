import type {
  CallToolResult,
  ContentBlock,
  ElicitRequestFormParams,
  ElicitResult,
  Icon,
  LoggingLevel,
  McpServer,
  Notification,
  RequestMeta,
  ServerContext,
  StandardSchemaWithJSON,
  Tool,
  ToolAnnotations,
  ToolExecution,
  ToolTaskHandler,
} from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { z } from 'zod/v4';

import { ErrorCode, Problem } from '../core/errors.js';
import type { ProgressCtx } from '../core/fmt.js';
import { plainMessage } from '../core/fmt.js';
import {
  Logger,
  ProgressSession,
  StderrProgressSink,
  withTelemetry,
} from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { toMcpSchema } from '../schema.js';

// ============ Type Definitions ============

// ---- Result wire types ----

type ToolResponse<T> = {
  content: ContentBlock[];
  structuredContent: T;
  isError?: never;
} & Record<string, unknown>;

interface ToolErrorResponse extends Record<string, unknown> {
  content: ContentBlock[];
  isError: true;
  errorCode: ErrorCode;
}

export type ToolResult<T> = ToolResponse<T> | ToolErrorResponse;

export interface PerPathError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
}

export interface PerPathResult<T> {
  path: string;
  value?: T;
  error?: PerPathError;
}

export interface BatchResult<T> {
  results: PerPathResult<T>[];
  summary: { total: number; succeeded: number; failed: number };
}

interface TracingMeta {
  'io.opentelemetry/traceparent'?: string | undefined;
  'io.opentelemetry/tracestate'?: string | undefined;
  'io.opentelemetry/baggage'?: string | undefined;
}

export interface ToolCtx {
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly _meta?: (RequestMeta & TracingMeta) | undefined;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
  readonly log?: (level: LoggingLevel, data: unknown, logger?: string) => void;
  readonly sendNotification?: (notification: Notification) => Promise<void>;
  readonly onProgress?: (params: { current: number; total?: number }) => void;
  readonly elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
}

export interface ToolOrchestrator {
  wrapToolTask<
    Args extends StandardSchemaWithJSON | undefined,
    Result extends Record<string, unknown>,
  >(
    handler: (args: unknown, ctx: ToolCtx) => Promise<ToolResult<Result>>,
    options: {
      toolName: string;
      toolTitle?: string;
      startStatusMessage?: (args: unknown) => string;
      deps: Pick<ToolDeps, 'pathGuard' | 'resourceStore'>;
    },
  ): ToolTaskHandler<Args>;
}

export interface ToolDeps {
  readonly isInitialized: () => boolean;
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
  readonly orchestrator?: ToolOrchestrator;
}

export type IconInfo = Icon & { mimeType: string };

export function withDefaultIcons<T extends object>(
  obj: T,
  iconInfo: IconInfo | undefined,
): T & { icons?: Icon[] } {
  if (!iconInfo) return obj;
  const existing = (obj as { icons?: Icon[] }).icons;
  if (existing && existing.length > 0) return obj;
  return { ...obj, icons: [{ src: iconInfo.src, mimeType: iconInfo.mimeType }] };
}

export interface RunResult<T> {
  readonly structured: T;
  readonly text?: string;
  readonly resources?: ContentBlock[];
}

export interface ToolDef<I extends z.ZodType, O extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly annotations: ToolAnnotations;
  readonly icons?: readonly unknown[];
  readonly execution?: ToolExecution;
  readonly timeoutMs?: number;
  readonly progress?: (args: z.infer<I>) => ProgressCtx;
  readonly progressDone?: (args: z.infer<I>, result: z.infer<O>) => Partial<ProgressCtx>;
  readonly defaultErrorCode?: ErrorCode;
  readonly run: (args: z.infer<I>, ctx: ToolCtx) => Promise<RunResult<z.infer<O>>>;
  readonly nuances?: readonly string[];
  readonly gotchas?: readonly string[];
  readonly inputSchemaAugment?: (schema: Record<string, unknown>) => Record<string, unknown>;
}

export interface DefinedTool extends Tool {
  readonly nuances: readonly string[];
  readonly gotchas: readonly string[];
  register(deps: ToolDeps): void;
}

// ============ Context Builder ============
export function toToolCtx(
  ctx: ServerContext | undefined,
  deps: Pick<ToolDeps, 'pathGuard' | 'resourceStore'>,
): ToolCtx {
  if (!ctx) {
    return {
      signal: new AbortController().signal,
      pathGuard: deps.pathGuard,
      resourceStore: deps.resourceStore,
    };
  }
  return {
    signal: ctx.mcpReq.signal,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
    pathGuard: deps.pathGuard,
    resourceStore: deps.resourceStore,
    sendNotification: async (notification) => ctx.mcpReq.notify(notification),
    log: (level, data, logger) => {
      runDetached('mcp', ctx.mcpReq.log(level, data, logger), 'log');
    },
    elicitInput: (params) => ctx.mcpReq.elicitInput(params),
  };
}

// ============ Execution Context ============

function reportDetachedError(toolName: string, context: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  Logger.emit('warning', `${toolName}: ${context} failed: ${message}`);
}

function runDetached(toolName: string, work: Promise<unknown>, context: string): void {
  void work.catch((error: unknown) => {
    reportDetachedError(toolName, context, error);
  });
}

function resolveProgressCtx<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
  args: z.infer<I>,
): ProgressCtx {
  if (!def.progress) return { label: def.title };
  try {
    return def.progress(args);
  } catch {
    return { label: def.title };
  }
}

class ToolExecutor<I extends z.ZodType, O extends z.ZodType> {
  readonly executionId = randomUUID();
  readonly startTime = performance.now();
  readonly startMemory = process.memoryUsage().rss;
  readonly signal: AbortSignal;

  progressUpdates = 0;
  progressNotificationsEmitted = 0;
  private pendingProgressNotifications = new Set<Promise<void>>();
  private progressClosed = false;
  private progressCursor = 0;
  public outcome: 'success' | 'error' | 'cancelled' = 'success';
  public errorType: string | undefined;
  public errorMessage: string | undefined;

  private stderrSink: StderrProgressSink;
  private progressSession: ProgressSession;
  private progressToken: string | number | undefined;

  private readonly toolName: string;
  private readonly ctx: ToolCtx;
  private readonly def: ToolDef<I, O>;
  private readonly parsedArgs: z.infer<I>;
  private readonly progressCtx: ProgressCtx;
  private readonly toolCtx: ToolCtx;

  constructor(toolName: string, ctx: ToolCtx, def: ToolDef<I, O>, parsedArgs: z.infer<I>) {
    this.toolName = toolName;
    this.ctx = ctx;
    this.def = def;
    this.parsedArgs = parsedArgs;

    const baseSignal = ctx.signal;
    const timeoutSignal = def.timeoutMs ? AbortSignal.timeout(def.timeoutMs) : undefined;
    this.signal = timeoutSignal ? AbortSignal.any([baseSignal, timeoutSignal]) : baseSignal;

    this.progressCtx = resolveProgressCtx(def, parsedArgs);
    this.stderrSink = new StderrProgressSink(this.progressCtx);

    this.progressSession = new ProgressSession({
      label: this.progressCtx.label,
      sinks: [this.stderrSink],
      dynamicRateLimit: true,
    });

    this.progressToken = ctx._meta?.progressToken;

    const ctxLog = ctx.log;
    this.toolCtx = {
      signal: this.signal,
      ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
      ...(ctx._meta ? { _meta: ctx._meta } : {}),
      pathGuard: ctx.pathGuard,
      resourceStore: ctx.resourceStore,
      ...(ctxLog
        ? {
            log: (level: LoggingLevel, data: unknown, logger?: string) => {
              const msg = typeof data === 'string' ? data : String(data);
              Logger.emit(level, msg);
              ctxLog(level, data, logger);
            },
          }
        : {}),
      ...(ctx.sendNotification ? { sendNotification: ctx.sendNotification } : {}),
      onProgress: (p) => {
        this.tickProgress(p);
      },
      ...(ctx.elicitInput ? { elicitInput: ctx.elicitInput } : {}),
    };
  }

  async emitProgress(params: { current: number; total?: number; message?: string }): Promise<void> {
    if (!this.ctx.sendNotification || this.progressToken === undefined) return;
    try {
      await this.ctx.sendNotification({
        method: 'notifications/progress',
        params: {
          progressToken: this.progressToken,
          progress: params.current,
          ...(params.total !== undefined ? { total: params.total } : {}),
          ...(params.message !== undefined ? { message: params.message } : {}),
        },
      });
      this.progressNotificationsEmitted++;
    } catch (error) {
      reportDetachedError(this.toolName, 'progressNotification', error);
    }
  }

  runTrackedProgress(params: { current: number; total?: number; message?: string }): void {
    if (params.current > this.progressCursor) this.progressCursor = params.current;
    const promise = this.emitProgress(params);
    this.pendingProgressNotifications.add(promise);
    runDetached(
      this.toolName,
      promise.finally(() => {
        this.pendingProgressNotifications.delete(promise);
      }),
      'progressNotification',
    );
  }

  startProgress(): void {
    this.runTrackedProgress({
      current: 0,
      message: plainMessage('start', this.progressCtx),
    });
  }

  tickProgress(p: { current: number; total?: number }): void {
    if (this.progressClosed) return;
    this.progressUpdates++;
    const tickCtx: ProgressCtx = {
      ...this.progressCtx,
      current: p.current,
      ...(p.total !== undefined ? { total: p.total } : {}),
    };
    const tickMessage = plainMessage('tick', tickCtx);
    this.progressSession.set({ ...p, message: tickMessage });
    this.runTrackedProgress({ ...p, message: tickMessage });
  }

  async completeProgress(result: z.infer<O>): Promise<void> {
    const doneCtx: ProgressCtx = this.def.progressDone
      ? { ...this.progressCtx, ...this.def.progressDone(this.parsedArgs, result) }
      : this.progressCtx;
    const doneMessage = plainMessage('done', doneCtx);
    this.progressClosed = true;
    this.progressSession.complete(doneMessage);
    const doneCurrent = this.progressCursor + 1;
    await this.emitProgress({
      current: doneCurrent,
      total: doneCurrent,
      message: doneMessage,
    });
    this.outcome = this.signal.aborted ? 'cancelled' : 'success';
  }

  async failProgress(
    error: unknown,
  ): Promise<{ isError: true; content: ContentBlock[]; errorCode?: number | string }> {
    const errMsg = error instanceof Error ? error.message : String(error);
    this.stderrSink.updateCtx({ error: errMsg });
    const failMessage = plainMessage('fail', { ...this.progressCtx, error: errMsg });
    this.progressClosed = true;
    this.progressSession.fail(error, failMessage);
    const failCurrent = this.progressCursor + 1;
    await this.emitProgress({
      current: failCurrent,
      total: failCurrent,
      message: failMessage,
    });

    this.outcome = this.signal.aborted ? 'cancelled' : 'error';
    if (error instanceof Error) {
      this.errorType = error.name;
      this.errorMessage = error.message;
    } else {
      this.errorType = 'UnknownError';
      this.errorMessage = String(error);
    }
    const defaultCode = this.def.defaultErrorCode ?? ErrorCode.UNKNOWN;
    const { code: errorCode, text: errorText } = Problem.toText(error, defaultCode);

    return {
      content: [{ type: 'text' as const, text: errorText }],
      isError: true,
      errorCode,
    };
  }

  async flushNotifications(): Promise<void> {
    if (this.pendingProgressNotifications.size > 0) {
      await Promise.allSettled([...this.pendingProgressNotifications]);
    }
  }

  async execute(args: unknown, deps: ToolDeps): Promise<CallToolResult> {
    return withTelemetry(
      {
        event: 'tool_execution',
        tool_name: this.def.name,
        ...(this.ctx.sessionId ? { session_id: this.ctx.sessionId } : {}),
        ...(this.ctx._meta &&
        'traceparent' in this.ctx._meta &&
        typeof this.ctx._meta['traceparent'] === 'string'
          ? { traceparent: this.ctx._meta['traceparent'] }
          : {}),
      },
      async (enrich) => {
        let inputKeys: string[] | undefined;
        let inputSizeBytes: number | undefined;
        let resultSizeBytes: number | undefined;

        if (args && typeof args === 'object') {
          inputKeys = Object.keys(args);
          try {
            inputSizeBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
          } catch {
            // Ignore serialization error
          }
        }

        enrich({ execution_id: this.executionId });

        try {
          if (!deps.isInitialized()) {
            enrich({ outcome: 'error', error_message: 'Server not initialized.' });
            return {
              isError: true as const,
              content: [
                { type: 'text' as const, text: 'Server not initialized. Roots unavailable.' },
              ],
            };
          }

          this.startProgress();

          const result = await this.def.run(this.parsedArgs, this.toolCtx);

          await this.completeProgress(result.structured);

          const text = result.text ?? JSON.stringify(result.structured);
          const content: ContentBlock[] = [
            { type: 'text' as const, text },
            ...(result.resources ?? []),
          ];

          try {
            resultSizeBytes = Buffer.byteLength(JSON.stringify(result.structured), 'utf8');
          } catch {
            // Ignore serialization error
          }

          return {
            content,
            structuredContent: result.structured as Record<string, unknown>,
          };
        } catch (error: unknown) {
          return await this.failProgress(error);
        } finally {
          await this.flushNotifications();
          enrich({
            ...(inputKeys ? { input_keys: inputKeys } : {}),
            ...(inputSizeBytes !== undefined ? { input_size_bytes: inputSizeBytes } : {}),
            ...(resultSizeBytes !== undefined ? { result_size_bytes: resultSizeBytes } : {}),
            outcome: this.outcome,
            ...(this.errorType ? { error_type: this.errorType } : {}),
            ...(this.errorMessage ? { error_message: this.errorMessage } : {}),
            memory_delta_mb: (process.memoryUsage().rss - this.startMemory) / 1024 / 1024,
            tool_progress_ticks: this.progressUpdates,
            progress_notifications_emitted: this.progressNotificationsEmitted,
          });
        }
      },
    );
  }
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): DefinedTool {
  const { standard: inputSchema, jsonSchema: inputJsonSchema } = toMcpSchema(
    def.input,
    def.inputSchemaAugment,
  );
  const { standard: outputSchema, jsonSchema: outputJsonSchema } = toMcpSchema(def.output);

  const tool: DefinedTool = {
    name: def.name,
    title: def.title,
    description: def.description,
    annotations: def.annotations,
    execution: def.execution ?? { taskSupport: 'forbidden' },
    nuances: def.nuances ?? [],
    gotchas: def.gotchas ?? [],
    inputSchema: inputJsonSchema as Tool['inputSchema'],
    outputSchema: outputJsonSchema as Tool['outputSchema'],

    register(deps: ToolDeps) {
      const toolDefShape = {
        title: def.title,
        description: def.description,
        inputSchema,
        outputSchema,
        annotations: def.annotations,
      };

      const serverCtxHandler = async (
        args: unknown,
        ctx: ServerContext,
      ): Promise<CallToolResult> => {
        const executor = new ToolExecutor<I, O>(
          def.name,
          toToolCtx(ctx, deps),
          def,
          args as z.infer<I>,
        );
        return executor.execute(args, deps);
      };

      const taskSupport = def.execution?.taskSupport;
      if (taskSupport && taskSupport !== 'forbidden' && deps.orchestrator) {
        const taskToolDefShape = {
          title: def.title,
          description: def.description,
          inputSchema,
          outputSchema,
          annotations: def.annotations,
          execution: { ...def.execution, taskSupport },
        };

        deps.server.experimental.tasks.registerToolTask(
          def.name,
          taskToolDefShape,
          deps.orchestrator.wrapToolTask(
            async (args, ctx) => {
              const executor = new ToolExecutor<I, O>(def.name, ctx, def, args as z.infer<I>);
              return executor.execute(args, deps) as Promise<ToolResult<Record<string, unknown>>>;
            },
            {
              toolName: def.name,
              toolTitle: def.title,
              startStatusMessage: (args: unknown) =>
                plainMessage('start', resolveProgressCtx(def, args as z.infer<I>)),
              deps,
            },
          ),
        );
        return;
      }

      deps.server.registerTool(def.name, toolDefShape, serverCtxHandler);
    },
  };

  return tool;
}
