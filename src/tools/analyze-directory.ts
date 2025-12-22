import * as pathModule from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import { ErrorCode, toRpcError } from '../lib/errors.js';
import { analyzeDirectory } from '../lib/file-operations.js';
import {
  AnalyzeDirectoryInputSchema,
  AnalyzeDirectoryOutputSchema,
} from '../schemas/index.js';
import { buildToolResponse, type ToolResponse } from './tool-response.js';

type AnalyzeDirectoryStructuredResult = z.infer<
  typeof AnalyzeDirectoryOutputSchema
>;

const BYTE_UNIT_LABELS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = BYTE_UNIT_LABELS[unitIndex] ?? 'B';
  const value = bytes / Math.pow(1024, unitIndex);
  return `${parseFloat(value.toFixed(2))} ${unit}`;
}

function formatDate(date: Date): string {
  return date.toISOString();
}

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
    (file) => `  ${formatBytes(file.size)} - ${file.path}`
  );
  const recent = analysis.recentlyModified.map(
    (file) => `  ${formatDate(file.modified)} - ${file.path}`
  );

  const lines = [
    ...summary,
    ...(fileTypes.length ? ['File Types:', ...fileTypes, ''] : []),
    ...(largest.length ? ['Largest Files:', ...largest, ''] : []),
    ...(recent.length ? ['Recently Modified:', ...recent] : []),
  ];

  return lines.join('\n');
}

function formatOperationSummary(summary: {
  truncated?: boolean;
  truncatedReason?: string;
  tip?: string;
  skippedInaccessible?: number;
  symlinksNotFollowed?: number;
  skippedTooLarge?: number;
  skippedBinary?: number;
  linesSkippedDueToRegexTimeout?: number;
}): string {
  const lines: string[] = [];
  if (summary.truncated) {
    lines.push(
      `\n\n!! PARTIAL RESULTS: ${summary.truncatedReason ?? 'results truncated'}`
    );
    if (summary.tip) lines.push(`Tip: ${summary.tip}`);
  }
  const note = (count: number | undefined, msg: string): void => {
    if (count && count > 0) lines.push(`Note: ${count} ${msg}`);
  };
  note(summary.skippedTooLarge, 'file(s) skipped (too large).');
  note(summary.skippedBinary, 'file(s) skipped (binary).');
  note(summary.skippedInaccessible, 'item(s) were inaccessible and skipped.');
  note(summary.symlinksNotFollowed, 'symlink(s) were not followed (security).');
  note(
    summary.linesSkippedDueToRegexTimeout,
    'line(s) skipped (regex timeout).'
  );
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
    skippedInaccessible: result.summary.skippedInaccessible,
    symlinksNotFollowed: result.summary.symlinksNotFollowed,
  });
  return textOutput;
}

async function handleAnalyzeDirectory({
  path: dirPath,
  maxDepth,
  topN,
  excludePatterns,
  includeHidden,
}: {
  path: string;
  maxDepth?: number;
  topN?: number;
  excludePatterns?: string[];
  includeHidden?: boolean;
}): Promise<ToolResponse<AnalyzeDirectoryStructuredResult>> {
  const result = await analyzeDirectory(dirPath, {
    maxDepth,
    topN,
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
  outputSchema: AnalyzeDirectoryOutputSchema,
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
    async (args) => {
      try {
        return await handleAnalyzeDirectory(args);
      } catch (error) {
        throw toRpcError(error, ErrorCode.E_NOT_DIRECTORY, args.path);
      }
    }
  );
}
