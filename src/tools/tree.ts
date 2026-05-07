import { basename } from 'node:path';

import type { z } from 'zod/v4';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import {
  formatTreeAscii,
  treeDirectory,
} from '../lib/file-operations/metadata.js';
import { TreeInputSchema } from '../schemas/inputs.js';
import { TreeOutputSchema } from '../schemas/outputs.js';

import { defineTool } from './define-tool.js';
import { DIRECTORY_ICONS } from './icons.js';
import {
  buildResourceLink,
  buildToolResponse,
  maybeExternalizeTextContent,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
  resolvePathOrRoot,
  runWithProgressSession,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
} from './shared.js';

const TREE_TOOL: ToolContract = {
  name: 'tree',
  title: 'Tree',
  description:
    'Render a directory tree (bounded recursion). Returns ASCII tree + structured JSON. ' +
    '`maxDepth=0` returns only the root node.',
  inputSchema: TreeInputSchema,
  outputSchema: TreeOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: DIRECTORY_ICONS,
  nuances: [
    '`maxDepth=0` returns only the root node.',
    'Result is bounded by both `maxDepth` and `maxEntries`.',
  ],
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

async function handleTree(
  args: z.infer<typeof TreeInputSchema>,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onProgress?: (progress: { current: number }) => void
): Promise<ToolResponse<z.infer<typeof TreeOutputSchema>>> {
  const basePath = resolvePathOrRoot(args.path);
  const result = await treeDirectory(basePath, {
    maxDepth: args.maxDepth,
    maxEntries: args.maxEntries,
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
    includeSizes: args.includeSizes,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  });

  const ascii = formatTreeAscii(result.tree);

  const externalized = maybeExternalizeTextContent(resourceStore, ascii, {
    name: `tree:${result.root}`,
    mimeType: 'text/plain',
  });

  if (externalized) {
    const { entry, preview } = externalized;
    const structured: z.infer<typeof TreeOutputSchema> = {
      ok: true,
      root: result.root,
      tree: result.tree,
      ascii: preview,
      truncated: result.truncated,
      totalEntries: result.totalEntries,
      resourceUri: entry.uri,
    };
    const text = result.truncated ? `${preview}\n[truncated]` : preview;
    return buildToolResponse(text, structured, [
      buildResourceLink({
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
        description: 'Full ASCII tree',
        expiresAt: entry.expiresAt,
      }),
    ]);
  }

  const structured: z.infer<typeof TreeOutputSchema> = {
    ok: true,
    root: result.root,
    tree: result.tree,
    ascii,
    truncated: result.truncated,
    totalEntries: result.totalEntries,
  };

  const text = result.truncated ? `${ascii}\n[truncated]` : ascii;
  return buildToolResponse(text, structured);
}

export const TREE = defineTool<
  z.infer<typeof TreeInputSchema>,
  z.infer<typeof TreeOutputSchema>
>({
  contract: TREE_TOOL,
  defaultErrorCode: ErrorCode.NOT_DIRECTORY,
  run: async (args, ctx) => {
    const context = args.path ? basename(args.path) : '.';
    const label = `${TREE_TOOL.title}: ${context}`;
    const knownTotal = args.maxEntries;

    return runWithProgressSession(
      ctx,
      label,
      async (progress) => {
        const onProgress = ({ current }: { current: number }): void => {
          progress.update({
            current,
            total: knownTotal,
            message: `${label} [${current} entries]`,
          });
        };

        const result = await handleTree(
          args,
          ctx.signal,
          ctx.resourceStore,
          onProgress
        );
        const sc = result.structuredContent;
        const count = sc.totalEntries ?? 0;
        const { truncated } = sc;

        let suffix = `${count} ${count === 1 ? 'entry' : 'entries'}`;
        if (truncated) suffix += ' [truncated]';

        const finalCurrent = resolveFinalProgressCurrent(progress, count);
        return { value: result, suffix, finalCurrent };
      },
      knownTotal
    );
  },
});
