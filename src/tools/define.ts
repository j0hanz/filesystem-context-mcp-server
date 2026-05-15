// src/tools/define.ts
// Tool definition engine for registering tools with MCP server
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

import {
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  getSuggestion,
} from '../core/errors.js';
import type { ProgressCtx } from '../core/fmt.js';
import { plainMessage } from '../core/fmt.js';
import {
  emitWideEvent,
  Logger,
  ProgressSession,
  StderrProgressSink,
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
      const reportDetachedError = (context: string, error: unknown): void => {
        const message = error instanceof Error ? error.message : String(error);
        Logger.emit('warning', `${def.name}: ${context} failed: ${message}`);
      };

      const runDetached = (work: Promise<unknown>, context: string): void => {
        void work.catch((error: unknown) => {
          reportDetachedError(context, error);
        });
      };

      // Core handler: accepts ToolContext (compatible with both task-orchestrator and
      // regular ServerContext call paths). signal is optional in ToolContext; fall back
      // to an already-aborted signal when absent so ToolCtx.signal stays non-optional.
      const coreHandler = async (args: unknown, ctx: ToolContext): Promise<CallToolResult> => {
        const executionId = randomUUID();
        const startTime = performance.now();
        const startMemory = process.memoryUsage().rss;

        let inputKeys: string[] | undefined;
        let inputSizeBytes: number | undefined;
        if (args && typeof args === 'object') {
          inputKeys = Object.keys(args);
          try {
            inputSizeBytes = Buffer.byteLength(JSON.stringify(args), 'utf8');
          } catch {
            // Ignore serialization error
          }
        }

        let progressUpdates = 0;
        let progressNotificationsEmitted = 0;
        const pendingProgressNotifications = new Set<Promise<void>>();
        let progressClosed = false;
        let outcome: 'success' | 'error' | 'cancelled' = 'success';
        let errorType: string | undefined;
        let errorMessage: string | undefined;
        let resultSizeBytes: number | undefined;

        try {
          if (!deps.isInitialized()) {
            outcome = 'error';
            errorMessage = 'Server not initialized. Roots unavailable.';

            return {
              isError: true as const,
              content: [
                { type: 'text' as const, text: 'Server not initialized. Roots unavailable.' },
              ],
            };
          }

          // Input validation already performed by the MCP SDK via the standard schema
          const parsedArgs = args as z.infer<typeof def.input>;

          const baseSignal = ctx.signal ?? new AbortController().signal;
          const timeoutSignal = def.timeoutMs ? AbortSignal.timeout(def.timeoutMs) : undefined;
          const signal = timeoutSignal ? AbortSignal.any([baseSignal, timeoutSignal]) : baseSignal;

          const progressCtx: ProgressCtx = def.progress
            ? def.progress(parsedArgs)
            : { label: def.title };
          const stderrSink = new StderrProgressSink(progressCtx);

          const progressSession = new ProgressSession({
            label: progressCtx.label,
            sinks: [stderrSink],
            dynamicRateLimit: true,
          });

          const progressToken = ctx._meta?.progressToken;

          const emitProgressNotification = async (params: {
            current: number;
            total?: number;
            message?: string;
          }): Promise<void> => {
            if (!ctx.sendNotification || progressToken === undefined) return;
            try {
              await ctx.sendNotification({
                method: 'notifications/progress',
                params: {
                  progressToken,
                  progress: params.current,
                  ...(params.total !== undefined ? { total: params.total } : {}),
                  ...(params.message !== undefined ? { message: params.message } : {}),
                },
              });
              progressNotificationsEmitted++;
            } catch (error) {
              reportDetachedError('progressNotification', error);
            }
          };

          let progressCursor = 0;

          const runTrackedProgressNotification = (params: {
            current: number;
            total?: number;
            message?: string;
          }): void => {
            if (params.current > progressCursor) progressCursor = params.current;
            const promise = emitProgressNotification(params);
            pendingProgressNotifications.add(promise);
            runDetached(
              promise.finally(() => {
                pendingProgressNotifications.delete(promise);
              }),
              'progressNotification',
            );
          };

          const toolCtx: ToolCtx = {
            signal,
            ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
            ...(ctx._meta ? { _meta: ctx._meta } : {}),
            pathGuard: deps.pathGuard,
            resourceStore: deps.resourceStore,
            ...(ctx.log
              ? {
                  log: ((ctxLog) => (level, data, logger) => {
                    const msg = typeof data === 'string' ? data : String(data);
                    Logger.emit(level, msg);
                    runDetached(ctxLog(level, data, logger), 'log');
                  })(ctx.log),
                }
              : {}),
            ...(ctx.sendNotification ? { sendNotification: ctx.sendNotification } : {}),
            onProgress: (p) => {
              if (progressClosed) return;
              progressUpdates++;
              const tickCtx: ProgressCtx = {
                ...progressCtx,
                current: p.current,
                ...(p.total !== undefined ? { total: p.total } : {}),
              };
              const tickMessage = plainMessage('tick', tickCtx);
              progressSession.set({ ...p, message: tickMessage });
              runTrackedProgressNotification({ ...p, message: tickMessage });
            },
            ...(ctx.elicitInput ? { elicitInput: ctx.elicitInput } : {}),
          };

          // Emit start progress so the client shows the tool label immediately.
          runTrackedProgressNotification({
            current: 0,
            message: plainMessage('start', progressCtx),
          });

          try {
            const result = await def.run(parsedArgs, toolCtx);
            let doneCtx = progressCtx;
            if (def.progressDone) {
              try {
                const extra = def.progressDone(parsedArgs, result.structured);
                doneCtx = { ...progressCtx, ...extra };
                stderrSink.updateCtx(extra);
              } catch {
                // ignore progressDone failures — best effort
              }
            }
            const doneMessage = plainMessage('done', doneCtx);
            progressClosed = true;
            progressSession.complete(doneMessage);
            // Final notification: current > all previous ticks so clients see monotonic progress.
            const doneCurrent = progressCursor + 1;
            await emitProgressNotification({
              current: doneCurrent,
              total: doneCurrent,
              message: doneMessage,
            });
            outcome = signal.aborted ? 'cancelled' : 'success';

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
            const errMsg = error instanceof Error ? error.message : String(error);
            stderrSink.updateCtx({ error: errMsg });
            const failMessage = plainMessage('fail', { ...progressCtx, error: errMsg });
            progressClosed = true;
            progressSession.fail(error, failMessage);
            const failCurrent = progressCursor + 1;
            await emitProgressNotification({
              current: failCurrent,
              total: failCurrent,
              message: failMessage,
            });
            outcome = signal.aborted ? 'cancelled' : 'error';
            if (error instanceof Error) {
              errorType = error.name;
              errorMessage = error.message;
            } else {
              errorType = 'UnknownError';
              errorMessage = String(error);
            }
            const defaultCode = def.defaultErrorCode ?? ErrorCode.UNKNOWN;
            const detailed = createDetailedError(error);
            const resolvedCode =
              detailed.code === ErrorCode.UNKNOWN || detailed.code === ErrorCode.IO_ERROR
                ? defaultCode
                : detailed.code;
            const defaultSuggestion =
              resolvedCode !== detailed.code ? getSuggestion(resolvedCode) : undefined;
            const errorText = formatDetailedError({
              ...detailed,
              code: resolvedCode,
              ...(defaultSuggestion !== undefined ? { suggestion: defaultSuggestion } : {}),
            });
            const errorResult = {
              content: [{ type: 'text' as const, text: errorText }],
              isError: true as const,
              errorCode: resolvedCode,
            };
            return errorResult;
          }
        } finally {
          if (pendingProgressNotifications.size > 0) {
            await Promise.allSettled([...pendingProgressNotifications]);
          }
          const level = outcome === 'error' ? 'error' : 'info';
          emitWideEvent(level, {
            event: 'tool_execution',
            tool_name: def.name,
            execution_id: executionId,
            ...(ctx.sessionId ? { session_id: ctx.sessionId } : {}),
            ...(ctx._meta &&
            'traceparent' in ctx._meta &&
            typeof ctx._meta['traceparent'] === 'string'
              ? { traceparent: ctx._meta['traceparent'] }
              : {}),
            ...(inputKeys ? { input_keys: inputKeys } : {}),
            ...(inputSizeBytes !== undefined ? { input_size_bytes: inputSizeBytes } : {}),
            ...(resultSizeBytes !== undefined ? { result_size_bytes: resultSizeBytes } : {}),
            outcome,
            ...(errorType ? { error_type: errorType } : {}),
            ...(errorMessage ? { error_message: errorMessage } : {}),
            duration_ms: performance.now() - startTime,
            memory_delta_mb: (process.memoryUsage().rss - startMemory) / 1024 / 1024,
            tool_progress_ticks: progressUpdates,
            progress_notifications_emitted: progressNotificationsEmitted,
          });
        }
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
