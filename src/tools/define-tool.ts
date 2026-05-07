import type { McpServer } from '@modelcontextprotocol/server';

import type { z } from 'zod/v4';

import { ErrorCode } from '../lib/errors.js';

import type { ToolContract } from './contract.js';
import {
  buildToolErrorResponse,
  executeToolWithDiagnostics,
  type ToolContext,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

export interface ToolRunContext extends ToolContext {
  signal?: AbortSignal;
  resourceStore: ToolRegistrationOptions['resourceStore'];
}

export interface DefineToolOptions<
  Args,
  Output extends Record<string, unknown>,
> {
  contract: ToolContract;
  run: (args: Args, ctx: ToolRunContext) => Promise<ToolResponse<Output>>;
  progressMessage?: (args: Args) => string;
  completionMessage?: (
    args: Args,
    result: ToolResult<Output>
  ) => string | undefined;
  /** Default: `{ path: (args as { path?: string }).path }`. */
  diagnosticsContext?: (args: Args) => Record<string, unknown>;
  /** Default: `ErrorCode.UNKNOWN`. */
  defaultErrorCode?: ErrorCode;
}

export interface DefinedTool {
  readonly contract: ToolContract;
  register(server: McpServer, options: ToolRegistrationOptions): void;
}

export function defineTool<Args, Output extends Record<string, unknown>>(
  opts: DefineToolOptions<Args, Output>
): DefinedTool {
  const { contract, run } = opts;
  const errorCode = opts.defaultErrorCode ?? ErrorCode.UNKNOWN;
  const diagnosticsContext =
    opts.diagnosticsContext ??
    ((args: Args) => {
      const path = (args as { path?: string }).path;
      return path !== undefined ? { path } : {};
    });

  return {
    contract,
    register(server, options) {
      const handler = (
        args: Args,
        ctx: ToolContext
      ): Promise<ToolResult<Output>> =>
        executeToolWithDiagnostics<Output>({
          toolName: contract.name,
          ctx,
          ...(contract.outputSchema
            ? { outputSchema: contract.outputSchema as z.ZodType<Output> }
            : {}),
          ...(contract.defaultTimeoutMs !== undefined
            ? { timedSignal: { timeoutMs: contract.defaultTimeoutMs } }
            : { timedSignal: {} }),
          context: diagnosticsContext(args),
          run: async (signal) => {
            const runCtx: ToolRunContext = {
              ...ctx,
              ...(signal !== undefined ? { signal } : {}),
              resourceStore: options.resourceStore,
            };
            return run(args, runCtx);
          },
          onError: (error) =>
            buildToolErrorResponse(
              error,
              errorCode,
              diagnosticsContext(args).path as string | undefined
            ),
        });

      registerStandardTool(server, contract, handler, options, {
        ...(opts.progressMessage
          ? { progressMessage: opts.progressMessage }
          : {}),
        ...(opts.completionMessage
          ? { completionMessage: opts.completionMessage }
          : {}),
      });
    },
  };
}
