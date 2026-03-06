import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { createTwoFilesPatch } from 'diff';
import RE2 from 're2';
import safeRegex from 'safe-regex2';
import type { z } from 'zod';

import {
  DEFAULT_EXCLUDE_PATTERNS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../lib/constants.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  McpError,
} from '../lib/errors.js';
import { globEntries } from '../lib/file-operations/traversal.js';
import { atomicWriteFile, withAbort } from '../lib/fs-helpers.js';
import { validateExistingPath, validatePathForWrite } from '../lib/paths.js';
import { reportPeriodicProgress } from '../lib/utils.js';

import {
  SearchAndReplaceInputSchema,
  SearchAndReplaceOutputSchema,
} from '../schemas.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  createToolProgressSession,
  DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  executeToolWithDiagnostics,
  resolveFinalProgressCurrent,
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

export const SEARCH_AND_REPLACE_TOOL: ToolContract = {
  name: 'search_and_replace',
  title: 'Search and Replace',
  description:
    'Bulk search-and-replace across files matching a glob. ' +
    'Replaces ALL occurrences per file (unlike `edit`: first only). ' +
    'Always `dryRun:true` first \u2014 returns a unified diff. ' +
    'Literal matching by default; `isRegex:true` enables RE2 with capture groups ($1, $2).',
  inputSchema: SearchAndReplaceInputSchema,
  outputSchema: SearchAndReplaceOutputSchema,
  annotations: DESTRUCTIVE_WRITE_TOOL_ANNOTATIONS,
  taskSupport: 'optional',
  gotchas: [
    'Replaces ALL occurrences — not just the first. Use `edit` for single replacements.',
  ],
  nuances: [
    'Changed-file sample and failure sample are capped/truncated in output.',
  ],
} as const;

const MAX_FAILURES = 20;
const REPLACE_CONCURRENCY = Math.min(PARALLEL_CONCURRENCY, 8);
const MAX_CHANGED_FILES = 100;
const MAX_DIFF_SIZE = 20 * 1024; // 20KB limit for diff output

interface Failure {
  path: string;
  error: string;
}

function recordFailure(failures: Failure[], failure: Failure): void {
  if (failures.length >= MAX_FAILURES) return;
  failures.push(failure);
}

function recordChangedFile(
  summary: ReplaceSummary,
  filePath: string,
  matchCount: number
): void {
  const relativePath = path.relative(summary.root, filePath);
  if (summary.changedFiles.length < MAX_CHANGED_FILES) {
    summary.changedFiles.push({ path: relativePath, matches: matchCount });
    return;
  }
  summary.changedFilesTruncated = true;
}

function createRegexMatcher(pattern: string): RE2 {
  try {
    return new RE2(pattern, 'g');
  } catch (error) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Invalid regex pattern: ${formatUnknownErrorMessage(error)}`
    );
  }
}

interface ReplacementMatcher {
  count(content: string): number;
  replace(content: string, replacement: string): string;
}

function createRegexReplacementMatcher(regex: RE2): ReplacementMatcher {
  const count = (content: string): number => {
    regex.lastIndex = 0;
    let matchCount = 0;
    while (regex.exec(content) !== null) {
      matchCount++;
      if (regex.lastIndex === 0) {
        regex.lastIndex++;
      }
    }
    return matchCount;
  };

  const replace = (content: string, replacement: string): string => {
    regex.lastIndex = 0;
    return content.replace(regex, replacement);
  };

  return { count, replace };
}

function createLiteralReplacementMatcher(
  searchPattern: string
): ReplacementMatcher {
  const count = (content: string): number => {
    let matchCount = 0;
    let pos = content.indexOf(searchPattern);
    const patternLength = searchPattern.length;
    while (pos !== -1) {
      matchCount++;
      pos = content.indexOf(searchPattern, pos + patternLength);
    }
    return matchCount;
  };

  const replace = (content: string, replacement: string): string =>
    content.replaceAll(searchPattern, () => replacement);

  return { count, replace };
}

function formatFileTooLargeError(
  filePath: string,
  size: number,
  maxFileSize: number
): string {
  return `File too large: ${filePath} (${size} bytes > ${maxFileSize} bytes)`;
}

async function processEntry(
  entryPath: string,
  options: { dryRun: boolean; returnDiff: boolean },
  replacement: string,
  matcher: ReplacementMatcher,
  maxFileSize: number,
  signal: AbortSignal | undefined,
  summary: ReplaceSummary
): Promise<void> {
  let validPath: string;
  try {
    validPath = await validatePathForWrite(entryPath, signal);
  } catch (error) {
    summary.failedFiles++;
    recordFailure(summary.failures, {
      path: entryPath,
      error: formatUnknownErrorMessage(error),
    });
    return;
  }

  try {
    const stats = await withAbort(fs.stat(validPath), signal);
    if (stats.size > maxFileSize) {
      summary.failedFiles++;
      recordFailure(summary.failures, {
        path: validPath,
        error: formatFileTooLargeError(validPath, stats.size, maxFileSize),
      });
      return;
    }

    const content = await fs.readFile(validPath, {
      encoding: 'utf-8',
      signal,
    });

    const matchCount = matcher.count(content);

    if (matchCount > 0) {
      summary.totalMatches += matchCount;
      summary.filesChanged++;

      recordChangedFile(summary, validPath, matchCount);

      const newContent = matcher.replace(content, replacement);

      if (
        (options.dryRun || options.returnDiff) &&
        summary.diff.length < MAX_DIFF_SIZE
      ) {
        const patch = createTwoFilesPatch(
          path.basename(validPath),
          path.basename(validPath),
          content,
          newContent,
          'Original',
          'Modified'
        );
        // Only append if it won't exceed the limit too much
        if (summary.diff.length + patch.length <= MAX_DIFF_SIZE + 1024) {
          summary.diff += patch;
        }
      }

      if (!options.dryRun) {
        await atomicWriteFile(validPath, newContent, {
          encoding: 'utf-8',
          signal,
        });
      }
    }
  } catch (error) {
    summary.failedFiles++;
    recordFailure(summary.failures, {
      path: validPath,
      error: formatUnknownErrorMessage(error),
    });
  }
}

async function processEntriesConcurrently(
  entries: AsyncIterable<{ path: string }>,
  options: {
    signal: AbortSignal | undefined;
    concurrency: number;
    onEntry: () => void;
    runEntry: (entryPath: string) => Promise<void>;
  }
): Promise<void> {
  const pending = new Set<Promise<void>>();
  const { signal, concurrency, onEntry, runEntry } = options;

  const waitForSlot = async (): Promise<void> => {
    if (pending.size < concurrency) return;
    await Promise.race(pending);
  };

  for await (const entry of entries) {
    if (signal?.aborted) break;
    await waitForSlot();
    onEntry();

    const task = runEntry(entry.path);
    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
    });
  }

  if (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }
}

interface ReplaceSummary {
  root: string;
  totalMatches: number;
  filesChanged: number;
  failedFiles: number;
  processedFiles: number;
  failures: Failure[];
  changedFiles: { path: string; matches: number }[];
  changedFilesTruncated: boolean;
  diff: string;
}

function createReplaceSummary(root: string): ReplaceSummary {
  return {
    root,
    totalMatches: 0,
    filesChanged: 0,
    failedFiles: 0,
    processedFiles: 0,
    failures: [],
    changedFiles: [],
    changedFilesTruncated: false,
    diff: '',
  };
}

async function resolveSearchRoot(
  pathValue: string | undefined,
  signal?: AbortSignal
): Promise<string> {
  return pathValue
    ? validateExistingPath(pathValue, signal)
    : resolvePathOrRoot(pathValue);
}

function createReplacementRegex(
  args: z.infer<typeof SearchAndReplaceInputSchema>
): RE2 | undefined {
  if (!args.isRegex) return undefined;
  if (!safeRegex(args.searchPattern)) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Unsafe regex pattern: ${args.searchPattern}`
    );
  }
  return createRegexMatcher(args.searchPattern);
}

function createReplacementMatcher(
  args: z.infer<typeof SearchAndReplaceInputSchema>
): ReplacementMatcher {
  const regex = createReplacementRegex(args);
  if (regex) {
    return createRegexReplacementMatcher(regex);
  }
  return createLiteralReplacementMatcher(args.searchPattern);
}

export async function handleSearchAndReplace(
  args: z.infer<typeof SearchAndReplaceInputSchema>,
  signal?: AbortSignal,
  onProgress: (progress: { total?: number; current: number }) => void = () => {}
): Promise<ToolResponse<z.infer<typeof SearchAndReplaceOutputSchema>>> {
  const maxFileSize = MAX_TEXT_FILE_SIZE;
  const root = await resolveSearchRoot(args.path, signal);
  const matcher = createReplacementMatcher(args);

  const entries = globEntries({
    cwd: root,
    pattern: args.filePattern,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    includeHidden: args.includeHidden ?? false,
    baseNameMatch: false,
    caseSensitiveMatch: true, // Default to sensitive for file paths
    followSymbolicLinks: false,
    onlyFiles: true,
    stats: false,
    suppressErrors: true,
  });

  const summary = createReplaceSummary(root);
  await processEntriesConcurrently(entries, {
    signal,
    concurrency: REPLACE_CONCURRENCY,
    onEntry: () => {
      summary.processedFiles++;
      reportPeriodicProgress(onProgress, summary.processedFiles, {
        throttleModulo: 25,
      });
    },
    runEntry: async (entryPath: string) =>
      processEntry(
        entryPath,
        {
          dryRun: args.dryRun,
          returnDiff: args.returnDiff ?? false,
        },
        args.replacement,
        matcher,
        maxFileSize,
        signal,
        summary
      ),
  });

  reportPeriodicProgress(onProgress, summary.processedFiles, {
    throttleModulo: 25,
    force: true,
  });

  const failureSuffix =
    summary.failedFiles > 0 ? ` (${summary.failedFiles} failed)` : '';

  return buildToolResponse(
    `Found ${summary.totalMatches} matches in ${summary.filesChanged} files${failureSuffix}.${args.dryRun ? ' (Dry run)' : ''}`,
    {
      ok: true,
      matches: summary.totalMatches,
      filesChanged: summary.filesChanged,
      processedFiles: summary.processedFiles,
      ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
      ...(summary.failures.length > 0 ? { failures: summary.failures } : {}),
      ...(summary.changedFiles.length > 0
        ? { changedFiles: summary.changedFiles }
        : {}),
      ...(summary.changedFilesTruncated ? { changedFilesTruncated: true } : {}),
      ...((args.dryRun || args.returnDiff) && summary.diff
        ? { diff: summary.diff }
        : {}),
      dryRun: args.dryRun,
    }
  );
}

export function registerSearchAndReplaceTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof SearchAndReplaceInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof SearchAndReplaceOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'search_and_replace',
      extra,
      timedSignal: {},
      ...(args.path ? { context: { path: args.path } } : {}),
      run: async (signal) => {
        const dryLabel = args.dryRun ? ' [dry run]' : '';
        const context = `"${args.searchPattern}" in ${args.filePattern}${dryLabel}`;
        const progress = createToolProgressSession(
          extra,
          `🛠 replace: ${context}`
        );
        const progressWithMessage = ({
          current,
          total,
        }: {
          total?: number;
          current: number;
        }): void => {
          progress.update({
            current,
            ...(total !== undefined ? { total } : {}),
            message: `🛠 replace: ${args.searchPattern} [${current} files]`,
          });
        };

        try {
          const result = await handleSearchAndReplace(
            args,
            signal,
            progressWithMessage
          );
          const sc = result.structuredContent;
          const finalCurrent = resolveFinalProgressCurrent(
            progress,
            (sc.processedFiles ?? 0) + 1
          );
          const matchWord = (sc.matches ?? 0) === 1 ? 'match' : 'matches';
          const fileWord = (sc.filesChanged ?? 0) === 1 ? 'file' : 'files';
          let endSuffix = `${sc.matches ?? 0} ${matchWord} in ${sc.filesChanged ?? 0} ${fileWord}`;
          if (sc.failedFiles) endSuffix += `, ${sc.failedFiles} failed`;
          progress.complete(
            `🛠 replace: ${context} • ${endSuffix}`,
            finalCurrent
          );
          return result;
        } catch (error) {
          progress.fail(`🛠 replace: ${context} • failed`);
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path),
    });

  const { isInitialized } = options;

  const wrappedHandler = wrapToolHandler(handler, {
    guard: isInitialized,
  });

  const validatedHandler = withValidatedArgs(
    SearchAndReplaceInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'search_and_replace',
      SEARCH_AND_REPLACE_TOOL,
      validatedHandler,
      options.iconInfo,
      isInitialized
    )
  )
    return;
  server.registerTool(
    'search_and_replace',
    withDefaultIcons({ ...SEARCH_AND_REPLACE_TOOL }, options.iconInfo),
    validatedHandler
  );
}
