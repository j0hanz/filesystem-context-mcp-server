// src/tools/define.ts
// Tool definition engine for registering tools with MCP server
import type {
  CallToolResult,
  ContentBlock,
  ElicitRequestFormParams,
  ElicitResult,
  LoggingLevel,
  McpServer,
  Tool,
  ToolAnnotations,
  ToolExecution,
} from '@modelcontextprotocol/server';

import type { z } from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { Logger, ProgressSession } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { toMcpSchema } from '../schema.js';
import { buildToolErrorResponse } from './_helpers.js';
import type { ToolContext } from './_helpers.js';

// Minimal duck-typed interface for the task orchestrator.
// Avoids a circular import by not referencing TaskOrchestrator directly.
interface OrchestratorLike {
  wrapToolTask(
    handler: (args: unknown, ctx: ToolContext) => Promise<unknown>,
    options: { toolName: string },
  ): unknown;
}

// Local type adapter for experimental.tasks. The published SDK's typings for
// `experimental.tasks.registerToolTask` are incomplete in 2.0.0-alpha.2; the
// interface and `getExperimentalTasks` helper isolate the necessary cast in
// one spot so the rest of this file stays cast-free. Delete once the SDK
// publishes proper typings.
interface ExperimentalTasksApi {
  registerToolTask(name: string, def: unknown, handler: unknown): void;
}

function getExperimentalTasks(server: McpServer): ExperimentalTasksApi {
  // Cast from untyped experimental API to our locally-defined interface.
  // The SDK doesn't export types for experimental.tasks, so this unsafe cast
  // is unavoidable until the SDK publishes proper typings.
  const typedTasks = server.experimental.tasks as unknown as ExperimentalTasksApi;
  return typedTasks;
}

// ============ Type Definitions ============

export interface ToolCtx {
  readonly signal: AbortSignal;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
  readonly log?: (level: LoggingLevel, data: unknown, logger?: string) => void;
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

export type RunResult<T> = T | { content: ContentBlock[]; structuredContent: T };

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
        if (!deps.isInitialized()) {
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

        const label = def.progressLabel ? def.progressLabel(parsedArgs) : def.name;
        const progressSession = new ProgressSession({ label, sinks: [], dynamicRateLimit: true });

        const toolCtx: ToolCtx = {
          signal,
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
          onProgress: (p) => {
            progressSession.set(p);
          },
          ...(ctx.elicitInput ? { elicitInput: ctx.elicitInput } : {}),
        };

        try {
          const result = await def.run(parsedArgs, toolCtx);
          progressSession.complete(label);
          if (
            result !== null &&
            typeof result === 'object' &&
            'content' in result &&
            'structuredContent' in result &&
            Array.isArray((result as { content: unknown }).content)
          ) {
            const wrapped = result as { content: ContentBlock[]; structuredContent: unknown };
            return {
              content: wrapped.content,
              structuredContent: wrapped.structuredContent as Record<string, unknown>,
            };
          }
          return {
            content: [{ type: 'text' as const, text: JSON.stringify(result) }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (error: unknown) {
          progressSession.fail(error, label);
          return buildToolErrorResponse(error, def.defaultErrorCode ?? ErrorCode.UNKNOWN);
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
        getExperimentalTasks(deps.server).registerToolTask(
          def.name,
          { ...toolDefShape, execution: tool.execution },
          taskHandler,
        );
      } else {
        // Regular tool: adapt ServerContext → ToolContext inline.
        const serverCtxHandler = async (
          args: unknown,
          extra: {
            mcpReq: {
              signal: AbortSignal;
              log: (level: LoggingLevel, data: unknown, logger?: string) => Promise<void>;
              elicitInput: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
            };
          },
        ): Promise<CallToolResult> =>
          coreHandler(args, {
            signal: extra.mcpReq.signal,
            log: async (level: LoggingLevel, data: unknown, logger?: string) =>
              extra.mcpReq.log(level, data, logger),
            elicitInput: (params: ElicitRequestFormParams) => extra.mcpReq.elicitInput(params),
          });
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
