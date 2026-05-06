import type { McpServer } from '@modelcontextprotocol/server';

import { relative } from 'node:path';

import RE2 from 're2';
import type { z } from 'zod/v4';

import { DEFAULT_EXCLUDE_PATTERNS, parseEnvInt } from '../lib/constants.js';
import {
  classifyError,
  ErrorCode,
  formatUnknownErrorMessage,
  McpError,
} from '../lib/errors.js';
import {
  searchContent,
  type SearchContentOptions,
} from '../lib/file-operations/search.js';

import { formatOperationSummary } from '../config.js';
import {
  SearchContentInputSchema,
  SearchContentOutputSchema,
} from '../schemas.js';
import { SEARCH_ICONS } from './icons.js';
import {
  buildResourceLink,
  buildToolErrorResponse,
  buildToolResponse,
  createToolProgressSession,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
  resolvePathOrRoot,
  type ToolContext,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
  truncateProgressPattern,
} from './shared.js';
import { registerStandardTool, reportTaskStatus } from './task-support.js';

/**
 * Configuration constants for the Search Content tool.
 */
const CONFIG = {
  MAX_INLINE_MATCHES: parseEnvInt(
    'FS_CONTEXT_MAX_INLINE_MATCHES',
    50,
    1,
    10_000
  ),
  COMPLETION_LABELS: {
    timeout: 'timeout',
    maxResults: 'max results',
    maxFiles: 'max files',
  } as const,
} as const;

// Type Definitions
type SearchInput = z.infer<typeof SearchContentInputSchema>;
type SearchOutput = z.infer<typeof SearchContentOutputSchema>;
type SearchMatchPayload = NonNullable<SearchOutput['matches']>[number];
type SearchResultValue = Awaited<ReturnType<typeof searchContent>>;
type SearchSummary = SearchResultValue['summary'];
type TruthySummaryField =
  | 'filesMatched'
  | 'skippedTooLarge'
  | 'skippedBinary'
  | 'skippedInaccessible';

interface SearchPreviewState {
  needsExternalize: boolean;
  visiblePayloads: SearchMatchPayload[];
  heading: string;
}

interface SearchContext {
  pattern: string;
  matcher?: RE2;
  caseSensitive: boolean;
  foldedPattern?: string;
}

const TRUTHY_SUMMARY_FIELDS: readonly TruthySummaryField[] = [
  'filesMatched',
  'skippedTooLarge',
  'skippedBinary',
  'skippedInaccessible',
];

function buildStructuredSummaryFields(
  summary: SearchSummary
): Partial<SearchOutput> {
  const result: Partial<SearchOutput> = {};
  for (const key of TRUTHY_SUMMARY_FIELDS) {
    const value = summary[key];
    if (value) {
      result[key] = value;
    }
  }
  if (summary.truncated) {
    result.truncated = true;
  }
  if (summary.stoppedReason) {
    result.stoppedReason = summary.stoppedReason;
  }
  return result;
}

function buildCompletionSuffix(
  count: number,
  filesMatched: number,
  scope: SearchInput['filePattern'],
  stoppedReason?: SearchSummary['stoppedReason']
): string {
  if (count === 0) return `No matches in ${scope}`;

  const matchWord = count === 1 ? 'match' : 'matches';
  const fileWord = filesMatched === 1 ? 'file' : 'files';
  const reasonSuffix =
    stoppedReason !== undefined
      ? ` [${CONFIG.COMPLETION_LABELS[stoppedReason]}]`
      : '';

  return `${count} ${matchWord} in ${filesMatched} ${fileWord}${reasonSuffix}`;
}

function buildSearchPreviewState(
  payloads: SearchMatchPayload[]
): SearchPreviewState {
  const needsExternalize = payloads.length > CONFIG.MAX_INLINE_MATCHES;
  const visibleCount = needsExternalize
    ? CONFIG.MAX_INLINE_MATCHES
    : payloads.length;

  return {
    needsExternalize,
    visiblePayloads: payloads.slice(0, visibleCount),
    heading: buildHeading(payloads.length, visibleCount),
  };
}

export const SEARCH_CONTENT_TOOL: ToolContract = {
  name: 'grep',
  title: 'Search Content',
  description:
    'Search file contents for text (grep-like). Returns matching lines. ' +
    'Scope with `filePattern` (e.g. `**/*.ts`) to reduce noise. ' +
    '`includeHidden=true` for dotfiles.',
  inputSchema: SearchContentInputSchema,
  outputSchema: SearchContentOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: SEARCH_ICONS,
  nuances: [
    'Inline results capped at 50 matches; full results via `resourceUri`.',
  ],
  gotchas: [
    'Skips binary/oversized files silently — verify with `stat` if no matches.',
  ],
  taskSupport: 'optional',
} as const;

function buildHeading(totalMatches: number, visibleMatches: number): string {
  if (visibleMatches >= totalMatches) {
    return `Found ${totalMatches}:`;
  }

  return `Found ${totalMatches} (showing first ${visibleMatches}):`;
}

function buildSearchText(
  heading: string,
  matches: readonly SearchMatchPayload[],
  summary?: SearchSummary
): string {
  if (matches.length === 0) return 'No matches';

  const text = buildMatchList(heading, matches);
  if (!summary) return text;

  const summaryOpts = {
    truncated: summary.truncated,
    ...(summary.truncated
      ? { truncatedReason: resolveTruncatedReason(summary) }
      : {}),
  };

  return text + formatOperationSummary(summaryOpts);
}

function buildSearchStructured(
  summary: SearchSummary,
  matches: SearchMatchPayload[]
): SearchOutput {
  return {
    ok: true,
    matches,
    totalMatches: summary.matches,
    filesScanned: summary.filesScanned,
    ...buildStructuredSummaryFields(summary),
  };
}

function buildSortedPayloads(
  result: SearchResultValue,
  context: SearchContext
): SearchMatchPayload[] {
  const relativeByFile = new Map<string, string>();

  const getRelativeFile = (file: string): string => {
    const cached = relativeByFile.get(file);
    if (cached !== undefined) return cached;

    const rel = relative(result.basePath, file);
    relativeByFile.set(file, rel);
    return rel;
  };

  const payloads = result.matches.map((match, originalIndex) => {
    const relFile = getRelativeFile(match.file);
    const column = findColumnOffset(match.content, context);

    const payload: SearchMatchPayload = {
      file: relFile,
      line: match.line,
      ...(column !== undefined ? { column } : {}),
      content: match.content,
      matchCount: match.matchCount,
      ...(match.contextBefore
        ? { contextBefore: [...match.contextBefore] }
        : {}),
      ...(match.contextAfter ? { contextAfter: [...match.contextAfter] } : {}),
    };

    return { payload, originalIndex };
  });

  payloads.sort((left, right) => {
    const fileCompare = left.payload.file.localeCompare(right.payload.file);
    if (fileCompare !== 0) return fileCompare;
    if (left.payload.line !== right.payload.line)
      return left.payload.line - right.payload.line;
    return left.originalIndex - right.originalIndex;
  });

  return payloads.map((p) => p.payload);
}

function buildMatchList(
  heading: string,
  matches: readonly SearchMatchPayload[]
): string {
  if (matches.length === 0) return heading;
  const parts: string[] = [heading];
  for (const match of matches) {
    parts.push(
      `\n  ${match.file}:${String(match.line).padStart(4)}: ${match.content}`
    );
  }

  return parts.join('');
}

function resolveTruncatedReason(summary: SearchSummary): string {
  if (summary.stoppedReason === 'timeout') return 'timeout';
  if (summary.stoppedReason === 'maxFiles') {
    return `max files (${summary.filesScanned})`;
  }
  return `max results (${summary.matches})`;
}

function findColumnOffset(
  content: string,
  context: SearchContext
): number | undefined {
  try {
    if (context.matcher) {
      context.matcher.lastIndex = 0;
      const match = context.matcher.exec(content);
      return match ? match.index : undefined;
    }
    if (context.caseSensitive) {
      const idx = content.indexOf(context.pattern);
      return idx >= 0 ? idx : undefined;
    }
    // Case-insensitive literal search
    const idx = content.toLowerCase().indexOf(context.foldedPattern ?? '');
    return idx >= 0 ? idx : undefined;
  } catch {
    return undefined;
  }
}

async function executeSearch(
  args: SearchInput,
  basePath: string,
  signal?: AbortSignal,
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<SearchResultValue> {
  const excludePatterns = args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;

  const options: SearchContentOptions = {
    includeHidden: args.includeHidden,
    excludePatterns,
    filePattern: args.filePattern,
    caseSensitive: args.caseSensitive,
    wholeWord: args.wholeWord,
    contextLines: args.contextLines,
    maxResults: args.maxResults,
    isLiteral: !args.isRegex,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  };

  try {
    return await searchContent(basePath, args.pattern, options);
  } catch (error) {
    if (error instanceof Error && /regular expression/i.test(error.message)) {
      throw new McpError(
        ErrorCode.INVALID_PATTERN,
        `Invalid regex pattern: ${formatUnknownErrorMessage(error)} (RE2: no lookahead/lookbehind/backrefs)`
      );
    }
    throw error;
  }
}

function createSearchMatcher(args: SearchInput): RE2 | undefined {
  if (!args.isRegex) return undefined;
  try {
    const flags = args.caseSensitive ? '' : 'i';
    return new RE2(args.pattern, flags);
  } catch (error) {
    throw new McpError(
      ErrorCode.INVALID_PATTERN,
      `Invalid regex pattern: ${formatUnknownErrorMessage(error)} (RE2: no lookahead/lookbehind/backrefs)`
    );
  }
}

function createSearchContext(
  args: SearchInput,
  matcher: RE2 | undefined
): SearchContext {
  return {
    pattern: args.pattern,
    caseSensitive: args.caseSensitive,
    ...(matcher ? { matcher } : {}),
    ...(!args.isRegex && !args.caseSensitive
      ? { foldedPattern: args.pattern.toLowerCase() }
      : {}),
  };
}

async function handleSearchContent(
  args: SearchInput,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<ToolResponse<SearchOutput>> {
  const basePath = resolvePathOrRoot(args.path);
  const regexMatcher = createSearchMatcher(args);

  const result = await executeSearch(args, basePath, signal, onProgress);
  const searchContext = createSearchContext(args, regexMatcher);

  const matchPayloads = buildSortedPayloads(result, searchContext);

  const fullStructured = buildSearchStructured(result.summary, matchPayloads);

  const preview = buildSearchPreviewState(matchPayloads);

  if (resourceStore && preview.needsExternalize) {
    const previewStructured: SearchOutput = {
      ...fullStructured,
      matches: preview.visiblePayloads,
      truncated: true,
    };

    const entry = resourceStore.putText({
      name: 'grep:matches',
      mimeType: 'application/json',
      text: JSON.stringify(fullStructured),
    });

    previewStructured.resourceUri = entry.uri;
    const text = buildSearchText(preview.heading, preview.visiblePayloads);

    return buildToolResponse(text, previewStructured, [
      buildResourceLink({
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
        description: 'Full grep results as JSON (structuredContent)',
        expiresAt: entry.expiresAt,
      }),
    ]);
  }

  const text = buildSearchText(
    preview.heading,
    preview.visiblePayloads,
    result.summary
  );

  return buildToolResponse(text, fullStructured);
}

export function registerSearchContentTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: SearchInput,
    ctx: ToolContext
  ): Promise<ToolResult<SearchOutput>> =>
    executeToolWithDiagnostics({
      toolName: 'grep',
      ctx,
      outputSchema: SearchContentOutputSchema,
      context: { path: args.path ?? '.' },
      run: async (signal) => {
        const { pattern, filePattern: scope } = args;
        const progressLabel = `${SEARCH_CONTENT_TOOL.title}: ${truncateProgressPattern(pattern)}`;
        const progress = createToolProgressSession(ctx, progressLabel);

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
            message: `${progressLabel} [${current} files]`,
          });
          void reportTaskStatus(`${progressLabel} ${current} files`);
        };

        try {
          const result = await handleSearchContent(
            args,
            signal,
            options.resourceStore,
            progressWithMessage
          );

          const sc = result.structuredContent;
          const { totalMatches = 0, filesMatched = 0, stoppedReason } = sc;
          const suffix = buildCompletionSuffix(
            totalMatches,
            filesMatched,
            scope,
            stoppedReason
          );

          const finalCurrent = resolveFinalProgressCurrent(
            progress,
            (sc.filesScanned ?? 0) + 1
          );

          progress.complete(`${progressLabel} • ${suffix}`, finalCurrent);
          return result;
        } catch (error) {
          progress.fail(`${progressLabel} • ${classifyError(error)}`);
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.UNKNOWN, args.path ?? '.'),
    });

  registerStandardTool(server, SEARCH_CONTENT_TOOL, handler, options);
}
