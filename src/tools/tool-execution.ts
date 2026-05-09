import type {
  McpServer,
  ServerContext,
  StandardSchemaWithJSON,
  ToolTaskHandler,
} from '@modelcontextprotocol/server';

import type { z } from 'zod/v4';

import { classifyError, ErrorCode, McpError } from '../core/errors.js';
import { maybeStripStructuredContentFromResult } from '../core/util.js';
import { toToolJsonSchema } from '../schemas/json-schema.js';

import * as progressSinks from './progress-sinks.js';
import {
  buildToolErrorResponse,
  type IconInfo,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResult,
  toToolContext,
  withDefaultIcons,
} from './shared.js';

export {
  createBatchProgressCallbacks,
  completeProgressSession,
  resolveFinalProgressCurrent,
  runWithProgressSession,
} from './progress-sinks.js';
// === Section A: Task Support Metadata ===
type TaskSupportLevel = 'optional' | 'required' | 'forbidden';

function isTaskSupportLevel(value: unknown): value is TaskSupportLevel {
  return value === 'optional' || value === 'required' || value === 'forbidden';
}

function resolveToolTaskSupportLevel(
  topLevelTaskSupport: unknown,
  executionTaskSupport: unknown,
): TaskSupportLevel | undefined {
  if (isTaskSupportLevel(topLevelTaskSupport)) {
    return topLevelTaskSupport;
  }

  if (isTaskSupportLevel(executionTaskSupport)) {
    return executionTaskSupport;
  }

  return undefined;
}

function wrapToolHandler<Args, Result>(
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>,
  options: {
    guard?: (() => boolean) | undefined;
    progressMessage?: (args: Args) => string;
    completionMessage?: (args: Args, result: ToolResult<Result>) => string | undefined;
  },
): (args: Args, ctx?: ToolContext | ServerContext) => Promise<ToolResult<Result>> {
  return async (args: Args, ctx?: ToolContext | ServerContext) => {
    const resolvedExtra = toToolContext(ctx);
    if (options.guard && !options.guard()) {
      return maybeStripStructuredContentFromResult(buildNotInitializedResult());
    }

    if (options.progressMessage) {
      const label = options.progressMessage(args);
      const progress = progressSinks.progressSessionFromContext(resolvedExtra, {
        label,
      });
      try {
        const result = await handler(args, resolvedExtra);
        const suffix = options.completionMessage?.(args, result);
        progress.complete(suffix ? `${label} • ${suffix}` : label);
        return maybeStripStructuredContentFromResult(result);
      } catch (error) {
        progress.fail(error, `${label} • ${classifyError(error)}`);
        throw error;
      }
    }

    const result = await handler(args, resolvedExtra);
    return maybeStripStructuredContentFromResult(result);
  };
}

function buildNotInitializedResult<T>(): ToolResult<T> {
  return buildToolErrorResponse(NOT_INITIALIZED_ERROR, ErrorCode.INVALID_INPUT);
}

const NOT_INITIALIZED_ERROR = new McpError(
  ErrorCode.INVALID_INPUT,
  'Server not initialized. Roots unavailable.',
);

// --- Type Guards & Helpers ---

type ToolSchema = StandardSchemaWithJSON | undefined;

// Convert Zod schemas in a tool definition to Standard Schemas for MCP wire format.
// Uses inputSchemaJson when provided (pre-augmented schema, e.g. with oneOf).
function convertSchemasToWire(
  toolDef: Record<string, unknown>,
  inputSchemaJson?: ReturnType<typeof toToolJsonSchema>,
): Record<string, unknown> {
  const result = { ...toolDef };
  result.inputSchema = inputSchemaJson ?? toToolJsonSchema(result.inputSchema as z.ZodType);
  if (result.outputSchema != null) {
    result.outputSchema = toToolJsonSchema(result.outputSchema as z.ZodType);
  }
  // Remove the helper field — not part of MCP wire protocol
  delete result.inputSchemaJson;
  return result;
}

function tryRegisterToolTask<Args extends ToolSchema>(
  server: McpServer,
  toolName: string,
  toolDef: object,
  taskHandler: ToolTaskHandler<Args>,
  iconInfo: IconInfo | undefined,
): boolean {
  const def = toolDef as Record<string, unknown>;
  const existingExecution = (def.execution as Record<string, unknown> | undefined) ?? {};
  const taskSupport = resolveToolTaskSupportLevel(def.taskSupport, existingExecution.taskSupport);

  if (!taskSupport || taskSupport === 'forbidden') return false;

  // `as never`: the MCP SDK uses `StandardSchema` generics for tool registration,
  // but we hand it a JSON-Schema-shaped object produced by `convertSchemasToWire`.
  // The runtime shape is verified by the SDK's own validation; the cast bridges
  // the structural gap without disabling type-checking elsewhere.
  server.experimental.tasks.registerToolTask(
    toolName,
    convertSchemasToWire(
      withDefaultIcons({ ...toolDef, execution: { ...existingExecution, taskSupport } }, iconInfo),
      (toolDef as ToolContract).inputSchemaJson,
    ) as never,
    taskHandler as never,
  );
  return true;
}

export function registerStandardTool<Args, Result extends Record<string, unknown>>(
  server: McpServer,
  toolDef: ToolContract,
  handler: (args: Args, ctx: ToolContext) => Promise<ToolResult<Result>>,
  options: ToolRegistrationOptions,
  wrapOptions: {
    guard?: (() => boolean) | undefined;
    progressMessage?: (args: Args) => string;
    completionMessage?: (args: Args, result: ToolResult<Result>) => string | undefined;
  } = {},
): void {
  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
    ...wrapOptions,
  });
  const validatedHandler = wrappedHandler;

  const orchestrator = options.orchestrator;
  if (options.hasTaskSupport && orchestrator) {
    const taskHandler = orchestrator.wrapToolTask(handler as never, {
      toolName: toolDef.name,
    });
    if (
      tryRegisterToolTask(server, toolDef.name, toolDef, taskHandler as never, options.iconInfo)
    ) {
      return;
    }
  }

  server.registerTool(
    toolDef.name,
    // `as never`: see `tryRegisterToolTask` — same StandardSchema/JSON-Schema bridge.
    convertSchemasToWire(
      withDefaultIcons({ ...toolDef }, options.iconInfo),
      toolDef.inputSchemaJson,
    ),
    validatedHandler as never,
  );
}

