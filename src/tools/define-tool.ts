import type { McpServer } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import type { z } from 'zod/v4';

import { ErrorCode } from '../lib/errors.js';

import type { ToolContract } from './contract.js';
import { progressSessionFromContext } from './progress-sinks.js';
import {
  buildToolErrorResponse,
  executeToolWithDiagnostics,
  type HandlerContext,
  type ToolContext,
  type ToolRegistrationOptions,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './tool-execution.js';

export interface DefineToolOptions<Args, Output extends Record<string, unknown>> {
  contract: ToolContract;
  run: (args: Args, ctx: HandlerContext) => Promise<ToolResult<Output>>;
  progressMessage?: (args: Args) => string;
  completionMessage?: (args: Args, result: ToolResult<Output>) => string | undefined;
  /** Default: `{ path: (args as { path?: string }).path }`. */
  diagnosticsContext?: (args: Args) => Record<string, unknown>;
  /** Default: `ErrorCode.UNKNOWN`. If onError is provided, this is ignored. */
  defaultErrorCode?: ErrorCode;
  /** Optional custom error handler. If provided, overrides defaultErrorCode.
   * Can return either success or error responses. */
  onError?: (error: unknown, args: Args) => ToolResult<Output>;
}

export interface DefinedTool<Args, Output extends Record<string, unknown>> {
  readonly contract: ToolContract;
  readonly handle: (args: Args, ctx: HandlerContext) => Promise<ToolResult<Output>>;
  register(server: McpServer, options: ToolRegistrationOptions): void;
}

export function defineTool<Args, Output extends Record<string, unknown>>(
  opts: DefineToolOptions<Args, Output>,
): DefinedTool<Args, Output> {
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
    handle: run,
    register(server: McpServer, options: ToolRegistrationOptions): void {
      const handler = (args: Args, ctx: ToolContext): Promise<ToolResult<Output>> =>
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
            const progress = progressSessionFromContext(ctx, {
              label: contract.name,
            });
            const handlerCtx: HandlerContext = {
              ...(signal !== undefined ? { signal } : {}),
              pathGuard: options.pathGuard,
              resourceStore: options.resourceStore,
              ...(ctx.elicitInput ? { elicitInput: ctx.elicitInput } : {}),
              ...(ctx.log ? { log: ctx.log } : {}),
              onProgress: (p) => {
                progress.set(p);
              },
            };
            try {
              const result = await run(args, handlerCtx);
              progress.complete(contract.name);
              return result;
            } catch (error) {
              progress.fail(error);
              throw error;
            }
          },
          onError: (error) =>
            opts.onError
              ? opts.onError(error, args)
              : buildToolErrorResponse(
                  error,
                  errorCode,
                  diagnosticsContext(args).path as string | undefined,
                ),
        });

      registerStandardTool(server, contract, handler, options, {
        ...(opts.progressMessage ? { progressMessage: opts.progressMessage } : {}),
        ...(opts.completionMessage ? { completionMessage: opts.completionMessage } : {}),
      });
    },
  };
}

/**
 * Builds standard `progressMessage` and `completionMessage` callbacks for
 * single-path tools that follow the pattern:
 *   progress  → `<title>: <basename>`
 *   error     → `<title>: <basename> • <errorCode>`
 *   success   → `<title>: <basename> • <suffix>` (or just `<title>: <basename>`)
 */
export function buildPathMessages<
  Args extends { path: string },
  Out extends Record<string, unknown>,
>(
  title: string,
  suffixForSuccess?: (sc: Out) => string | undefined,
): {
  progressMessage: (args: Args) => string;
  completionMessage: (args: Args, result: ToolResult<Out>) => string;
} {
  return {
    progressMessage: (args) => `${title}: ${basename(args.path)}`,
    completionMessage: (args, result) => {
      const name = basename(args.path);
      if (result.isError) return `${title}: ${name} \u2022 ${result.errorCode}`;
      const suffix = suffixForSuccess?.(result.structuredContent);
      return suffix !== undefined ? `${title}: ${name} \u2022 ${suffix}` : `${title}: ${name}`;
    },
  };
}
