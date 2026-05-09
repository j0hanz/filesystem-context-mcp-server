// src/tools/define.ts
// Tool definition engine for registering tools with MCP server
import type { McpServer } from '@modelcontextprotocol/server';

import type { z } from 'zod';

import { ErrorCode, formatUnknownErrorMessage, McpError } from '../core/errors.js';
import type { Logger } from '../core/observability.js';
import { ProgressSession } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import { toMcpSchema } from '../schema.js';

// ============ Type Definitions ============

type Annotation = 'readOnly' | 'idempotentWrite' | 'destructiveWrite';
type TaskMode = 'forbidden' | 'optional' | 'required';

interface ProgressTick {
  current: number;
  total?: number;
  message?: string;
}

type ProgressFn = (tick: ProgressTick) => void;

interface ToolCtx {
  readonly signal: AbortSignal;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore;
  readonly log: typeof Logger;
  readonly progress: ProgressFn;
}

interface ToolDeps {
  readonly isInitialized: () => boolean;
  readonly server: McpServer;
  readonly orchestrator?: unknown;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore;
  readonly log: typeof Logger;
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
  readonly defaultErrorCode?: string;
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
  readonly inputJsonSchema: unknown;
  readonly outputJsonSchema: unknown;
  register(deps: ToolDeps): void;
}

// ============ Utilities ============

/**
 * Compose multiple AbortSignals into a single AbortSignal that aborts when any input aborts.
 */
function composeAbortSignals(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const defined = signals.filter((s): s is AbortSignal => s !== undefined);

  if (defined.length === 0) {
    return new AbortController().signal;
  }

  if (defined.length === 1) {
    const [first] = defined;
    return first ?? new AbortController().signal;
  }

  // Multiple signals: use AbortSignal.any() if available (Node.js 20.3+), else fallback
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any(defined);
  }

  // Fallback for older Node.js: create an AbortController that mirrors any input
  const controller = new AbortController();
  for (const signal of defined) {
    signal.addEventListener(
      'abort',
      () => {
        controller.abort(signal.reason);
      },
      { once: true },
    );
  }
  return controller.signal;
}

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
    // Store the schemas themselves - they contain the JSON schema data
    inputJsonSchema: inputSchema,
    outputJsonSchema: outputSchema,

    register(deps: ToolDeps) {
      const handler = async (args: unknown, extra: unknown) => {
        if (!deps.isInitialized()) {
          throw new McpError(
            { code: ErrorCode.UNKNOWN, message: 'Server not initialized' },
            undefined,
          );
        }

        // Parse and validate input
        let parsedArgs: z.infer<I>;
        try {
          parsedArgs = def.input.parse(args);
        } catch (error) {
          const message = `Invalid input: ${formatUnknownErrorMessage(error)}`;
          return {
            isError: true,
            content: [{ type: 'text', text: message }],
          };
        }

        // Compose abort signals: client signal + timeout
        const extraSignal =
          typeof extra === 'object' && extra !== null && 'signal' in extra
            ? (extra as { signal?: AbortSignal }).signal
            : undefined;

        const timeoutSignal = def.timeoutMs ? AbortSignal.timeout(def.timeoutMs) : undefined;

        const signal = composeAbortSignals(extraSignal, timeoutSignal);

        // Create progress session
        let progressSession: ProgressSession | undefined;
        if (
          typeof extra === 'object' &&
          extra !== null &&
          'onProgress' in extra &&
          typeof (extra as { onProgress?: unknown }).onProgress === 'function'
        ) {
          const label = def.progressLabel ? def.progressLabel(parsedArgs) : def.name;
          progressSession = new ProgressSession({
            label,
            sinks: [],
            now: Date.now,
          });
        }

        const ctx: ToolCtx = {
          signal,
          pathGuard: deps.pathGuard,
          resourceStore: deps.resourceStore,
          log: deps.log,
          progress: (tick: ProgressTick) => {
            if (progressSession) {
              progressSession.set({
                current: tick.current,
                ...(tick.total !== undefined ? { total: tick.total } : {}),
                ...(tick.message !== undefined ? { message: tick.message } : {}),
              });
            }
          },
        };

        try {
          const result = await def.run(parsedArgs, ctx);

          // Validate output
          let validatedResult: z.infer<O>;
          try {
            validatedResult = def.output.parse(result);
          } catch (error) {
            const message = `Invalid output: ${formatUnknownErrorMessage(error)}`;
            return {
              isError: true,
              content: [{ type: 'text', text: message }],
            };
          }

          progressSession?.complete(def.name);

          return {
            content: [{ type: 'text', text: JSON.stringify(validatedResult) }],
            ...(validatedResult ? { structuredContent: validatedResult } : {}),
          };
        } catch (error) {
          progressSession?.fail(error);

          const code =
            error instanceof McpError ? error.code : (def.defaultErrorCode ?? ErrorCode.UNKNOWN);
          const message =
            error instanceof McpError ? error.message : formatUnknownErrorMessage(error);

          return {
            isError: true,
            content: [{ type: 'text', text: message }],
            _meta: { errorCode: code },
          };
        }
      };

      if (taskMode !== 'forbidden' && deps.orchestrator) {
        // Register as task if orchestrator is available
        // Use `as never` to bridge StandardSchema/JSON-Schema type mismatch
        deps.server.experimental.tasks.registerToolTask(
          def.name,
          { ...def, inputSchema, outputSchema } as never,
          handler as never,
        );
      } else {
        // Register as standard tool
        // Use `as never` to bridge StandardSchema/JSON-Schema type mismatch
        deps.server.registerTool(def.name, inputSchema as never, handler as never);
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
