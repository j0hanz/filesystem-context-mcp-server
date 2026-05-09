// src/tools/define.ts
// Tool definition engine for registering tools with MCP server
import type {
  ElicitRequestFormParams,
  ElicitResult,
  LoggingLevel,
  McpServer,
  ServerContext,
} from '@modelcontextprotocol/server';

import type { z } from 'zod/v4';

import { ErrorCode, formatUnknownErrorMessage, McpError } from '../core/errors.js';
import { Logger, ProgressSession } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { toMcpSchema } from '../schema.js';

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
  readonly orchestrator?: unknown;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
}

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
  readonly run: (args: z.infer<I>, ctx: ToolCtx) => Promise<z.infer<O>>;
  readonly nuances?: readonly string[];
  readonly gotchas?: readonly string[];
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
  const inputSchema = toMcpSchema(def.input);
  const outputSchema = toMcpSchema(def.output);
  const taskMode = def.task ?? 'forbidden';

  const tool: DefinedTool = {
    name: def.name,
    title: def.title,
    description: def.description,
    annotations: def.annotations,
    task: taskMode,
    nuances: def.nuances ?? [],
    gotchas: def.gotchas ?? [],
    inputJsonSchema: (
      inputSchema as unknown as { jsonSchema: { input(): object } }
    ).jsonSchema.input(),
    outputJsonSchema: (
      outputSchema as unknown as { jsonSchema: { output(): object } }
    ).jsonSchema.output(),

    register(deps: ToolDeps) {
      const handler = async (args: unknown, extra: ServerContext) => {
        if (!deps.isInitialized()) {
          return {
            isError: true,
            content: [{ type: 'text', text: 'Server not initialized. Roots unavailable.' }],
          };
        }

        // Parse and validate input
        const parsed = def.input.safeParse(args);
        if (!parsed.success) {
          return {
            isError: true,
            content: [{ type: 'text', text: `Invalid input: ${parsed.error.message}` }],
          };
        }
        const parsedArgs = parsed.data;

        // Compose abort signals: client signal + optional timeout
        const timeoutSignal = def.timeoutMs ? AbortSignal.timeout(def.timeoutMs) : undefined;
        const signal = timeoutSignal
          ? AbortSignal.any([extra.mcpReq.signal, timeoutSignal])
          : extra.mcpReq.signal;

        // Progress session for lifecycle tracking (start/complete/fail)
        const label = def.progressLabel ? def.progressLabel(parsedArgs) : def.name;
        const progressSession = new ProgressSession({ label, sinks: [], dynamicRateLimit: true });

        const ctx: ToolCtx = {
          signal,
          pathGuard: deps.pathGuard,
          resourceStore: deps.resourceStore,
          log: (level, data, logger) => {
            const msg = typeof data === 'string' ? data : String(data);
            Logger.emit(level, msg);
            void extra.mcpReq.log(level, data, logger);
          },
          onProgress: ({ message }) => {
            progressSession.step(message ?? label);
          },
          elicitInput: (params) => extra.mcpReq.elicitInput(params),
        };

        try {
          const result = await def.run(parsedArgs, ctx);
          progressSession.complete(label);
          return {
            content: [{ type: 'text', text: JSON.stringify(result) }],
            structuredContent: result,
          };
        } catch (error: unknown) {
          progressSession.fail(error, label);
          if (error instanceof McpError) {
            return {
              isError: true,
              content: [{ type: 'text', text: error.message }],
              _meta: { errorCode: error.code },
            };
          }
          const code = def.defaultErrorCode ?? ErrorCode.UNKNOWN;
          const message = formatUnknownErrorMessage(error);
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
            _meta: { errorCode: code },
          };
        }
      };

      // `as never`: bridges StandardSchema/JSON-Schema type mismatch at registration boundary.
      // The runtime shape is verified by the SDK's own validation.
      deps.server.registerTool(
        def.name,
        {
          title: def.title,
          description: def.description,
          inputSchema,
          outputSchema,
          annotations: ANNOTATION_HINTS[def.annotations],
        } as never,
        handler as never,
      );
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
