import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { defineTool } from './define.js';

const RootsInputSchema = z.strictObject({});

const RootsOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true'),
  roots: z.array(z.string()).describe('Absolute paths of the allowed workspace root directories'),
});

export const LIST_ALLOWED_DIRECTORIES = defineTool({
  name: 'list_roots',
  title: 'Workspace Roots',
  description:
    'List the allowed workspace root directories. Call this first to discover what paths are accessible; all other tools are scoped to these roots. Allowed directories are configured via CLI arguments, the FS_ALLOWED_DIRS environment variable, or --allow-cwd.',
  input: RootsInputSchema,
  output: RootsOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  run: (_args, ctx) => {
    const dirs = ctx.fs.pathGuard.getAllowedDirectories();
    const structured = { ok: true as const, roots: [...dirs] };
    const text =
      dirs.length > 0
        ? dirs.join('\n')
        : 'No allowed directories. Please configure allowed directories using CLI arguments, the FS_ALLOWED_DIRS environment variable, or --allow-cwd.';
    return Promise.resolve({ structured, text });
  },

  defaultErrorCode: ErrorCode.UNKNOWN,
});
