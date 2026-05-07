import type { McpServer } from '@modelcontextprotocol/server';

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

import { DIRECTORY_ICONS } from './icons.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
  resolvePathOrRoot,
  runWithProgressSession,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
} from './shared.js';
import { registerStandardTool } from './task-support.js';

export const TREE_TOOL: ToolContract = {
  name: 'tree',
  title: 'Tree',
  description:
    'Render a directory tree (bounded recursion). Returns ASCII tree + structured JSON. ' +
    '`maxDepth=0` returns only the root node.',
  inputSchema: TreeInputSchema,
  outputSchema: TreeOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: DIRECTORY_ICONS,
  taskSupport: 'optional',
} as const;

async function handleTree(
  args: z.infer<typeof TreeInputSchema>,
  signal?: AbortSignal,
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

export function registerTreeTool(
  server: McpServer,
  options: ToolRegistrationOptions
): void {
  const handler = (
    args: z.infer<typeof TreeInputSchema>,
    ctx: ToolContext
  ): Promise<ToolResult<z.infer<typeof TreeOutputSchema>>> => {
    const targetPath = args.path ?? '.';
    return executeToolWithDiagnostics({
      toolName: 'tree',
      ctx,
      outputSchema: TreeOutputSchema,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: targetPath },
      run: async (signal) => {
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

            const result = await handleTree(args, signal, onProgress);
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
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.NOT_DIRECTORY, targetPath),
    });
  };

  registerStandardTool(server, TREE_TOOL, handler, options);
}
