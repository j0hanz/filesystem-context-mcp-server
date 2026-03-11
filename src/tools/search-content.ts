import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import RE2 from 're2';
import type { z } from 'zod';

import { DEFAULT_EXCLUDE_PATTERNS } from '../lib/constants.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  McpError,
} from '../lib/errors.js';
import type { SearchContentOptions } from '../lib/file-operations/search.js';
import { searchContent } from '../lib/file-operations/search.js';

import { formatOperationSummary } from '../config.js';
import {
  SearchContentInputSchema,
  SearchContentOutputSchema,
} from '../schemas.js';
import {
  buildResourceLink,
  buildToolErrorResponse,
  buildToolResponse,
  createToolProgressSession,
  executeToolWithDiagnostics,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolveFinalProgressCurrent,
  resolvePathOrRoot,
  type ToolContract,
  type ToolExtra,
  type ToolRegistrationOptions,
  type ToolResponse,
  type ToolResult,
  truncateProgressPattern,
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';
import { registerToolTaskIfAvailable } from './task-support.js';

/**
 * Configuration constants for the Search Content tool.
 */
const CONFIG = {
  MAX_INLINE_MATCHES:
    parseInt(process.env['FS_CONTEXT_MAX_INLINE_MATCHES'] ?? '', 10) || 50,
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

type NormalizedSearchMatch = SearchResultValue['matches'][number] & {
  relativeFile: string;
  index: number;
};

interface SearchPreviewState {
  needsExternalize: boolean;
  visibleMatches: NormalizedSearchMatch[];
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
      result[key] = value as never;
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

function compareNormalizedMatches(
  left: NormalizedSearchMatch,
  right: NormalizedSearchMatch
): number {
  const fileCompare = left.relativeFile.localeCompare(right.relativeFile);
  if (fileCompare !== 0) return fileCompare;
  if (left.line !== right.line) return left.line - right.line;
  return left.index - right.index;
}

function buildSearchPreviewState(
  matches: NormalizedSearchMatch[],
  payloads: SearchMatchPayload[]
): SearchPreviewState {
  const needsExternalize = matches.length > CONFIG.MAX_INLINE_MATCHES;
  const visibleCount = needsExternalize
    ? CONFIG.MAX_INLINE_MATCHES
    : matches.length;
  const visibleMatches = matches.slice(0, visibleCount);

  return {
    needsExternalize,
    visibleMatches,
    visiblePayloads: payloads.slice(0, visibleCount),
    heading: buildHeading(matches.length, visibleMatches.length),
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
  matches: readonly NormalizedSearchMatch[],
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

function normalizeMatches(result: SearchResultValue): NormalizedSearchMatch[] {
  const relativeByFile = new Map<string, string>();

  const getRelativeFile = (file: string): string => {
    const cached = relativeByFile.get(file);
    if (cached !== undefined) return cached;

    const relative = path.relative(result.basePath, file);
    relativeByFile.set(file, relative);
    return relative;
  };

  return result.matches
    .map(
      (match, index): NormalizedSearchMatch => ({
        ...match,
        relativeFile: getRelativeFile(match.file),
        index,
      })
    )
    .sort(compareNormalizedMatches);
}

function buildMatchPayloads(
  matches: readonly NormalizedSearchMatch[],
  context: SearchContext
): SearchMatchPayload[] {
  return matches.map((match) => {
    const column = findColumnOffset(match.content, context);
    return {
      file: match.relativeFile,
      line: match.line,
      ...(column !== undefined ? { column } : {}),
      content: match.content,
      matchCount: match.matchCount,
      ...(match.contextBefore
        ? { contextBefore: [...match.contextBefore] }
        : {}),
      ...(match.contextAfter ? { contextAfter: [...match.contextAfter] } : {}),
    };
  });
}

function buildMatchList(
  heading: string,
  matches: readonly NormalizedSearchMatch[]
): string {
  if (matches.length === 0) return heading;
  const parts: string[] = [heading];
  for (const match of matches) {
    parts.push(
      `\n  ${match.relativeFile}:${String(match.line).padStart(4)}: ${match.content}`
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
      throw new McpError(ErrorCode.E_INVALID_PATTERN, error.message);
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
      ErrorCode.E_INVALID_PATTERN,
      `Invalid regex pattern: ${formatUnknownErrorMessage(error)}`
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

  const normalizedMatches = normalizeMatches(result);
  const searchContext = createSearchContext(args, regexMatcher);

  const matchPayloads = buildMatchPayloads(normalizedMatches, searchContext);

  const fullStructured = buildSearchStructured(result.summary, matchPayloads);

  const preview = buildSearchPreviewState(normalizedMatches, matchPayloads);

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
    const text = buildSearchText(preview.heading, preview.visibleMatches);

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
    preview.visibleMatches,
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
    extra: ToolExtra
  ): Promise<ToolResult<SearchOutput>> =>
    executeToolWithDiagnostics({
      toolName: 'grep',
      extra,
      outputSchema: SearchContentOutputSchema,
      context: { path: args.path ?? '.' },
      run: async (signal) => {
        const { pattern, filePattern: scope } = args;
        const progressLabel = `🔎︎ grep: ${truncateProgressPattern(pattern)}`;
        const progress = createToolProgressSession(extra, progressLabel);

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
        };

        try {
          const result = await handleSearchContent(
            args,
            signal,
            options.resourceStore,
            progressWithMessage
          );

          const sc = result.structuredContent;
          const count = sc.ok && sc.totalMatches ? sc.totalMatches : 0;
          const filesMatched = sc.ok ? (sc.filesMatched ?? 0) : 0;
          const stoppedReason = sc.ok ? sc.stoppedReason : undefined;
          const suffix = buildCompletionSuffix(
            count,
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
          progress.fail(`${progressLabel} • failed`);
          throw error;
        }
      },
      onError: (error) =>
        buildToolErrorResponse(error, ErrorCode.E_UNKNOWN, args.path ?? '.'),
    });

  const { isInitialized } = options;
  const wrappedHandler = wrapToolHandler(handler, {
    guard: isInitialized,
  });

  const validatedHandler = withValidatedArgs(
    SearchContentInputSchema,
    wrappedHandler
  );

  if (
    registerToolTaskIfAvailable(
      server,
      'grep',
      SEARCH_CONTENT_TOOL,
      validatedHandler,
      options.iconInfo,
      isInitialized
    )
  )
    return;
  server.registerTool(
    'grep',
    withDefaultIcons({ ...SEARCH_CONTENT_TOOL }, options.iconInfo),
    validatedHandler
  );
}
