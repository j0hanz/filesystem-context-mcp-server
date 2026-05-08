import { z } from 'zod/v4';

import { ErrorCode } from '../lib/errors.js';

import { defineTool } from './define-tool.js';
import { DIRECTORY_ICONS } from './icons.js';
import {
  buildToolResponse,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';

const RootsInputSchema = z.strictObject({});

const RootsOutputSchema = z.strictObject({
  roots: z.array(z.string()).describe('Allowed root directory paths'),
});

const LIST_ALLOWED_DIRECTORIES_TOOL: ToolContract = {
  name: 'roots',
  title: 'Workspace Roots',
  description:
    'List allowed workspace roots. Call first \u2014 all other tools are scoped to these directories.',
  inputSchema: RootsInputSchema,
  outputSchema: RootsOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: DIRECTORY_ICONS,
  taskSupport: 'forbidden',
} as const;

function buildTextRoots(count: number): string {
  return `roots: ${count} allowed ${count === 1 ? 'directory' : 'directories'}`;
}

export const LIST_ALLOWED_DIRECTORIES = defineTool<
  z.infer<typeof RootsInputSchema>,
  z.infer<typeof RootsOutputSchema>
>({
  contract: LIST_ALLOWED_DIRECTORIES_TOOL,
  run: (_args, ctx) => {
    const dirs = ctx.pathGuard.getAllowedDirectories();
    const structured: z.infer<typeof RootsOutputSchema> = {
      roots: dirs,
    };
    return Promise.resolve(
      buildToolResponse(buildTextRoots(dirs.length), structured)
    );
  },
  progressMessage: () => LIST_ALLOWED_DIRECTORIES_TOOL.title,
  completionMessage: (_args, result) => {
    if (result.isError)
      return `${LIST_ALLOWED_DIRECTORIES_TOOL.title} • ${result.errorCode}`;
    const sc = result.structuredContent;
    const count = sc.roots.length;
    return `${LIST_ALLOWED_DIRECTORIES_TOOL.title} • ${count} ${count === 1 ? 'root' : 'roots'}`;
  },
  defaultErrorCode: ErrorCode.UNKNOWN,
});
