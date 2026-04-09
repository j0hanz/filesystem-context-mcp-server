import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import * as path from 'node:path';

import type { z } from 'zod';

import { DEFAULT_SEARCH_TIMEOUT_MS } from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import {
  formatTreeAscii,
  treeDirectory,
} from '../lib/file-operations/metadata.js';

import { TreeInputSchema, TreeOutputSchema } from '../schemas.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  createProgressReporter,
  executeToolWithDiagnostics,
  notifyProgress,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolvePathOrRoot,
  type ToolContract,
  type ToolExtra,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';
import { registerToolTaskIfAvailable } from './task-support.js';

export const TREE_TOOL: ToolContract = {
  name: 'tree',
  title: 'Tree',
  description:
    'Render a directory tree (bounded recursion). Returns ASCII tree + structured JSON. ' +
    '`maxDepth=0` returns only the root node.',
  inputSchema: TreeInputSchema,
  outputSchema: TreeOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
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
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof TreeInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof TreeOutputSchema>>> => {
    const targetPath = args.path ?? '.';
    return executeToolWithDiagnostics({
      toolName: 'tree',
      extra,
      outputSchema: TreeOutputSchema,
      timedSignal: { timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS },
      context: { path: targetPath },
      run: async (signal) => {
        const context = args.path ? path.basename(args.path) : '.';
        let progressCursor = 0;
        const knownTotal = args.maxEntries;

        notifyProgress(extra, {
          current: 0,
          total: knownTotal,
          message: `≣ tree: ${context}`,
        });

        const baseReporter = createProgressReporter(extra);
        const onProgress = (progress: { current: number }): void => {
          const { current } = progress;
          if (current > progressCursor) progressCursor = current;
          baseReporter({
            current,
            total: knownTotal,
            message: `≣ tree: ${context} [${current} entries]`,
          });
        };

        try {
          const result = await handleTree(args, signal, onProgress);
          const sc = result.structuredContent;
          const count = sc.totalEntries ?? 0;
          const { truncated } = sc;

          let suffix = `${count} ${count === 1 ? 'entry' : 'entries'}`;
          if (truncated) suffix += ' [truncated]';

          const finalCurrent = Math.max(count, progressCursor + 1);
          notifyProgress(extra, {
            current: finalCurrent,
            total: finalCurrent,
            message: `≣ tree: ${context} • ${suffix}`,
          });
          return result;
        } catch (error) {
          const finalCurrent = Math.max(progressCursor + 1, 1);
          notifyProgress(extra, {
            current: finalCurrent,
            total: finalCurrent,
            message: `≣ tree: ${context} • failed`,
          });
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.NOT_DIRECTORY, targetPath),
    });
  };

  const wrappedHandler = wrapToolHandler(handler, {
    guard: options.isInitialized,
  });

  const validatedHandler = withValidatedArgs(TreeInputSchema, wrappedHandler);

  if (
    registerToolTaskIfAvailable(
      server,
      'tree',
      TREE_TOOL,
      validatedHandler,
      options.iconInfo,
      options.isInitialized
    )
  )
    return;
  server.registerTool(
    'tree',
    withDefaultIcons({ ...TREE_TOOL }, options.iconInfo),
    validatedHandler
  );
}
