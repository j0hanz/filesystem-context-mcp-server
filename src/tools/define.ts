import type {
  CallToolResult,
  ContentBlock,
  ElicitRequestFormParams,
  ElicitResult,
  LoggingLevel,
  McpServer,
  ServerContext,
  Tool,
  ToolAnnotations,
  ToolExecution,
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
import { toToolContext } from './_helpers.js';
import type { ToolContext } from './_helpers.js';

// ============ Type Definitions ============

export interface ToolCtx {
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly _meta?: ToolContext['_meta'];
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
  readonly log?: (level: LoggingLevel, data: unknown, logger?: string) => void;
  readonly sendNotification?: ToolContext['sendNotification'];
  readonly onProgress?: (params: { current: number; total?: number }) => void;
  readonly elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
}

export interface ToolDeps {
  readonly isInitialized: () => boolean;
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
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

class ManagedExecution<I extends z.ZodType, O extends z.ZodType> {
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
  private readonly ctx: ToolContext;
  private readonly def: Pick<
    ToolDef<I, O>,
    'title' | 'progress' | 'progressDone' | 'defaultErrorCode'
  >;
  private readonly parsedArgs: z.infer<I> | undefined;

  constructor(
    toolName: string,
    ctx: ToolContext,
    def: Pick<ToolDef<I, O>, 'title' | 'progress' | 'progressDone' | 'defaultErrorCode'>,
    timeoutMs: number | undefined,
    parsedArgs?: z.infer<I>,
  ) {
    this.toolName = toolName;
    this.ctx = ctx;
    this.def = def;
    this.parsedArgs = parsedArgs;

    const baseSignal = ctx.signal ?? new AbortController().signal;
    const timeoutSignal = timeoutMs ? AbortSignal.timeout(timeoutMs) : undefined;
    this.signal = timeoutSignal ? AbortSignal.any([baseSignal, timeoutSignal]) : baseSignal;

    const progressCtx: ProgressCtx =
      def.progress && parsedArgs !== undefined ? def.progress(parsedArgs) : { label: def.title };
    this.stderrSink = new StderrProgressSink(progressCtx);

    this.progressSession = new ProgressSession({
      label: progressCtx.label,
      sinks: [this.stderrSink],
      dynamicRateLimit: true,
    });

    this.progressToken = ctx._meta?.progressToken;
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
    const progressCtx: ProgressCtx =
      this.def.progress && this.parsedArgs !== undefined
        ? this.def.progress(this.parsedArgs)
        : { label: this.def.title };
    this.runTrackedProgress({
      current: 0,
      message: plainMessage('start', progressCtx),
    });
  }

  tickProgress(p: { current: number; total?: number }): void {
    if (this.progressClosed) return;
    this.progressUpdates++;
    const progressCtx: ProgressCtx =
      this.def.progress && this.parsedArgs !== undefined
        ? this.def.progress(this.parsedArgs)
        : { label: this.def.title };
    const tickCtx: ProgressCtx = {
      ...progressCtx,
      current: p.current,
      ...(p.total !== undefined ? { total: p.total } : {}),
    };
    const tickMessage = plainMessage('tick', tickCtx);
    this.progressSession.set({ ...p, message: tickMessage });
    this.runTrackedProgress({ ...p, message: tickMessage });
  }

  async completeProgress(result: z.infer<O>): Promise<void> {
    const progressCtx: ProgressCtx =
      this.def.progress && this.parsedArgs !== undefined
        ? this.def.progress(this.parsedArgs)
        : { label: this.def.title };
    const doneCtx: ProgressCtx =
      this.def.progressDone && this.parsedArgs !== undefined
        ? { ...progressCtx, ...this.def.progressDone(this.parsedArgs, result) }
        : progressCtx;
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
    const progressCtx: ProgressCtx =
      this.def.progress && this.parsedArgs !== undefined
        ? this.def.progress(this.parsedArgs)
        : { label: this.def.title };
    const errMsg = error instanceof Error ? error.message : String(error);
    this.stderrSink.updateCtx({ error: errMsg });
    const failMessage = plainMessage('fail', { ...progressCtx, error: errMsg });
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
}

// ============ Tool Registry ============

export const ALL_TOOLS: DefinedTool[] = [];

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
      // Core handler: accepts ToolContext (compatible with both task-orchestrator and
      // regular ServerContext call paths). signal is optional in ToolContext; fall back
      // to an already-aborted signal when absent so ToolCtx.signal stays non-optional.
      const coreHandler = async (args: unknown, ctx: ToolContext): Promise<CallToolResult> => {
        return withTelemetry(
          {
            event: 'tool_execution',
            tool_name: def.name,
            ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
            ...(ctx._meta &&
            'traceparent' in ctx._meta &&
            typeof ctx._meta['traceparent'] === 'string'
              ? { traceparent: ctx._meta['traceparent'] }
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

            const parsedArgs = args as z.infer<typeof def.input>;
            const exec = new ManagedExecution<I, O>(def.name, ctx, def, def.timeoutMs, parsedArgs);

            enrich({ execution_id: exec.executionId });

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

              exec.startProgress();

              const toolCtx: ToolCtx = {
                signal: exec.signal,
                ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
                ...(ctx._meta ? { _meta: ctx._meta } : {}),
                pathGuard: deps.pathGuard,
                resourceStore: deps.resourceStore,
                ...(ctx.log
                  ? {
                      log: ((ctxLog) => (level, data, logger) => {
                        const msg = typeof data === 'string' ? data : String(data);
                        Logger.emit(level, msg);
                        runDetached(def.name, ctxLog(level, data, logger), 'log');
                      })(ctx.log),
                    }
                  : {}),
                ...(ctx.sendNotification ? { sendNotification: ctx.sendNotification } : {}),
                onProgress: (p) => {
                  exec.tickProgress(p);
                },
                ...(ctx.elicitInput ? { elicitInput: ctx.elicitInput } : {}),
              };

              const result = await def.run(parsedArgs, toolCtx);

              await exec.completeProgress(result.structured);

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
              return await exec.failProgress(error);
            } finally {
              await exec.flushNotifications();
              enrich({
                ...(inputKeys ? { input_keys: inputKeys } : {}),
                ...(inputSizeBytes !== undefined ? { input_size_bytes: inputSizeBytes } : {}),
                ...(resultSizeBytes !== undefined ? { result_size_bytes: resultSizeBytes } : {}),
                outcome: exec.outcome,
                ...(exec.errorType ? { error_type: exec.errorType } : {}),
                ...(exec.errorMessage ? { error_message: exec.errorMessage } : {}),
                memory_delta_mb: (process.memoryUsage().rss - exec.startMemory) / 1024 / 1024,
                tool_progress_ticks: exec.progressUpdates,
                progress_notifications_emitted: exec.progressNotificationsEmitted,
              });
            }
          },
        );
      };

      // `as never`: bridges StandardSchema/JSON-Schema type mismatch at registration boundary.
      const toolDefShape = {
        title: def.title,
        description: def.description,
        inputSchema,
        outputSchema,
        annotations: def.annotations,
      };

      const serverCtxHandler = async (args: unknown, ctx: ServerContext): Promise<CallToolResult> =>
        coreHandler(args, toToolContext(ctx));
      deps.server.registerTool(def.name, toolDefShape, serverCtxHandler);
    },
  };

  ALL_TOOLS.push(tool);
  return tool;
}

export function registerAllTools(deps: ToolDeps): void {
  for (const tool of ALL_TOOLS) {
    tool.register(deps);
  }
}
