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
import { ErrorCode, Problem } from '../core/errors.js';
import type { ProgressCtx } from '../core/fmt.js';
import { plainMessage } from '../core/fmt.js';
import { GuardedFileSystem } from '../core/fs.js';
import {
  Logger,
  ProgressSession,
  StderrProgressSink,
  withTelemetry,
} from '../core/observability.js';
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
  readonly fs: GuardedFileSystem;
  readonly resourceStore: ResourceStore | undefined;
  readonly log?: (level: LoggingLevel, data: unknown, logger?: string) => void;
  readonly sendNotification?: (notification: Notification) => Promise<void>;
  readonly onProgress?: (params: { current: number; total?: number }) => void;
  readonly elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
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
  register(deps: ToolDeps): void;
}

// ============ Context Builder ============

function toToolCtx(
  ctx: ServerContext | undefined,
  deps: Pick<ToolDeps, 'pathGuard' | 'resourceStore'>,
): ToolCtx {
  if (!ctx) {
    const signal = new AbortController().signal;
    return {
      signal,
      pathGuard: deps.pathGuard,
      fs: new GuardedFileSystem(deps.pathGuard),
      resourceStore: deps.resourceStore,
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
  } catch {
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
  } catch {
    return { inputKeys };
  }
}

function tryMeasureBytes(value: unknown): number | undefined {
  try {
    return Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return undefined;
  }
}

function buildSuccessResponse<O>(result: RunResult<O>): CallToolResult {
  const text = result.text ?? JSON.stringify(result.structured);
  const content: ContentBlock[] = [{ type: 'text' as const, text }, ...(result.resources ?? [])];
  return {
    content,
    structuredContent: result.structured as Record<string, unknown>,
  };
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

function extractTracingMeta(meta: (RequestMeta & TracingMeta) | undefined): Record<string, string> {
  if (meta && 'traceparent' in meta && typeof meta['traceparent'] === 'string') {
    return { traceparent: meta['traceparent'] };
  }
  return {};
}

// ============ Progress Tracking ============

class ProgressTracker {
  tickCount = 0;
  emittedCount = 0;

  private pending = new Set<Promise<void>>();
  private closed = false;
  private cursor = 0;
  private readonly toolName: string;
  private readonly ctx: ProgressCtx;
  private readonly token: string | number | undefined;
  private readonly notify: ((n: Notification) => Promise<void>) | undefined;
  private readonly stderrSink: StderrProgressSink;
  private readonly session: ProgressSession;

  constructor(
    toolName: string,
    ctx: ProgressCtx,
    token: string | number | undefined,
    notify: ((n: Notification) => Promise<void>) | undefined,
  ) {
    this.toolName = toolName;
    this.ctx = ctx;
    this.token = token;
    this.notify = notify;
    this.stderrSink = new StderrProgressSink(ctx);
    this.session = new ProgressSession({
      label: ctx.label,
      sinks: [this.stderrSink],
      dynamicRateLimit: true,
    });
  }

  get progressCtx(): ProgressCtx {
    return this.ctx;
  }

  private async emit(params: { current: number; total?: number; message?: string }): Promise<void> {
    if (!this.notify || this.token === undefined) return;
    const notificationParams: ProgressNotificationParams = {
      progressToken: this.token,
      progress: params.current,
      ...(params.total !== undefined ? { total: params.total } : {}),
      ...(params.message !== undefined ? { message: params.message } : {}),
    };
    try {
      await this.notify({
        method: 'notifications/progress',
        params: notificationParams,
      });
      this.emittedCount++;
    } catch (error) {
      reportDetachedError(this.toolName, 'progressNotification', error);
    }
  }

  private track(params: { current: number; total?: number; message?: string }): void {
    if (params.current > this.cursor) this.cursor = params.current;
    const promise = this.emit(params);
    this.pending.add(promise);
    runDetached(
      this.toolName,
      promise.finally(() => {
        this.pending.delete(promise);
      }),
      'progressNotification',
    );
  }

  start(): void {
    this.track({ current: 0, message: plainMessage('start', this.ctx) });
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
    this.track({ ...p, message });
  }

  updateStderrError(errMsg: string): void {
    this.stderrSink.updateCtx({ error: errMsg });
  }

  async closeWithDone(message: string): Promise<void> {
    this.closed = true;
    this.session.complete(message);
    const current = this.cursor + 1;
    await this.emit({ current, total: current, message });
  }

  async closeWithFail(error: unknown, message: string): Promise<void> {
    this.closed = true;
    this.session.fail(error, message);
    const current = this.cursor + 1;
    await this.emit({ current, total: current, message });
  }

  async flush(): Promise<void> {
    if (this.pending.size > 0) {
      await Promise.allSettled([...this.pending]);
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

  async execute(args: unknown, deps: ToolDeps): Promise<CallToolResult> {
    if (!deps.isInitialized()) {
      return {
        isError: true as const,
        content: [{ type: 'text' as const, text: 'Server not initialized. Roots unavailable.' }],
      };
    }

    return withTelemetry(
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
  }
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

interface BatchInput<TOverride> {
  path?: string | undefined;
  paths?: string[] | undefined;
  files?: ({ path: string } & TOverride)[] | undefined;
}

interface RunOverPathsOptions {
  defaultErrorCode?: ErrorCode;
  concurrency?: number;
}

function normalizeBatchItems<TOverride>(
  args: BatchInput<TOverride>,
): { path: string; override?: TOverride }[] {
  if (args.path !== undefined) {
    return [{ path: args.path }];
  }
  if (args.paths !== undefined) {
    return args.paths.map((path) => ({ path }));
  }
  if (args.files !== undefined) {
    return args.files.map(({ path, ...rest }) => ({
      path,
      override: rest as unknown as TOverride,
    }));
  }
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
    throw new Error("runOverPaths: at least one of 'path', 'paths', or 'files' must be provided");
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
    if (result.error === undefined) succeeded += 1;
  }

  return {
    results,
    summary: { total, succeeded, failed: total - succeeded },
  };
}
