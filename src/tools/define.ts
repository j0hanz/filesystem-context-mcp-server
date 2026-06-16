import type {
  CallToolResult,
  ContentBlock,
  ElicitRequestFormParams,
  ElicitResult,
  Icon,
  LoggingLevel,
  McpServer,
  Notification,
  ProgressNotificationParams,
  RequestMeta,
  ServerContext,
  StandardSchemaWithJSON,
  Tool,
  ToolAnnotations,
  ToolExecution,
} from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';

import * as z from 'zod/v4';

import { processInParallel } from '../core/concurrency.js';
import { ErrorCode, FsError, Problem } from '../core/errors.js';
import { ansiLine, type Phase, plainMessage, type ProgressCtx } from '../core/fmt.js';
import { GuardedFileSystem } from '../core/fs.js';
import { Logger, withTelemetry } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { PARALLEL_CONCURRENCY } from '../core/util.js';

// ============ Type Definitions ============

export interface PerPathError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
}

export type PerPathResult<T> = { path: string; value: T } | { path: string; error: PerPathError };

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
  readonly fs: GuardedFileSystem;
  readonly resourceStore: ResourceStore | undefined;
  readonly log?: (level: LoggingLevel, data: unknown, logger?: string) => void;
  readonly sendNotification?: (notification: Notification) => Promise<void>;
  readonly onProgress?: (params: { current: number; total?: number }) => void;
  readonly elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
  readonly server?: McpServer;
}

export interface ToolDeps {
  readonly isInitialized: () => boolean;
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
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
  readonly _def?: ToolDef<z.ZodType, z.ZodType>;

  register(deps: ToolDeps): void;
}

// ============ Context Builder ============

function toToolCtx(
  ctx: ServerContext | undefined,
  deps: Pick<ToolDeps, 'pathGuard' | 'resourceStore' | 'server'>,
): ToolCtx {
  if (!ctx) {
    const signal = new AbortController().signal;
    return {
      signal,
      pathGuard: deps.pathGuard,
      fs: new GuardedFileSystem(deps.pathGuard),
      resourceStore: deps.resourceStore,
      server: deps.server,
    };
  }
  return {
    signal: ctx.mcpReq.signal,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
    pathGuard: deps.pathGuard,
    fs: new GuardedFileSystem(deps.pathGuard),
    resourceStore: deps.resourceStore,
    sendNotification: async (notification) => ctx.mcpReq.notify(notification),
    log: (level, data, logger) => {
      runDetached('mcp', ctx.mcpReq.log(level, data, logger), 'log');
    },
    elicitInput: (params) => ctx.mcpReq.elicitInput(params),
    server: deps.server,
  };
}

function buildExecutionCtx(
  ctx: ToolCtx,
  signal: AbortSignal,
  onProgress: (p: { current: number; total?: number }) => void,
): ToolCtx {
  const ctxLog = ctx.log;
  return {
    signal,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx._meta ? { _meta: ctx._meta } : {}),
    pathGuard: ctx.pathGuard,
    fs: new GuardedFileSystem(ctx.pathGuard),
    resourceStore: ctx.resourceStore,
    ...(ctx.server ? { server: ctx.server } : {}),
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
    onProgress,
    ...(ctx.elicitInput ? { elicitInput: ctx.elicitInput } : {}),
  };
}

// ============ Execution Helpers ============

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
  } catch (err: unknown) {
    Logger.warn(`resolveProgressCtx: ${def.name}.progress threw: ${String(err)}`);
    return { label: def.title };
  }
}

function composeSignal(base: AbortSignal, timeoutMs?: number): AbortSignal {
  if (!timeoutMs) return base;
  return AbortSignal.any([base, AbortSignal.timeout(timeoutMs)]);
}

function measureInput(args: unknown): { inputKeys?: string[]; inputSizeBytes?: number } {
  if (!args || typeof args !== 'object') return {};
  const inputKeys = Object.keys(args);
  try {
    return { inputKeys, inputSizeBytes: Buffer.byteLength(JSON.stringify(args), 'utf8') };
  } catch (err: unknown) {
    Logger.debug(`measureInput: JSON.stringify failed: ${String(err)}`);
    return { inputKeys };
  }
}

function tryMeasureBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch (err: unknown) {
    Logger.debug(`tryMeasureBytes: JSON.stringify failed: ${String(err)}`);
    return undefined;
  }
}

/**
 * The cast `result.structured as Record<string, unknown>` is required by the MCP SDK's `CallToolResult.structuredContent` type.
 * Callers MUST ensure tool output schemas resolve to object types (not primitives), otherwise the cast is silently unsound.
 */
function buildSuccessResponse<O>(result: RunResult<O>): CallToolResult {
  const text = result.text ?? JSON.stringify(result.structured);
  const content: ContentBlock[] = [{ type: 'text' as const, text }, ...(result.resources ?? [])];
  return {
    content,
    structuredContent: result.structured as Record<string, unknown>,
  };
}

function extractTracingMeta(meta: (RequestMeta & TracingMeta) | undefined): Record<string, string> {
  if (meta && 'traceparent' in meta && typeof meta['traceparent'] === 'string') {
    return { traceparent: meta['traceparent'] };
  }
  return {};
}

// ============ Progress Types ============

export type ProgressEvent =
  | { kind: 'tick'; current: number; total?: number; message: string }
  | { kind: 'status'; message: string }
  | { kind: 'complete'; current: number; total?: number; message: string }
  | {
      kind: 'fail';
      current: number;
      total?: number;
      message: string;
      error: unknown;
    };

export interface ProgressSink {
  readonly name: string;
  emit(event: ProgressEvent): Promise<void> | void;
}

interface ProgressSessionOptions {
  label: string;
  total?: number;
  sinks: ProgressSink[];
  /** Clock injection for deterministic rate-limit tests. Defaults to Date.now. */
  now?: () => number;
  /** Override the rate limit window. Default: 50ms. */
  rateLimitMs?: number;
  /** If true, rate limit window increases after 5 seconds of execution. */
  dynamicRateLimit?: boolean;
}

const DEFAULT_RATE_LIMIT_MS = 50;

export class ProgressSession {
  readonly #label: string;
  readonly #total: number | undefined;
  readonly #sinks: ProgressSink[];
  readonly #now: () => number;
  readonly #rateLimitMs: number;
  readonly #dynamicRateLimit: boolean;
  readonly #startTime: number;

  #cursor = 0;
  #lastSentMs = 0;
  #done = false;

  constructor(opts: ProgressSessionOptions) {
    this.#label = opts.label;
    this.#total = opts.total;
    this.#sinks = opts.sinks;
    this.#now = opts.now ?? Date.now;
    this.#rateLimitMs = opts.rateLimitMs ?? DEFAULT_RATE_LIMIT_MS;
    this.#dynamicRateLimit = opts.dynamicRateLimit ?? false;

    const now = this.#now();
    this.#startTime = now;
    this.#lastSentMs = now - this.#rateLimitMs;

    // Synthetic start tick — preserves today's "fire 0/total at session creation" wire behavior.
    this.#dispatch({
      kind: 'tick',
      current: 0,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message: this.#label,
    });
  }

  get current(): number {
    return this.#cursor;
  }

  step(message: string): void {
    if (this.#done) return;
    this.#cursor += 1;
    this.#dispatch({
      kind: 'tick',
      current: this.#cursor,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message,
    });
  }

  set(input: { current: number; total?: number; message?: string }): void {
    if (this.#done) return;
    if (input.current > this.#cursor) {
      this.#cursor = input.current;
    }
    const total = input.total ?? this.#total;
    this.#dispatch({
      kind: 'tick',
      current: this.#cursor,
      ...(total !== undefined ? { total } : {}),
      message: input.message ?? this.#label,
    });
  }

  status(message: string): void {
    if (this.#done) return;
    this.#dispatch({
      kind: 'status',
      message,
    });
  }

  complete(message: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#dispatch({
      kind: 'complete',
      current: this.#cursor,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message,
    });
  }

  fail(error: unknown, message?: string): void {
    if (this.#done) return;
    this.#done = true;
    this.#dispatch({
      kind: 'fail',
      current: this.#cursor,
      ...(this.#total !== undefined ? { total: this.#total } : {}),
      message: message ?? this.#label,
      error,
    });
  }

  #dispatch(event: ProgressEvent): void {
    if (this.#shouldRateLimit(event)) {
      return;
    }

    if (event.kind !== 'status') {
      this.#lastSentMs = this.#now();
    }

    for (const sink of this.#sinks) {
      this.#emitGuarded(sink, event);
    }
  }

  #shouldRateLimit(event: ProgressEvent): boolean {
    if (event.kind !== 'tick') {
      return false;
    }

    const now = this.#now();
    const effectiveRateLimit =
      this.#dynamicRateLimit && now - this.#startTime > 5000
        ? Math.max(this.#rateLimitMs, 250)
        : this.#rateLimitMs;

    const elapsed = now - this.#lastSentMs;
    return elapsed < effectiveRateLimit;
  }

  #emitGuarded(sink: ProgressSink, event: ProgressEvent): void {
    try {
      const result = sink.emit(event);
      if (result instanceof Promise) {
        result.catch((err: unknown) => {
          Logger.warn('ProgressSink emit failed', {
            sink: sink.name,
            eventKind: event.kind,
            err,
          });
        });
      }
    } catch (err) {
      Logger.warn('ProgressSink emit failed', {
        sink: sink.name,
        eventKind: event.kind,
        err,
      });
    }
  }
}

export class StderrProgressSink implements ProgressSink {
  readonly name = 'stderr';
  readonly #startMs: number;
  #ctx: ProgressCtx;
  readonly #writeFn: (line: string) => void;

  constructor(ctx: ProgressCtx, writeFn?: (line: string) => void) {
    this.#ctx = ctx;
    this.#startMs = Date.now();
    this.#writeFn =
      writeFn ??
      ((line) => {
        process.stderr.write(line + '\n');
      });
  }

  updateCtx(extra: Partial<ProgressCtx>): void {
    this.#ctx = { ...this.#ctx, ...extra };
  }

  emit(event: ProgressEvent): void {
    if (!process.stderr.isTTY) return;

    const phase: Phase =
      event.kind === 'complete'
        ? 'done'
        : event.kind === 'fail'
          ? 'fail'
          : event.kind === 'tick' && event.current === 0
            ? 'start'
            : 'tick';

    const merged: ProgressCtx = {
      ...this.#ctx,
      ...(event.message ? { subject: event.message } : {}),
      ...(event.kind === 'tick' || event.kind === 'complete'
        ? { current: event.current, total: event.total }
        : {}),
      ...(event.kind === 'fail'
        ? { error: event.error instanceof Error ? event.error.message : String(event.error) }
        : {}),
      durationMs: Date.now() - this.#startMs,
    };

    try {
      this.#writeFn(ansiLine(phase, merged));
    } catch {
      // never allow observability failures to affect tool execution
    }
  }
}

// ============ Progress Tracking ============

class McpProgressSink implements ProgressSink {
  readonly name = 'mcp';
  private readonly toolName: string;
  private readonly token: string | number;
  private readonly notify: (n: Notification) => Promise<void>;
  readonly pending = new Set<Promise<void>>();
  emittedCount = 0;

  constructor(
    toolName: string,
    token: string | number,
    notify: (n: Notification) => Promise<void>,
  ) {
    this.toolName = toolName;
    this.token = token;
    this.notify = notify;
  }

  emit(event: ProgressEvent): void {
    if (event.kind === 'status') {
      return;
    }
    let current = event.current;
    let total = event.total;
    if (event.kind === 'complete' || event.kind === 'fail') {
      current = total ?? current + 1;
      total = current;
    }
    const notificationParams: ProgressNotificationParams = {
      progressToken: this.token,
      progress: current,
      ...(total !== undefined ? { total } : {}),
      message: event.message,
    };
    const promise = this.notify({
      method: 'notifications/progress',
      params: notificationParams,
    })
      .then(() => {
        this.emittedCount++;
      })
      .catch((error: unknown) => {
        reportDetachedError(this.toolName, 'progressNotification', error);
      });
    this.pending.add(promise);
    runDetached(
      this.toolName,
      promise.finally(() => {
        this.pending.delete(promise);
      }),
      'progressNotification',
    );
  }

  async flush(): Promise<void> {
    if (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
    }
  }
}

class ProgressTracker {
  tickCount = 0;
  private closed = false;
  private readonly ctx: ProgressCtx;
  private readonly mcpSink?: McpProgressSink;
  private readonly stderrSink: StderrProgressSink;
  private readonly session: ProgressSession;

  constructor(
    toolName: string,
    ctx: ProgressCtx,
    token: string | number | undefined,
    notify: ((n: Notification) => Promise<void>) | undefined,
  ) {
    this.ctx = ctx;
    this.stderrSink = new StderrProgressSink(ctx);

    const sinks: ProgressSink[] = [this.stderrSink];
    if (token !== undefined && notify !== undefined) {
      this.mcpSink = new McpProgressSink(toolName, token, notify);
      sinks.push(this.mcpSink);
    }

    const isTest = process.env['NODE_ENV'] === 'test' || process.execArgv.includes('--test');
    this.session = new ProgressSession({
      label: ctx.label,
      sinks,
      ...(isTest ? { rateLimitMs: 0 } : {}),
      dynamicRateLimit: !isTest,
    });
  }

  get progressCtx(): ProgressCtx {
    return this.ctx;
  }

  get emittedCount(): number {
    return this.mcpSink ? this.mcpSink.emittedCount : 0;
  }

  start(): void {
    // No-op as ProgressSession constructor already emitted start tick.
  }

  tick(p: { current: number; total?: number }): void {
    if (this.closed) return;
    this.tickCount++;
    const tickCtx: ProgressCtx = {
      ...this.ctx,
      current: p.current,
      ...(p.total !== undefined ? { total: p.total } : {}),
    };
    const message = plainMessage('tick', tickCtx);
    this.session.set({ ...p, message });
  }

  updateStderrError(errMsg: string): void {
    this.stderrSink.updateCtx({ error: errMsg });
  }

  async closeWithDone(message: string): Promise<void> {
    this.closed = true;
    this.session.complete(message);
    if (this.mcpSink) {
      await this.mcpSink.flush();
    }
  }

  async closeWithFail(error: unknown, message: string): Promise<void> {
    this.closed = true;
    this.session.fail(error, message);
    if (this.mcpSink) {
      await this.mcpSink.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.mcpSink) {
      await this.mcpSink.flush();
    }
  }
}

// ============ Tool Execution ============

class ToolExecutor<I extends z.ZodType, O extends z.ZodType> {
  private readonly executionId = randomUUID();
  private readonly startMemory = process.memoryUsage().rss;

  readonly signal: AbortSignal;
  private readonly def: ToolDef<I, O>;
  private readonly parsedArgs: z.infer<I>;
  private readonly tracker: ProgressTracker;
  private readonly toolCtx: ToolCtx;

  private outcome: 'success' | 'error' | 'cancelled' = 'success';
  private errorType: string | undefined;
  private errorMessage: string | undefined;

  constructor(toolName: string, ctx: ToolCtx, def: ToolDef<I, O>, parsedArgs: z.infer<I>) {
    this.def = def;
    this.parsedArgs = parsedArgs;
    this.signal = composeSignal(ctx.signal, def.timeoutMs);
    const progressCtx = resolveProgressCtx(def, parsedArgs);
    this.tracker = new ProgressTracker(
      toolName,
      progressCtx,
      ctx._meta?.progressToken,
      ctx.sendNotification,
    );
    this.toolCtx = buildExecutionCtx(ctx, this.signal, (p) => {
      this.tracker.tick(p);
    });
  }

  private async completeProgress(result: z.infer<O>): Promise<void> {
    const doneCtx: ProgressCtx = this.def.progressDone
      ? { ...this.tracker.progressCtx, ...this.def.progressDone(this.parsedArgs, result) }
      : this.tracker.progressCtx;
    await this.tracker.closeWithDone(plainMessage('done', doneCtx));
  }

  private async failProgress(error: unknown): Promise<{ isError: true; content: ContentBlock[] }> {
    const errMsg = error instanceof Error ? error.message : String(error);
    this.tracker.updateStderrError(errMsg);
    const message = plainMessage('fail', { ...this.tracker.progressCtx, error: errMsg });
    await this.tracker.closeWithFail(error, message);
    const { text: errorText } = Problem.toText(
      error,
      this.def.defaultErrorCode ?? ErrorCode.UNKNOWN,
    );
    return {
      content: [{ type: 'text' as const, text: errorText }],
      isError: true,
    };
  }

  private buildAccessDeniedHandler(): ((blockedPath: string) => Promise<boolean>) | undefined {
    if (!this.toolCtx.elicitInput) return undefined;
    const elicitInput = this.toolCtx.elicitInput;
    const mcpServer = this.toolCtx.server;
    if (mcpServer == null) return undefined;
    let caps: ReturnType<typeof mcpServer.server.getClientCapabilities>;
    try {
      caps = mcpServer.server.getClientCapabilities();
    } catch {
      return undefined;
    }
    if (!caps?.elicitation) return undefined;

    const fs = this.toolCtx.fs;
    const pathGuard = this.toolCtx.pathGuard;

    const probe = async (path: string): Promise<'directory' | 'file' | 'missing'> => {
      try {
        const s = await fs.statUnchecked(path);
        return s.isDirectory() ? 'directory' : 'file';
      } catch {
        return 'missing';
      }
    };

    const confirm = async (targetDir: string): Promise<boolean> => {
      const response = await elicitInput({
        mode: 'form',
        message: `Grant filesystem access to: ${targetDir}?`,
        requestedSchema: {
          type: 'object',
          properties: { confirm: { type: 'boolean', title: 'Confirm' } },
          required: ['confirm'],
        },
      });
      return response.action === 'accept' && response.content?.['confirm'] === true;
    };

    return (blockedPath: string) => pathGuard.requestAccessGrant(blockedPath, { probe, confirm });
  }

  async execute(args: unknown, deps: ToolDeps): Promise<CallToolResult> {
    if (!deps.isInitialized()) {
      return {
        isError: true as const,
        content: [{ type: 'text' as const, text: 'Server not initialized. Roots unavailable.' }],
      };
    }

    const handler = this.buildAccessDeniedHandler();
    if (handler !== undefined && (this.toolCtx.pathGuard as unknown) != null) {
      this.toolCtx.pathGuard.onAccessDenied = handler;
    }

    try {
      return await withTelemetry(
        {
          event: 'tool_execution',
          tool_name: this.def.name,
          ...(this.toolCtx.sessionId ? { session_id: this.toolCtx.sessionId } : {}),
          ...extractTracingMeta(this.toolCtx._meta),
        },
        async (enrich) => {
          enrich({ execution_id: this.executionId });
          const { inputKeys, inputSizeBytes } = measureInput(args);
          let resultSizeBytes: number | undefined;

          try {
            this.tracker.start();
            const result = await this.def.run(this.parsedArgs, this.toolCtx);
            await this.completeProgress(result.structured);
            this.outcome = this.signal.aborted ? 'cancelled' : 'success';
            resultSizeBytes = tryMeasureBytes(result.structured);
            return buildSuccessResponse(result);
          } catch (error) {
            const response = await this.failProgress(error);
            this.outcome = this.signal.aborted ? 'cancelled' : 'error';
            if (error instanceof Error) {
              this.errorType = error.name;
              this.errorMessage = error.message;
            } else {
              this.errorType = 'UnknownError';
              this.errorMessage = String(error);
            }
            return response;
          } finally {
            await this.tracker.flush();
            enrich({
              ...(inputKeys ? { input_keys: inputKeys } : {}),
              ...(inputSizeBytes !== undefined ? { input_size_bytes: inputSizeBytes } : {}),
              ...(resultSizeBytes !== undefined ? { result_size_bytes: resultSizeBytes } : {}),
              outcome: this.outcome,
              ...(this.errorType ? { error_type: this.errorType } : {}),
              ...(this.errorMessage ? { error_message: this.errorMessage } : {}),
              memory_delta_mb: (process.memoryUsage().rss - this.startMemory) / 1024 / 1024,
              tool_progress_ticks: this.tracker.tickCount,
              progress_notifications_emitted: this.tracker.emittedCount,
            });
          }
        },
      );
    } finally {
      if ((this.toolCtx.pathGuard as unknown) != null) {
        delete this.toolCtx.pathGuard.onAccessDenied;
      }
    }
  }
}

async function executeTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
  ctx: ToolCtx,
  deps: ToolDeps,
  args: z.infer<I>,
): Promise<CallToolResult> {
  const executor = new ToolExecutor<I, O>(def.name, ctx, def, args);
  return executor.execute(args, deps);
}

function createServerToolHandler<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
  deps: ToolDeps,
): (args: z.infer<I>, ctx: ServerContext) => Promise<CallToolResult> {
  return async (args, ctx) => executeTool(def, toToolCtx(ctx, deps), deps, args);
}

// ============ Tool Definition ============

// WHY THIS EXISTS: The SDK exports fromJsonSchema(rawSchema) which creates a
// StandardSchemaWithJSON from a plain JSON Schema, but it validates at runtime using
// CfWorkerJsonSchemaValidator instead of Zod. We need Zod validation (for structured
// error messages) while serving the augmented JSON Schema (with head/tail/offset mutex
// constraints added by inputSchemaAugment) to clients. This function keeps Zod's
// ~standard.validate intact while replacing ~standard.jsonSchema with the augmented
// schema. Remove when the SDK supports separate validate/publication schemas in
// registerTool, or when inputSchemaAugment constraints can be expressed in Zod directly.
function withJsonSchema<T extends z.ZodType>(
  schema: T,
  precomputedJsonSchema: Record<string, unknown>,
  io: 'input' | 'output',
): StandardSchemaWithJSON<z.infer<T>, z.infer<T>> {
  const standard = (schema as unknown as { '~standard': Record<string, unknown> })['~standard'];
  const compute = (options: { target: string }): Record<string, unknown> =>
    options.target === 'draft-2020-12'
      ? precomputedJsonSchema
      : z.toJSONSchema(schema, { target: options.target as never, io });
  return {
    '~standard': {
      ...standard,
      jsonSchema: {
        input: compute,
        output: compute,
      },
    },
  } as StandardSchemaWithJSON<z.infer<T>, z.infer<T>>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): DefinedTool {
  const baseInputJsonSchema = z.toJSONSchema(def.input, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
  const inputJsonSchema: Record<string, unknown> = def.inputSchemaAugment
    ? { ...def.inputSchemaAugment(baseInputJsonSchema) }
    : baseInputJsonSchema;
  const outputJsonSchema = z.toJSONSchema(def.output, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;

  const inputSchemaWithJson = withJsonSchema(def.input, inputJsonSchema, 'input');
  const outputSchemaWithJson = withJsonSchema(def.output, outputJsonSchema, 'output');

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
    _def: def,

    register(deps: ToolDeps) {
      const toolDefShape = {
        title: def.title,
        description: def.description,
        inputSchema: inputSchemaWithJson,
        outputSchema: outputSchemaWithJson,
        annotations: def.annotations,
      };

      const serverCtxHandler = createServerToolHandler(def, deps);

      deps.server.registerTool(def.name, toolDefShape, serverCtxHandler);
    },
  };

  return tool;
}

// ============ Batch Execution ============

type BatchInput<TOverride> =
  | { path: string }
  | { paths: string[] }
  | { files: ({ path: string } & TOverride)[] };

interface RunOverPathsOptions {
  defaultErrorCode?: ErrorCode;
  concurrency?: number;
}

function normalizeBatchItems<TOverride>(
  args: BatchInput<TOverride>,
): { path: string; override?: TOverride }[] {
  if ('path' in args) {
    return [{ path: args.path }];
  }
  if ('paths' in args) {
    return args.paths.map((path) => ({ path }));
  }
  if ('files' in args) {
    return args.files.map(({ path, ...rest }) => ({
      path,
      override: rest as unknown as TOverride,
    }));
  }
  // For invalid input not matching the discriminated union
  return [];
}

export async function runOverPaths<TOverride, TPerPath>(
  args: BatchInput<TOverride>,
  ctx: ToolCtx,
  perPath: (item: { path: string; override?: TOverride }, ctx: ToolCtx) => Promise<TPerPath>,
  options?: RunOverPathsOptions,
): Promise<BatchResult<TPerPath>> {
  const items = normalizeBatchItems(args);
  if (items.length === 0) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      "runOverPaths: at least one of 'path', 'paths', or 'files' must be provided",
    );
  }

  const defaultErrorCode = options?.defaultErrorCode ?? ErrorCode.UNKNOWN;
  const concurrency = options?.concurrency ?? PARALLEL_CONCURRENCY;

  const total = items.length;
  let completed = 0;
  const results: PerPathResult<TPerPath>[] = new Array<PerPathResult<TPerPath>>(total);

  const tick = (): void => {
    completed += 1;
    ctx.onProgress?.({ current: completed, total });
  };

  await processInParallel<
    { item: { path: string; override?: TOverride }; index: number },
    undefined
  >(
    items.map((item, index) => ({ item, index })),
    async ({ item, index }) => {
      try {
        const value = await perPath(item, ctx);
        results[index] = { path: item.path, value };
      } catch (error: unknown) {
        const problem = Problem.fromUnknown(error, defaultErrorCode, item.path);
        const perPathError: PerPathError = {
          code: problem.code,
          message: problem.message,
          ...(problem.path !== undefined ? { path: problem.path } : {}),
          ...(problem.suggestion !== undefined ? { suggestion: problem.suggestion } : {}),
        };
        results[index] = { path: item.path, error: perPathError };
      } finally {
        tick();
      }
      return undefined;
    },
    concurrency,
    ctx.signal,
  );

  let succeeded = 0;
  for (const result of results) {
    if (!('error' in result)) succeeded += 1;
  }

  return {
    results,
    summary: { total, succeeded, failed: total - succeeded },
  };
}
