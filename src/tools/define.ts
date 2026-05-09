// src/tools/define.ts
// Tool definition engine for registering tools with MCP server
import type {
  ContentBlock,
  ElicitRequestFormParams,
  ElicitResult,
  LoggingLevel,
  McpServer,
} from '@modelcontextprotocol/server';

import type { z } from 'zod/v4';

import { toToolJsonSchema } from '../schemas/json-schema.js';

import { ErrorCode } from '../core/errors.js';
import { Logger, ProgressSession } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { buildToolErrorResponse } from './shared.js';
import type { ToolContext } from './shared.js';

// Minimal duck-typed interface for the task orchestrator.
// Avoids a circular import by not referencing TaskOrchestrator directly.
interface OrchestratorLike {
  wrapToolTask(
    handler: (args: unknown, ctx: ToolContext) => Promise<unknown>,
    options: { toolName: string },
  ): unknown;
}

// ============ Type Definitions ============

export type Annotation = 'readOnly' | 'idempotentWrite' | 'destructiveWrite';
export type TaskMode = 'forbidden' | 'optional' | 'required';

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
  readonly annotations: Annotation;
  readonly icons?: readonly unknown[];
  readonly task?: TaskMode;
  readonly timeoutMs?: number;
  readonly progressLabel?: (args: z.infer<I>) => string;
  readonly defaultErrorCode?: ErrorCode;
  readonly run: (args: z.infer<I>, ctx: ToolCtx) => Promise<RunResult<z.infer<O>>>;
  readonly nuances?: readonly string[];
  readonly gotchas?: readonly string[];
  readonly inputSchemaAugment?: (schema: Record<string, unknown>) => Record<string, unknown>;
}

export interface DefinedTool {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly annotations: Annotation;
  readonly task: TaskMode;
  readonly nuances: readonly string[];
  readonly gotchas: readonly string[];
  readonly inputJsonSchema: object;
  readonly outputJsonSchema: object;
  register(deps: ToolDeps): void;
}

// ============ Annotation → MCP hints ============

const ANNOTATION_HINTS = {
  readOnly: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  idempotentWrite: {
    readOnlyHint: false,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  destructiveWrite: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
} as const satisfies Record<Annotation, object>;

// ============ Tool Registry ============

export const ALL_TOOLS: DefinedTool[] = [];

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): DefinedTool {
  const inputSchema = toToolJsonSchema(def.input, def.inputSchemaAugment);
  const outputSchema = toToolJsonSchema(def.output);
  const taskMode = def.task ?? 'forbidden';

  const tool: DefinedTool = {
    name: def.name,
    title: def.title,
    description: def.description,
    annotations: def.annotations,
    task: taskMode,
    nuances: def.nuances ?? [],
    gotchas: def.gotchas ?? [],
    inputJsonSchema: (inputSchema as unknown as { jsonSchema: object }).jsonSchema,
    outputJsonSchema: (outputSchema as unknown as { jsonSchema: object }).jsonSchema,

    register(deps: ToolDeps) {
      // Core handler: accepts ToolContext (compatible with both task-orchestrator and
      // regular ServerContext call paths). signal is optional in ToolContext; fall back
      // to an already-aborted signal when absent so ToolCtx.signal stays non-optional.
      const coreHandler = async (args: unknown, ctx: ToolContext) => {
        if (!deps.isInitialized()) {
          return {
            isError: true as const,
            content: [{ type: 'text', text: 'Server not initialized. Roots unavailable.' }],
          };
        }

        const parsed = def.input.safeParse(args);
        if (!parsed.success) {
          return {
            isError: true as const,
            content: [{ type: 'text', text: `Invalid input: ${parsed.error.message}` }],
          };
        }
        const parsedArgs = parsed.data;

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
              structuredContent: wrapped.structuredContent,
            };
          }
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
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
        annotations: ANNOTATION_HINTS[def.annotations],
      };

      if (taskMode !== 'forbidden' && deps.orchestrator) {
        // Register as a task-capable tool via the orchestrator.
        // The orchestrator wraps coreHandler into a ToolTaskHandler (createTask / getTask / getTaskResult).
        const taskHandler = deps.orchestrator.wrapToolTask(coreHandler, { toolName: def.name });
        (
          deps.server.experimental.tasks as unknown as {
            registerToolTask: (name: string, def: unknown, handler: unknown) => void;
          }
        ).registerToolTask(
          def.name,
          { ...toolDefShape, execution: { taskSupport: taskMode } },
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
        ) =>
          coreHandler(args, {
            signal: extra.mcpReq.signal,
            log: async (level: LoggingLevel, data: unknown, logger?: string) =>
              extra.mcpReq.log(level, data, logger),
            elicitInput: (params: ElicitRequestFormParams) => extra.mcpReq.elicitInput(params),
          });
        deps.server.registerTool(def.name, toolDefShape as never, serverCtxHandler as never);
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
