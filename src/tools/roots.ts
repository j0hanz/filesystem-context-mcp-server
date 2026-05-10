import { z } from 'zod/v4';

import { ErrorCode } from '../core/errors.js';
import { buildToolResponse } from './_helpers.js';
import { defineTool } from './define.js';

const RootsInputSchema = z.strictObject({});

const RootsOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  roots: z.array(z.string()).describe('Allowed root directory paths'),
});

export const LIST_ALLOWED_DIRECTORIES = defineTool({
  name: 'list_roots',
  title: 'Workspace Roots',
  description:
    'List allowed workspace roots. Call first \u2014 all other tools are scoped to these directories.',
  input: RootsInputSchema,
  output: RootsOutputSchema,
  annotations: 'readOnly',
  run: (_args, ctx) => {
    const dirs = ctx.pathGuard.getAllowedDirectories();
    const structured = { ok: true as const, roots: dirs };
    const summary = `roots: ${String(dirs.length)} allowed director${dirs.length === 1 ? 'y' : 'ies'}`;
    return Promise.resolve(buildToolResponse(summary, structured));
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
});
