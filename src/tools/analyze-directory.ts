import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, toRpcError } from '../lib/errors.js';
import { analyzeDirectory } from '../lib/file-operations.js';
import {
  AnalyzeDirectoryInputSchema,
  AnalyzeDirectoryOutputSchema,
} from '../schemas/index.js';
import {
  formatBytes,
  formatDate,
  formatOperationSummary,
} from './shared/formatting.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

type AnalyzeDirectoryArgs = z.infer<
  z.ZodObject<typeof AnalyzeDirectoryInputSchema>
>;
type AnalyzeDirectoryStructuredResult = z.infer<
  typeof AnalyzeDirectoryOutputSchema
>;

function formatDirectoryAnalysis(
  analysis: Awaited<ReturnType<typeof analyzeDirectory>>['analysis']
): string {
  const summary = [
    `Directory Analysis: ${analysis.path}`,
    '='.repeat(50),
    '',
    'Summary:',
    `  Total Files: ${analysis.totalFiles}`,
    `  Total Directories: ${analysis.totalDirectories}`,
    `  Total Size: ${formatBytes(analysis.totalSize)}`,
    `  Max Depth: ${analysis.maxDepth}`,
    '',
  ];

  const fileTypes = Object.entries(analysis.fileTypes)
    .sort((a, b) => b[1] - a[1])
    .map(([ext, count]) => `  ${ext}: ${count}`);

  const largest = analysis.largestFiles.map(
    (file) =>
      `  ${formatBytes(file.size)} - ${pathModule.relative(analysis.path, file.path)}`
  );
  const recent = analysis.recentlyModified.map(
    (file) =>
      `  ${formatDate(file.modified)} - ${pathModule.relative(analysis.path, file.path)}`
  );

  const lines = [
    ...summary,
    ...(fileTypes.length ? ['File Types:', ...fileTypes, ''] : []),
    ...(largest.length ? ['Largest Files:', ...largest, ''] : []),
    ...(recent.length ? ['Recently Modified:', ...recent] : []),
  ];

  return lines.join('\n');
}

function buildStructuredResult(
  result: Awaited<ReturnType<typeof analyzeDirectory>>
): AnalyzeDirectoryStructuredResult {
  return {
    ok: true,
    path: result.analysis.path,
    totalFiles: result.analysis.totalFiles,
    totalDirectories: result.analysis.totalDirectories,
    totalSize: result.analysis.totalSize,
    fileTypes: result.analysis.fileTypes,
    largestFiles: result.analysis.largestFiles.map((f) => ({
      path: pathModule.relative(result.analysis.path, f.path),
      size: f.size,
    })),
    recentlyModified: result.analysis.recentlyModified.map((f) => ({
      path: pathModule.relative(result.analysis.path, f.path),
      modified: f.modified.toISOString(),
    })),
    summary: {
      truncated: result.summary.truncated,
      skippedInaccessible: result.summary.skippedInaccessible,
      symlinksNotFollowed: result.summary.symlinksNotFollowed,
    },
  };
}

function buildTextResult(
  result: Awaited<ReturnType<typeof analyzeDirectory>>
): string {
  let textOutput = formatDirectoryAnalysis(result.analysis);
  textOutput += formatOperationSummary({
    truncated: result.summary.truncated,
    truncatedReason: result.summary.truncated ? 'results truncated' : undefined,
    skippedInaccessible: result.summary.skippedInaccessible,
    symlinksNotFollowed: result.summary.symlinksNotFollowed,
  });
  return textOutput;
}

async function handleAnalyzeDirectory({
  path: dirPath,
  maxDepth,
  topN,
  maxEntries,
  excludePatterns,
  includeHidden,
}: {
  path: string;
  maxDepth?: number;
  topN?: number;
  maxEntries?: number;
  excludePatterns?: string[];
  includeHidden?: boolean;
}): Promise<ToolResponse<AnalyzeDirectoryStructuredResult>> {
  const result = await analyzeDirectory(dirPath, {
    maxDepth,
    topN,
    maxEntries,
    excludePatterns,
    includeHidden,
  });
  const structured = buildStructuredResult(result);
  const textOutput = buildTextResult(result);
  return buildToolResponse(textOutput, structured);
}

const ANALYZE_DIRECTORY_TOOL = {
  title: 'Analyze Directory',
  description:
    'Gather statistics about a directory: total files/directories, total size, ' +
    'file type distribution by extension, largest files (topN), and most recently modified files. ' +
    'Useful for understanding project structure and identifying large files. ' +
    'Use excludePatterns to skip directories like node_modules.',
  inputSchema: AnalyzeDirectoryInputSchema,
  outputSchema: AnalyzeDirectoryOutputSchema.shape,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    openWorldHint: true,
  },
} as const;

export function registerAnalyzeDirectoryTool(server: McpServer): void {
  server.registerTool(
    'analyze_directory',
    ANALYZE_DIRECTORY_TOOL,
    async (args: AnalyzeDirectoryArgs) => {
      try {
        return await handleAnalyzeDirectory(args);
      } catch (error: unknown) {
        throw toRpcError(error, ErrorCode.E_NOT_DIRECTORY, args.path);
      }
    }
  );
}
