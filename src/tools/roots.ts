import * as z from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { defineTool } from './define.js';

const RootsInputSchema = z.strictObject({});

const RootsOutputSchema = z.strictObject({
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
    // No `text` on purpose. A newline-joined path list and the JSON say the
    // same thing, and the JSON is the shape every caller of this tool parses.
    // Supplying no text makes this a data tool, so `define.ts` renders the JSON
    // and keeps it in `structuredContent`.
    return Promise.resolve({ structured: { roots: [...dirs] } });
  },

  defaultErrorCode: ErrorCode.UNKNOWN,
});
