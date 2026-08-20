import type { ContentBlock } from '@modelcontextprotocol/server';

import { Buffer } from 'node:buffer';
import { dirname, join } from 'node:path';

import * as z from 'zod/v4';

import { buildPatchDiff } from '../core/diff.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  Problem,
  rethrowIfAborted,
} from '../core/errors.js';
import { buildFileResourceUri } from '../core/file-uri.js';
import { truncateProgressPattern } from '../core/fmt.js';
import type { GuardedFileSystem } from '../core/fs.js';
import { DEFAULT_EXCLUDE_PATTERNS, globEntries } from '../core/glob.js';
import { detectMimeFromContent } from '../core/mime.js';
import { Logger } from '../core/observability.js';
import { toPosixRelative } from '../core/path.js';
import { escapeRegexLiteral } from '../core/primitives.js';
import { countLines, readFileBufferWithLimit } from '../core/read.js';
import {
  defaultFalseBoolean,
  FileKind,
  includeHiddenField,
  includeIgnoredField,
  isBlank,
  maxDepthField,
  NonNegInt,
  OptionalPath,
  PerFileErrorSchema,
  SafeGlobPattern,
} from '../core/schema.js';
import type { Regex, StoppedReason } from '../core/search.js';
import { compileRegex, freeRegex, StoppedReasonSchema } from '../core/search.js';
import type { ResourceStore } from '../core/store.js';
import {
  DEFAULT_SEARCH_RESULTS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../core/util.js';
import { buildFileResourceLink } from './_helpers.js';
import { defineTool } from './define.js';

const SearchAndReplaceInputSchema = z.strictObject({
  path: OptionalPath,
  pattern: SafeGlobPattern.optional().describe(
    'Glob to restrict replacements to specific file types (e.g. **/*.ts); default: all text files',
  ),
  searchPattern: z
    .string()
    .min(1)
    .max(10000)
    .refine((val) => !isBlank(val), {
      message: 'searchPattern cannot be empty or whitespace-only',
    })
    .describe(
      'Exact literal text or RE2 regex pattern to search for. When isRegex=true, uses RE2 syntax (no lookahead, lookbehind, or backreferences are supported). Cannot be empty or whitespace-only.',
    )
    .meta({ examples: ['TODO', 'function\\s+(\\w+)', 'import.*from'] }),
  replacement: z
    .string()
    .max(10000)
    .describe(
      'Replacement text. Use capture group references ($1, $2, etc.) when isRegex=true. Use an empty string to delete all matches. Cannot contain shell commands or malicious injection sequences.',
    )
    .meta({ examples: ['$1_renamed', '', 'TODO: fix'] }),
  isRegex: defaultFalseBoolean('Treat searchPattern as a RE2 regex (default: literal text match)'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  caseSensitive: defaultFalseBoolean('Enable case-sensitive matching (default: case-insensitive)'),
  wholeWord: defaultFalseBoolean('Match whole words only (word boundary anchoring)'),
  dryRun: defaultFalseBoolean(
    'Preview replacements without writing to disk (default: false = apply changes)',
  ),
  returnDiff: defaultFalseBoolean('Include a unified diff of all changes in the response'),
  maxResults: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .default(DEFAULT_SEARCH_RESULTS)
    .describe('Maximum total match count across all files before stopping'),
  maxFiles: z
    .uint32()
    .min(1)
    .max(MAX_SEARCH_RESULTS)
    .optional()
    .describe('Maximum number of files to process'),
  maxDepth: maxDepthField(),
});

const SearchAndReplaceOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; per-file errors are in failures[]'),
  filesModified: NonNegInt.describe('Number of files that had at least one replacement applied'),
  totalMatches: NonNegInt.describe('Total number of replacements made across all files'),
  processedFiles: NonNegInt.describe('Total number of files examined'),
  failedFiles: NonNegInt.optional().describe('Number of files that could not be processed'),
  failures: z
    .array(
      z.strictObject({
        path: z.string(),
        error: PerFileErrorSchema,
      }),
    )
    .optional()
    .describe('Per-file error details for files that could not be processed'),
  primaryFile: z
    .strictObject({
      path: z.string(),
      size: NonNegInt,
      lineCount: NonNegInt,
      mimeType: z.string(),
      kind: FileKind,
      resourceUri: z.string(),
    })
    .optional()
    .describe('Metadata for the first modified file including its resource URI'),
  results: z
    .array(z.strictObject({ path: z.string(), matches: NonNegInt }))
    .optional()
    .describe('List of modified files with their replacement counts'),
  resultsTruncated: z
    .boolean()
    .optional()
    .describe('True when the results list was cut due to the MAX_CHANGED_FILES cap'),
  diff: z
    .string()
    .optional()
    .describe('Unified diff of all changes (present when returnDiff=true or dryRun=true)'),
  diffTruncated: z
    .boolean()
    .optional()
    .describe('True when the diff was cut due to the size limit'),
  stoppedReason: StoppedReasonSchema.describe(
    'Why enumeration stopped early: maxResults = match cap reached, maxFiles = file cap reached, timeout = time limit hit or the request was cancelled. Absent when every matching file was enumerated. Files already dispatched still complete, so this marks the sweep incomplete, not the writes partial.',
  ),
});

const MAX_FAILURES = 20;
const REPLACE_CONCURRENCY = Math.min(PARALLEL_CONCURRENCY, 8);
const MAX_CHANGED_FILES = 100;
const MAX_DIFF_SIZE = 20 * 1024; // 20KB limit for diff output
const DIFF_APPEND_BUFFER = 1024;

interface Failure {
  path: string;
  error: NonNullable<z.infer<typeof SearchAndReplaceOutputSchema>['failures']>[number]['error'];
}

function recordFailure(failures: Failure[], failure: Failure): void {
  if (failures.length >= MAX_FAILURES) return;
  failures.push(failure);
}

function recordChangedFile(summary: ReplaceSummary, filePath: string, matchCount: number): void {
  const relativePath = toPosixRelative(summary.root, filePath);
  if (summary.changedFiles.length < MAX_CHANGED_FILES) {
    summary.changedFiles.push({ path: relativePath, matches: matchCount });
    return;
  }
  summary.changedFilesTruncated = true;
}

interface ReplacementMatcher {
  count(content: string): number;
  replace(content: string, replacement: string): string;
  testBuffer(buffer: Buffer): boolean;
  /** Releases any compiled pattern this matcher owns. Idempotent. */
  dispose(): void;
}

const DOLLAR_TOKEN = /\$(\$|&|`|'|<([^>]*)>|\d{1,2})/g;

/**
 * Expand `$`-substitutions in a replacement template the way `RegExp` does.
 *
 * We cannot hand the template to RE2's own string replacer: it throws
 * `Invalid replacement string` on any `$` not followed by a substitution it
 * recognises (so a replacement of `$100` or a trailing `$` fails outright,
 * where `RegExp` inserts the `$` literally), and it renders an out-of-range
 * `$5` as `$4`. Passing a function to `String.replace` disables RE2's handling
 * entirely, which leaves this the single owner of the syntax.
 */
function expandDollarTokens(
  template: string,
  match: string,
  groups: (string | undefined)[],
  offset: number,
  input: string,
  named: Record<string, string> | undefined,
): string {
  return template.replace(DOLLAR_TOKEN, (token: string, kind: string, name?: string) => {
    if (kind === '$') return '$';
    if (kind === '&') return match;
    if (kind === '`') return input.slice(0, offset);
    if (kind === "'") return input.slice(offset + match.length);
    if (name !== undefined) return named?.[name] ?? token;
    // `$12` prefers group 12, then falls back to group 1 followed by a literal
    // `2`, and stays literal when neither exists — RegExp's own precedence.
    const two = Number.parseInt(kind, 10);
    if (kind.length === 2 && two >= 1 && two <= groups.length) return groups[two - 1] ?? '';
    const one = Number.parseInt(kind.slice(0, 1), 10);
    if (one >= 1 && one <= groups.length) {
      return (groups[one - 1] ?? '') + (kind.length === 2 ? kind.slice(1) : '');
    }
    return token;
  });
}

export function createRegexReplacementMatcher(
  regex: Regex,
  expandReplacement: boolean,
): ReplacementMatcher {
  return {
    testBuffer(buffer: Buffer): boolean {
      // The regex is global and shared across every file in the batch, so a
      // previous file's match would otherwise start this scan mid-string.
      regex.lastIndex = 0;
      return regex.test(buffer.toString('utf-8'));
    },
    count(content: string): number {
      regex.lastIndex = 0;
      let matchCount = 0;
      let m: ReturnType<Regex['exec']>;
      while ((m = regex.exec(content)) !== null) {
        matchCount++;
        // Treat an absent group 0 as zero-length: not bumping lastIndex here
        // would spin forever.
        if ((m[0]?.length ?? 0) === 0) regex.lastIndex++;
      }
      return matchCount;
    },
    replace(content: string, replacement: string): string {
      regex.lastIndex = 0;
      // Only isRegex=true opts into $1/$& substitution. A literal search reaches
      // this matcher too (case-insensitive and wholeWord both need a regex), and
      // there the replacement must be inserted verbatim.
      if (!expandReplacement) return content.replace(regex, () => replacement);
      return content.replace(regex, (match: string, ...rest: unknown[]): string => {
        // RE2 calls back with (match, ...groups, offset, input, namedGroups).
        const named = rest.pop() as Record<string, string> | undefined;
        const input = rest.pop() as string;
        const offset = rest.pop() as number;
        return expandDollarTokens(
          replacement,
          match,
          rest as (string | undefined)[],
          offset,
          input,
          named,
        );
      });
    },
    dispose(): void {
      freeRegex(regex);
    },
  };
}

function createCaseSensitiveLiteralMatcher(searchPattern: string): ReplacementMatcher {
  const patternLength = searchPattern.length;
  const searchBuffer = Buffer.from(searchPattern, 'utf8');

  return {
    testBuffer(buffer: Buffer): boolean {
      return buffer.indexOf(searchBuffer) !== -1;
    },
    count(content: string): number {
      let matchCount = 0;
      let pos = content.indexOf(searchPattern);
      while (pos !== -1) {
        matchCount++;
        pos = content.indexOf(searchPattern, pos + patternLength);
      }
      return matchCount;
    },
    replace(content: string, replacement: string): string {
      return content.replaceAll(searchPattern, () => replacement);
    },
    dispose(): void {
      // no compiled pattern to release
    },
  };
}

type SearchAndReplaceArgs = z.infer<typeof SearchAndReplaceInputSchema>;
type SearchAndReplaceOutput = z.infer<typeof SearchAndReplaceOutputSchema>;

interface ReplaceContext {
  options: { dryRun: boolean; returnDiff: boolean };
  replacement: string;
  matcher: ReplacementMatcher;
  maxFileSize: number;
  signal: AbortSignal | undefined;
  summary: ReplaceSummary;
  fs: GuardedFileSystem;
}

interface ReplacementPlan {
  matchCount: number;
  originalContent: string;
  updatedContent: string;
}

function buildReplacementPlan(
  content: string,
  replacement: string,
  matcher: ReplacementMatcher,
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

async function processEntry(entryPath: string, ctx: ReplaceContext): Promise<void> {
  const { options, signal, summary } = ctx;
  const validPath = entryPath;

  try {
    const plan = await readReplacementPlan(validPath, ctx);
    if (!plan) {
      return;
    }

    if (!options.dryRun) {
      await ctx.fs.writeFile(entryPath, plan.updatedContent, {
        encoding: 'utf-8',
        signal,
      });
    }

    // Bookkeep only after the write succeeds (or in dryRun, where there is no
    // write): a failed write must not count the file as changed.
    summary.totalMatches += plan.matchCount;
    summary.filesChanged++;

    recordChangedFile(summary, validPath, plan.matchCount);

    await maybeAppendPatchDiff(summary, {
      filePath: validPath,
      originalContent: plan.originalContent,
      updatedContent: plan.updatedContent,
      includeDiff: options.dryRun || options.returnDiff,
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    summary.failedFiles++;
    recordFailure(summary.failures, {
      path: toPosixRelative(summary.root, validPath),
      error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, validPath),
    });
  }
}

async function readReplacementPlan(
  validPath: string,
  ctx: ReplaceContext,
): Promise<ReplacementPlan | undefined> {
  const { matcher, replacement, maxFileSize, signal } = ctx;
  await using fileHandle = await ctx.fs.open(validPath, 'r');
  const stats = await fileHandle.stat();
  if (stats.size > maxFileSize) {
    throw new FsError(
      ErrorCode.TOO_LARGE,
      `File too large: ${validPath} (${String(stats.size)} bytes > ${String(maxFileSize)} bytes)`,
    );
  }

  const buffer = await readFileBufferWithLimit(fileHandle, maxFileSize, validPath, signal);
  if (!matcher.testBuffer(buffer)) return undefined;

  return buildReplacementPlan(buffer.toString('utf-8'), replacement, matcher);
}

async function maybeAppendPatchDiff(
  summary: ReplaceSummary,
  params: {
    filePath: string;
    originalContent: string;
    updatedContent: string;
    includeDiff: boolean;
    signal?: AbortSignal;
  },
): Promise<void> {
  if (!params.includeDiff) return;
  const header = toPosixRelative(summary.root, params.filePath);

  const patch = await buildPatchDiff(header, params.originalContent, params.updatedContent);

  if (summary.diff.length >= MAX_DIFF_SIZE) {
    summary.diffTruncated = true;
    return;
  }

  if (summary.diff.length + patch.length <= MAX_DIFF_SIZE + DIFF_APPEND_BUFFER) {
    summary.diff += patch;
    return;
  }

  summary.diffTruncated = true;
}

/** Exported for unit tests: the four exit reasons are the contract worth pinning. */
export async function processEntriesConcurrently(
  entries: AsyncIterable<{ path: string }>,
  options: {
    signal: AbortSignal | undefined;
    concurrency: number;
    maxEntries?: number;
    shouldStop?: () => boolean;
    onEntry: () => void;
    onError?: (entryPath: string, err: unknown) => void;
    runEntry: (entryPath: string) => Promise<void>;
  },
): Promise<{ stoppedByLimit: boolean; stoppedByMatchCap: boolean; stoppedByAbort: boolean }> {
  const pending = new Set<Promise<void>>();
  const { signal, concurrency, maxEntries, shouldStop, onEntry, onError, runEntry } = options;
  let dispatched = 0;
  let stoppedByLimit = false;
  let stoppedByMatchCap = false;
  let stoppedByAbort = false;

  const waitForSlot = async (): Promise<void> => {
    if (pending.size < concurrency) return;
    await Promise.race(pending);
  };

  for await (const entry of entries) {
    // The signal is cancellation OR the tool's timeout: stop dispatching and
    // let the caller report the run as incomplete rather than as a full sweep.
    if (signal?.aborted) {
      stoppedByAbort = true;
      break;
    }
    if (maxEntries !== undefined && dispatched >= maxEntries) {
      stoppedByLimit = true;
      break;
    }
    // Check the match cap before waiting for a slot so an in-flight task that
    // already crossed the cap stops dispatch without an extra wait...
    if (shouldStop?.()) {
      stoppedByMatchCap = true;
      break;
    }
    await waitForSlot();
    // ...and again after the slot frees, since tasks settle concurrently. The
    // cap can still be exceeded by at most `concurrency - 1` already-dispatched
    // tasks that are mid-flight; that overrun is inherent to concurrent dispatch.
    if (shouldStop?.()) {
      stoppedByMatchCap = true;
      break;
    }
    onEntry();
    dispatched++;

    // Track a non-rejecting wrapper so a rejected task can never propagate out of
    // Promise.race(pending) in waitForSlot() and abort the loop before the final
    // drain below (which would silently abandon other in-flight tasks).
    // processEntry catches all expected errors internally; if it unexpectedly
    // throws, record it as a failure rather than silently dropping it.
    const tracked = runEntry(entry.path).catch((err: unknown) => {
      onError?.(entry.path, err);
    });
    pending.add(tracked);
    void tracked.finally(() => {
      pending.delete(tracked);
    });
  }

  if (pending.size > 0) {
    await Promise.allSettled([...pending]);
  }

  return { stoppedByLimit, stoppedByMatchCap, stoppedByAbort };
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
  stoppedReason?: StoppedReason;
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
  fs: GuardedFileSystem,
): Promise<{ root: string; singleFile?: string }> {
  if (!pathValue) {
    return { root: fs.pathGuard.resolvePathOrRoot(undefined) };
  }
  const resolvedPath = await fs.pathGuard.validateExistingPath(pathValue);
  const { stats: fileStats } = await fs.stat(resolvedPath);
  if (fileStats.isFile()) {
    // A single explicit file target bypasses the glob machinery entirely:
    // routing it through globEntries with baseNameMatch would rewrite the
    // escaped basename to `**/${basename}` and match every same-named file
    // under the parent tree, not just this one.
    return {
      root: dirname(resolvedPath),
      singleFile: resolvedPath,
    };
  }
  return { root: resolvedPath };
}

function buildSearchPattern(args: SearchAndReplaceArgs): string {
  if (args.isRegex) {
    return args.wholeWord ? `\\b(?:${args.searchPattern})\\b` : args.searchPattern;
  }
  const escaped = escapeRegexLiteral(args.searchPattern);
  return args.wholeWord ? `\\b(?:${escaped})\\b` : escaped;
}

function createReplacementMatcher(args: SearchAndReplaceArgs): ReplacementMatcher {
  // Use regex when isRegex, wholeWord, or case-insensitive (all require RE2)
  if (args.isRegex || args.wholeWord || !args.caseSensitive) {
    const regex = compileRegex(buildSearchPattern(args), { caseSensitive: args.caseSensitive });
    return createRegexReplacementMatcher(regex, args.isRegex);
  }
  return createCaseSensitiveLiteralMatcher(args.searchPattern);
}

async function handleSearchAndReplace(
  args: SearchAndReplaceArgs,
  fsOps: GuardedFileSystem,
  signal?: AbortSignal,
  onProgress: (progress: { total?: number; current: number }) => void = () => undefined,
  resourceStore?: ResourceStore,
): Promise<{
  structured: SearchAndReplaceOutput;
  link?: ContentBlock;
}> {
  const maxFileSize = MAX_TEXT_FILE_SIZE;
  const { root, singleFile } = await resolveSearchRoot(args.path, fsOps);
  const effectivePattern = args.pattern ?? '**/*';

  // An explicit single-file target bypasses baseNameMatch/exclude/hidden/
  // gitignore filtering — it should always be processed as the one file named.
  // The async generator matches globEntries' AsyncIterable contract; it needs
  // no await (single yield), hence the disable.
  const entries: AsyncIterable<{ path: string }> = singleFile
    ? // eslint-disable-next-line @typescript-eslint/require-await
      (async function* singleFileEntry() {
        yield { path: singleFile };
      })()
    : globEntries({
        cwd: root,
        pattern: effectivePattern,
        excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
        includeHidden: args.includeHidden,
        respectGitignore: !args.includeIgnored,
        baseNameMatch: true,
        onlyFiles: true,
        suppressErrors: true,
        ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
      });

  const summary = createReplaceSummary(root);

  // The matcher may own a compiled RE2 pattern, whose wasm memory re2-wasm
  // never reclaims on its own. Nothing past the scan touches it, so free it the
  // moment the scan is done — success, failure, or abort alike.
  const matcher = createReplacementMatcher(args);
  let scan: Awaited<ReturnType<typeof processEntriesConcurrently>>;
  try {
    const context: ReplaceContext = {
      options: {
        dryRun: args.dryRun,
        returnDiff: args.returnDiff,
      },
      replacement: args.replacement,
      matcher,
      maxFileSize,
      signal,
      summary,
      fs: fsOps,
    };

    scan = await processEntriesConcurrently(entries, {
      signal,
      concurrency: REPLACE_CONCURRENCY,
      ...(args.maxFiles !== undefined ? { maxEntries: args.maxFiles } : {}),
      shouldStop: () => summary.totalMatches >= args.maxResults,
      onEntry: () => {
        summary.processedFiles++;
        onProgress({ current: summary.processedFiles });
      },
      onError: (entryPath, err) => {
        summary.failedFiles++;
        recordFailure(summary.failures, {
          path: toPosixRelative(summary.root, entryPath),
          error: Problem.fromUnknown(err, ErrorCode.UNKNOWN, entryPath),
        });
      },
      runEntry: (entryPath) => processEntry(entryPath, context),
    });
  } finally {
    matcher.dispose();
  }
  const { stoppedByLimit, stoppedByMatchCap, stoppedByAbort } = scan;

  // Mutually exclusive by construction — the loop exits on exactly one of them.
  if (stoppedByLimit) {
    summary.stoppedReason = 'maxFiles';
  } else if (stoppedByMatchCap) {
    summary.stoppedReason = 'maxResults';
  } else if (stoppedByAbort) {
    summary.stoppedReason = 'timeout';
  }

  onProgress({ current: summary.processedFiles });

  if (!args.dryRun && summary.totalMatches > 0) {
    Logger.info(
      `search_and_replace: ${summary.filesChanged} file(s), ${summary.totalMatches} match(es)`,
    );
  }

  const structured = buildSearchAndReplaceStructuredResult(summary, args);

  // Store primary file in resource store if available
  if (resourceStore && summary.changedFiles.length > 0 && summary.filesChanged > 0) {
    const primaryFile = summary.changedFiles[0];
    if (!primaryFile) return { structured };

    const primaryFilePath = primaryFile.path;
    const fullPath = join(summary.root, primaryFilePath);

    try {
      const content = await (async (): Promise<string> => {
        const fd = await fsOps.open(fullPath, 'r');
        try {
          const buffer = await readFileBufferWithLimit(fd, maxFileSize, fullPath, signal);
          return buffer.toString('utf-8');
        } finally {
          await fd.close();
        }
      })();

      const mimeInfo = detectMimeFromContent(fullPath, content);
      const lineCount = countLines(content);
      const size = Buffer.byteLength(content, 'utf-8');

      const fileUri = buildFileResourceUri(fullPath);
      const link = buildFileResourceLink(fullPath, mimeInfo.mimeType, size);

      structured.primaryFile = {
        path: primaryFilePath,
        size,
        lineCount,
        mimeType: mimeInfo.mimeType,
        kind: mimeInfo.kind,
        resourceUri: fileUri,
      };

      return { structured, link };
    } catch (error) {
      rethrowIfAborted(error);
      // Gracefully fall back if resource storage fails
      Logger.error(
        `Failed to store primary file in resource store: ${formatUnknownErrorMessage(error)}`,
      );
    }
  }

  return { structured };
}

export const SEARCH_AND_REPLACE = defineTool({
  name: 'replace_text',
  title: 'Search and Replace',
  description:
    'Bulk search-and-replace across files matching a glob pattern. ' +
    'Replaces ALL occurrences per file (unlike edit, which replaces only the first match). ' +
    'Set returnDiff=true to preview changes as a unified diff before or after writing. ' +
    'Literal matching by default; set isRegex=true to enable RE2 regex with capture groups ($1, $2).',
  input: SearchAndReplaceInputSchema,
  output: SearchAndReplaceOutputSchema,
  annotations: {
    readOnlyHint: false,
    idempotentHint: false,
    destructiveHint: true,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.UNKNOWN,
  progress: (args) => {
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    return {
      label: `Replace${dryLabel}`,
      subject: `${truncateProgressPattern(args.searchPattern)} → ${truncateProgressPattern(args.replacement)}`,
    };
  },
  run: async (args, ctx) => {
    const truncatedPattern = truncateProgressPattern(args.searchPattern);
    const onProgress = (params: { current: number; total?: number }): void => {
      ctx.onProgress?.({
        current: params.current,
        ...(params.total !== undefined ? { total: params.total } : {}),
      });
    };
    const { structured, link } = await handleSearchAndReplace(
      args,
      ctx.fs,
      ctx.signal,
      onProgress,
      ctx.resourceStore,
    );
    if (!args.dryRun) {
      ctx.log?.(
        'info',
        `search_and_replace: ${String(structured.totalMatches)} matches in ${String(structured.filesModified)} files`,
        'search_and_replace',
      );
    }
    const dryLabel = args.dryRun ? ' [dry run]' : '';
    const summaryText =
      `replace_text: '${truncatedPattern}'${dryLabel}` +
      ` \u00b7 ${String(structured.totalMatches)} match(es)` +
      ` in ${String(structured.filesModified)} file(s)`;
    if (link) {
      return { structured, text: summaryText, resources: [link] };
    }
    return { structured, text: summaryText };
  },
});
function buildSearchAndReplaceStructuredResult(
  summary: ReplaceSummary,
  args: SearchAndReplaceArgs,
): SearchAndReplaceOutput {
  return {
    ok: true,
    filesModified: summary.filesChanged,
    totalMatches: summary.totalMatches,
    processedFiles: summary.processedFiles,
    ...(summary.failedFiles > 0 ? { failedFiles: summary.failedFiles } : {}),
    ...(summary.failures.length > 0 ? { failures: summary.failures } : {}),
    ...(summary.changedFiles.length > 0 ? { results: summary.changedFiles } : {}),
    ...(summary.changedFilesTruncated ? { resultsTruncated: true } : {}),
    ...((args.dryRun || args.returnDiff) && summary.diff ? { diff: summary.diff } : {}),
    ...(summary.diffTruncated ? { diffTruncated: true } : {}),
    ...(summary.stoppedReason ? { stoppedReason: summary.stoppedReason } : {}),
  };
}
