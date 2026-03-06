import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Buffer } from 'node:buffer';

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
import { atomicWriteFile } from '../lib/fs-helpers.js';
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
const DIFF_APPEND_BUFFER = 1024;

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

function createRegexMatcher(pattern: string, caseSensitive: boolean): RE2 {
  const flags = caseSensitive ? 'g' : 'gi';
  try {
    return new RE2(pattern, flags);
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
  testBuffer?(buffer: Buffer): boolean;
}

class RegexReplacementMatcher implements ReplacementMatcher {
  constructor(private readonly regex: RE2) {}

  count(content: string): number {
    this.regex.lastIndex = 0;
    let matchCount = 0;
    while (this.regex.exec(content) !== null) {
      matchCount++;
      if (this.regex.lastIndex === 0) {
        this.regex.lastIndex++;
      }
    }
    return matchCount;
  }

  replace(content: string, replacement: string): string {
    this.regex.lastIndex = 0;
    return content.replace(this.regex, replacement);
  }
}

class LiteralReplacementMatcher implements ReplacementMatcher {
  private readonly patternLength: number;
  private readonly searchBuffer: Buffer | null;

  constructor(
    private readonly searchPattern: string,
    private readonly caseSensitive: boolean
  ) {
    this.patternLength = searchPattern.length;
    this.searchBuffer = caseSensitive
      ? Buffer.from(searchPattern, 'utf8')
      : null;
  }

  testBuffer(buffer: Buffer): boolean {
    if (!this.searchBuffer) return true;
    return buffer.indexOf(this.searchBuffer) !== -1;
  }

  count(content: string): number {
    let matchCount = 0;
    let pos = content.indexOf(this.searchPattern);
    while (pos !== -1) {
      matchCount++;
      pos = content.indexOf(this.searchPattern, pos + this.patternLength);
    }
    return matchCount;
  }

  replace(content: string, replacement: string): string {
    return content.replaceAll(this.searchPattern, () => replacement);
  }
}

type SearchAndReplaceArgs = z.infer<typeof SearchAndReplaceInputSchema>;
type SearchAndReplaceOutput = z.infer<typeof SearchAndReplaceOutputSchema>;

interface ProcessEntryContext {
  options: { dryRun: boolean; returnDiff: boolean };
  replacement: string;
  matcher: ReplacementMatcher;
  maxFileSize: number;
  signal: AbortSignal | undefined;
  summary: ReplaceSummary;
}

interface ReplacementPlan {
  matchCount: number;
  originalContent: string;
  updatedContent: string;
}

function buildReplacementPlan(
  content: string,
  replacement: string,
  matcher: ReplacementMatcher
): ReplacementPlan | undefined {
  const matchCount = matcher.count(content);
  if (matchCount === 0) {
    return undefined;
  }

  return {
    matchCount,
    originalContent: content,
    updatedContent: matcher.replace(content, replacement),
  };
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
  context: ProcessEntryContext
): Promise<void> {
  const { options, replacement, matcher, maxFileSize, signal, summary } =
    context;

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
    const plan = await readReplacementPlan(validPath, {
      matcher,
      replacement,
      maxFileSize,
      signal,
    });
    if (!plan) {
      return;
    }

    summary.totalMatches += plan.matchCount;
    summary.filesChanged++;

    recordChangedFile(summary, validPath, plan.matchCount);

    maybeAppendPatchDiff(summary, {
      filePath: validPath,
      originalContent: plan.originalContent,
      updatedContent: plan.updatedContent,
      includeDiff: options.dryRun || options.returnDiff,
    });

    if (!options.dryRun) {
      await atomicWriteFile(validPath, plan.updatedContent, {
        encoding: 'utf-8',
        signal,
      });
    }
  } catch (error) {
    summary.failedFiles++;
    recordFailure(summary.failures, {
      path: validPath,
      error: formatUnknownErrorMessage(error),
    });
  }
}

async function readReplacementPlan(
  validPath: string,
  context: {
    matcher: ReplacementMatcher;
    replacement: string;
    maxFileSize: number;
    signal: AbortSignal | undefined;
  }
): Promise<ReplacementPlan | undefined> {
  let fileHandle: fs.FileHandle | undefined;
  try {
    const fd = await fs.open(validPath, 'r');
    fileHandle = fd;
    const stats = await fileHandle.stat();
    if (stats.size > context.maxFileSize) {
      throw new Error(
        formatFileTooLargeError(validPath, stats.size, context.maxFileSize)
      );
    }

    let content: string;
    if (context.matcher.testBuffer) {
      const buffer = await fileHandle.readFile({ signal: context.signal });
      if (!context.matcher.testBuffer(buffer)) {
        return undefined;
      }
      content = buffer.toString('utf-8');
    } else {
      content = await fileHandle.readFile({
        encoding: 'utf-8',
        signal: context.signal,
      });
    }

    return buildReplacementPlan(content, context.replacement, context.matcher);
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
  }
}

function maybeAppendPatchDiff(
  summary: ReplaceSummary,
  params: {
    filePath: string;
    originalContent: string;
    updatedContent: string;
    includeDiff: boolean;
  }
): void {
  if (!params.includeDiff) return;
  if (summary.diff.length >= MAX_DIFF_SIZE) {
    summary.diffTruncated = true;
    return;
  }

  const patch = createTwoFilesPatch(
    path.basename(params.filePath),
    path.basename(params.filePath),
    params.originalContent,
    params.updatedContent,
    'Original',
    'Modified'
  );

  if (
    summary.diff.length + patch.length <=
    MAX_DIFF_SIZE + DIFF_APPEND_BUFFER
  ) {
    summary.diff += patch;
    return;
  }

  summary.diffTruncated = true;
}

async function processEntriesConcurrently(
  entries: AsyncIterable<{ path: string }>,
  options: {
    signal: AbortSignal | undefined;
    concurrency: number;
    maxEntries?: number;
    onEntry: () => void;
    runEntry: (entryPath: string) => Promise<void>;
  }
): Promise<{ stoppedByLimit: boolean }> {
  const pending = new Set<Promise<void>>();
  const seen = new Set<string>();
  const { signal, concurrency, maxEntries, onEntry, runEntry } = options;
  let dispatched = 0;
  let stoppedByLimit = false;

  const waitForSlot = async (): Promise<void> => {
    if (pending.size < concurrency) return;
    await Promise.race(pending);
  };

  for await (const entry of entries) {
    if (signal?.aborted) break;
    if (maxEntries !== undefined && dispatched >= maxEntries) {
      stoppedByLimit = true;
      break;
    }
    if (seen.has(entry.path)) continue;
    seen.add(entry.path);
    await waitForSlot();
    onEntry();
    dispatched++;

    const task = runEntry(entry.path);
    pending.add(task);
    void task.finally(() => {
      pending.delete(task);
    });
  }

  if (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }

  return { stoppedByLimit };
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
  diffTruncated: boolean;
  stoppedReason?: 'maxFiles';
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
    diffTruncated: false,
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
  return createRegexMatcher(args.searchPattern, args.caseSensitive);
}

function createReplacementMatcher(
  args: SearchAndReplaceArgs
): ReplacementMatcher {
  const regex = createReplacementRegex(args);
  if (regex) {
    return new RegexReplacementMatcher(regex);
  }
  if (!args.caseSensitive) {
    const escaped = args.searchPattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const caseInsensitiveRegex = new RE2(escaped, 'gi');
    return new RegexReplacementMatcher(caseInsensitiveRegex);
  }
  return new LiteralReplacementMatcher(args.searchPattern, args.caseSensitive);
}

export async function handleSearchAndReplace(
  args: SearchAndReplaceArgs,
  signal?: AbortSignal,
  onProgress: (progress: { total?: number; current: number }) => void = () => {}
): Promise<ToolResponse<SearchAndReplaceOutput>> {
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
  const { stoppedByLimit } = await processEntriesConcurrently(entries, {
    signal,
    concurrency: REPLACE_CONCURRENCY,
    ...(args.maxFiles !== undefined ? { maxEntries: args.maxFiles } : {}),
    onEntry: () => {
      summary.processedFiles++;
      reportPeriodicProgress(onProgress, summary.processedFiles, {
        throttleModulo: 25,
      });
    },
    runEntry: async (entryPath: string) =>
      processEntry(entryPath, {
        options: {
          dryRun: args.dryRun,
          returnDiff: args.returnDiff ?? false,
        },
        replacement: args.replacement,
        matcher,
        maxFileSize,
        signal,
        summary,
      }),
  });
  if (stoppedByLimit) {
    summary.stoppedReason = 'maxFiles';
  }

  reportPeriodicProgress(onProgress, summary.processedFiles, {
    throttleModulo: 25,
    force: true,
  });

  return buildToolResponse(
    buildSearchAndReplaceText(summary, args.dryRun),
    buildSearchAndReplaceStructuredResult(summary, args)
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

function buildSearchAndReplaceText(
  summary: ReplaceSummary,
  dryRun: boolean
): string {
  const failureSuffix =
    summary.failedFiles > 0 ? ` (${summary.failedFiles} failed)` : '';
  const dryRunSuffix = dryRun ? ' (Dry run)' : '';
  return `Found ${summary.totalMatches} matches in ${summary.filesChanged} files${failureSuffix}.${dryRunSuffix}`;
}

function buildSearchAndReplaceStructuredResult(
  summary: ReplaceSummary,
  args: SearchAndReplaceArgs
): SearchAndReplaceOutput {
  return {
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
    ...(summary.diffTruncated ? { diffTruncated: true } : {}),
    ...(summary.stoppedReason ? { stoppedReason: summary.stoppedReason } : {}),
    dryRun: args.dryRun,
  };
}
