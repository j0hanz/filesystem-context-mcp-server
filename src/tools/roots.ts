import { z } from 'zod/v4';

import { ErrorCode } from '../lib/errors.js';
import { getAllowedDirectories } from '../lib/paths.js';

import { joinLines } from '../config.js';
import { defineTool } from './define-tool.js';
import { DIRECTORY_ICONS } from './icons.js';
import {
  buildToolResponse,
  READ_ONLY_TOOL_ANNOTATIONS,
  type ToolContract,
} from './shared.js';

const RootsInputSchema = z.strictObject({});

const RootsOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  roots: z
    .array(
      z.strictObject({
        uri: z.string().describe('Root URI'),
        name: z.string().optional().describe('Display name'),
      })
    )
    .describe('Allowed root directories'),
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

function buildTextRoots(dirs: string[]): string {
  if (dirs.length === 0) {
    return 'No directories configured';
  }
  return joinLines([
    `${dirs.length} workspace roots:`,
    ...dirs.map((d) => `  ${d}`),
  ]);
}

export const LIST_ALLOWED_DIRECTORIES = defineTool<
  z.infer<typeof RootsInputSchema>,
  z.infer<typeof RootsOutputSchema>
>({
  contract: LIST_ALLOWED_DIRECTORIES_TOOL,
  run: () => {
    const dirs = getAllowedDirectories();
    const structured = {
      ok: true,
      roots: dirs.map((uri) => ({ uri })),
    } as const;
    return Promise.resolve(buildToolResponse(buildTextRoots(dirs), structured));
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
