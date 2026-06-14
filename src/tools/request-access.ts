import * as z from 'zod/v4';

import { ErrorCode, FsError } from '../core/errors.js';
import { normalizePath } from '../core/path.js';
import { defineTool } from './define.js';

const RequestAccessInputSchema = z.strictObject({
  path: z.string().describe('The absolute directory path to request access to'),
});

const RequestAccessOutputSchema = z.strictObject({
  ok: z.boolean().describe('True if access was granted, false otherwise'),
  granted: z.string().optional().describe('The resolved path that was granted access'),
  reason: z.string().optional().describe('Reason for refusal if ok is false'),
});

export const REQUEST_ACCESS = defineTool({
  name: 'request_access',
  title: 'Request Filesystem Access',
  description: 'Request runtime filesystem access to a specific directory.',
  input: RequestAccessInputSchema,
  output: RequestAccessOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: false,
    openWorldHint: false,
  },
  run: async (args, ctx) => {
    if (!ctx.server || !ctx.elicitInput) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Client does not support elicitation');
    }
    const capabilities = ctx.server.server.getClientCapabilities();
    if (!capabilities?.elicitation) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Client does not support elicitation');
    }

    const normalized = normalizePath(args.path);
    let resolved: string;
    try {
      resolved = await ctx.fs.realpathUnchecked(normalized, { signal: ctx.signal });
      const stats = await ctx.fs.statUnchecked(resolved, { signal: ctx.signal });
      if (!stats.isDirectory()) {
        throw new FsError(ErrorCode.INVALID_INPUT, 'Path must be a directory');
      }
    } catch (err) {
      if (err instanceof FsError) {
        throw err;
      }
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        `Invalid directory path: ${err instanceof Error ? err.message : String(err)}`,
        undefined,
        undefined,
        err,
      );
    }

    if (ctx.denialCache?.has(resolved)) {
      return {
        structured: {
          ok: false,
          reason: 'Access request denied (cached from previous refusal)',
        },
      };
    }

    let response;
    try {
      const confirmField = {
        type: 'boolean' as const,
        title: 'Confirm',
      };
      response = await ctx.elicitInput({
        mode: 'form',
        message: `Grant filesystem access to: ${resolved}?`,
        requestedSchema: {
          type: 'object',
          properties: { confirm: confirmField },
          required: ['confirm'],
        },
      });
    } catch (err) {
      return {
        structured: {
          ok: false,
          reason: `Access request cancelled: elicitation error: ${err instanceof Error ? err.message : String(err)}`,
        },
      };
    }

    if (response.action !== 'accept' || response.content?.['confirm'] !== true) {
      ctx.denialCache?.set(resolved, true);
      return {
        structured: {
          ok: false,
          reason: 'Access request denied by user',
        },
      };
    }

    const boundaries = ctx.pathGuard.getRootBoundaries();
    if (boundaries.length > 0) {
      const { isPathWithinDirectories } = await import('../core/path.js');
      if (!isPathWithinDirectories(resolved, boundaries)) {
        throw new FsError(
          ErrorCode.ACCESS_DENIED,
          'Path approved by user but outside configured boundary',
        );
      }
    }

    const existingRoots = ctx.pathGuard.getAllowedDirectories();
    const newRoots = [...existingRoots, resolved];
    await ctx.fs.setRoots(newRoots);

    return {
      structured: {
        ok: true,
        granted: resolved,
      },
    };
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
});
