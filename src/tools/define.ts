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
  StandardSchemaWithJSON,
  Tool,
  ToolAnnotations,
  ToolExecution,
  ToolTaskHandler,
} from '@modelcontextprotocol/server';
import { getDisplayName } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';

import type { z } from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { emitWideEvent, Logger, ProgressSession } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { toMcpSchema } from '../schema.js';
import { buildToolErrorResponse, toToolContext } from './_helpers.js';
import type { ToolContext } from './_helpers.js';

// Minimal duck-typed interface for the task orchestrator.
// Avoids a circular import by not referencing TaskOrchestrator directly.
interface OrchestratorLike {
  wrapToolTask(
    handler: (args: unknown, ctx: ToolContext) => Promise<unknown>,
    options: { toolName: string },
  ): ToolTaskHandler<StandardSchemaWithJSON>;
}

// ============ Type Definitions ============

export interface ToolCtx {
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly _meta?: ToolContext['_meta'];
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
  readonly log?: (level: LoggingLevel, data: unknown, logger?: string) => void;
  readonly sendNotification?: ToolContext['sendNotification'];
  readonly onProgress?: (params: { current: number; total?: number; message?: string }) => void;
  readonly elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
}

export interface ToolDeps {
  readonly isInitialized: () => boolean;
  readonly server: McpServer;
  readonly orchestrator?: OrchestratorLike;
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
  readonly progressLabel?: (args: z.infer<I>) => string;
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

          const label = def.progressLabel ? def.progressLabel(parsedArgs) : getDisplayName(def);
          const progressSession = new ProgressSession({ label, sinks: [], dynamicRateLimit: true });

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
                    void ctxLog(level, data, logger);
                  })(ctx.log),
                }
              : {}),
            ...(ctx.sendNotification ? { sendNotification: ctx.sendNotification } : {}),
            onProgress: (p) => {
              progressUpdates++;
              progressSession.set(p);
            },
            ...(ctx.elicitInput ? { elicitInput: ctx.elicitInput } : {}),
          };

          try {
            const result = await def.run(parsedArgs, toolCtx);
            progressSession.complete(label);
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
            progressSession.fail(error, label);
            outcome = signal.aborted ? 'cancelled' : 'error';
            if (error instanceof Error) {
              errorType = error.name;
              errorMessage = error.message;
            } else {
              errorType = 'UnknownError';
              errorMessage = String(error);
            }
            return buildToolErrorResponse(error, def.defaultErrorCode ?? ErrorCode.UNKNOWN);
          }
        } finally {
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
            progress_steps_emitted: progressUpdates,
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

      if (
        tool.execution?.taskSupport &&
        tool.execution.taskSupport !== 'forbidden' &&
        deps.orchestrator
      ) {
        // Register as a task-capable tool via the orchestrator.
        // The orchestrator wraps coreHandler into a ToolTaskHandler (createTask / getTask / getTaskResult).
        const taskHandler = deps.orchestrator.wrapToolTask(coreHandler, { toolName: def.name });
        // SDK's TaskToolExecution narrows taskSupport to 'optional' | 'required'.
        const taskExecution = { taskSupport: tool.execution.taskSupport };
        deps.server.experimental.tasks.registerToolTask(
          def.name,
          { ...toolDefShape, execution: taskExecution },
          taskHandler,
        );
      } else {
        // Regular tool: adapt ServerContext → ToolContext inline.
        const serverCtxHandler = async (
          args: unknown,
          ctx: ServerContext,
        ): Promise<CallToolResult> => coreHandler(args, toToolContext(ctx));
        deps.server.registerTool(def.name, toolDefShape, serverCtxHandler);
      }
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
