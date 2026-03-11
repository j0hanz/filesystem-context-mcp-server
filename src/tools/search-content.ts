import * as path from 'node:path';
import { performance } from 'node:perf_hooks';

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

let searchMetricSequence = 0;

// Type Definitions
type SearchInput = z.infer<typeof SearchContentInputSchema>;
type SearchOutput = z.infer<typeof SearchContentOutputSchema>;
type SearchMatchPayload = NonNullable<SearchOutput['matches']>[number];
type SearchResultValue = Awaited<ReturnType<typeof searchContent>>;
type SearchSummary = SearchResultValue['summary'];
type SearchPatternType = SearchOutput['patternType'];
type TruthySummaryField =
  | 'filesMatched'
  | 'skippedTooLarge'
  | 'skippedBinary'
  | 'skippedInaccessible'
  | 'linesSkippedDueToRegexTimeout';

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
  'linesSkippedDueToRegexTimeout',
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

function createSearchMetricNames(): {
  timerStartName: string;
  timerEndName: string;
  metricName: string;
} {
  searchMetricSequence += 1;
  const metricSuffix = `${Date.now()}_${searchMetricSequence}`;

  return {
    timerStartName: `searchContentStart_${metricSuffix}`,
    timerEndName: `searchContentEnd_${metricSuffix}`,
    metricName: `searchContent_${metricSuffix}`,
  };
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
    heading: SearchResponseBuilder.buildHeading(
      matches.length,
      visibleMatches.length
    ),
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

/**
 * Handles formatting and building the search response.
 */
const SearchResponseBuilder = {
  buildHeading(totalMatches: number, visibleMatches: number): string {
    if (visibleMatches >= totalMatches) {
      return `Found ${totalMatches}:`;
    }

    return `Found ${totalMatches} (showing first ${visibleMatches}):`;
  },

  buildText(
    heading: string,
    matches: readonly NormalizedSearchMatch[],
    summary?: SearchSummary
  ): string {
    if (matches.length === 0) return 'No matches';

    const text = this.buildMatchList(heading, matches);
    if (!summary) return text;

    const summaryOpts = {
      truncated: summary.truncated,
      ...(summary.truncated
        ? { truncatedReason: this.resolveTruncatedReason(summary) }
        : {}),
    };

    return text + formatOperationSummary(summaryOpts);
  },

  buildStructured(
    summary: SearchSummary,
    matches: SearchMatchPayload[],
    options: { patternType: SearchPatternType; caseSensitive: boolean }
  ): SearchOutput {
    return {
      ok: true,
      patternType: options.patternType,
      caseSensitive: options.caseSensitive,
      matches,
      totalMatches: summary.matches,
      filesScanned: summary.filesScanned,
      ...buildStructuredSummaryFields(summary),
    };
  },

  normalizeMatches(result: SearchResultValue): NormalizedSearchMatch[] {
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
  },

  buildMatchPayloads(
    matches: readonly NormalizedSearchMatch[],
    context: SearchContext
  ): SearchMatchPayload[] {
    return matches.map((match) => {
      const column = this.findColumnOffset(match.content, context);
      return {
        file: match.relativeFile,
        line: match.line,
        ...(column !== undefined ? { column } : {}),
        content: match.content,
        matchCount: match.matchCount,
        ...(match.contextBefore
          ? { contextBefore: [...match.contextBefore] }
          : {}),
        ...(match.contextAfter
          ? { contextAfter: [...match.contextAfter] }
          : {}),
      };
    });
  },

  buildMatchList(
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
  },

  resolveTruncatedReason(summary: SearchSummary): string {
    if (summary.stoppedReason === 'timeout') return 'timeout';
    if (summary.stoppedReason === 'maxFiles') {
      return `max files (${summary.filesScanned})`;
    }
    return `max results (${summary.matches})`;
  },

  findColumnOffset(
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
  },
};

const SearchExecutor = {
  async run(
    args: SearchInput,
    basePath: string,
    signal?: AbortSignal,
    onProgress?: (progress: { total?: number; current: number }) => void
  ): Promise<SearchResultValue> {
    const excludePatterns = args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;
    const { timerStartName, timerEndName, metricName } =
      createSearchMetricNames();

    const options: SearchContentOptions = {
      includeHidden: args.includeHidden,
      excludePatterns,
      filePattern: args.filePattern,
      caseSensitive: args.caseSensitive,
      wholeWord: args.wholeWord,
      contextLines: args.contextLines,
      maxResults: args.maxResults,
      isLiteral: !args.isRegex,
      multiline: args.multiline,
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
    };

    performance.mark(timerStartName);
    try {
      return await searchContent(basePath, args.pattern, options);
    } catch (error) {
      if (error instanceof Error && /regular expression/i.test(error.message)) {
        throw new McpError(ErrorCode.E_INVALID_PATTERN, error.message);
      }
      throw error;
    } finally {
      performance.mark(timerEndName);
      performance.measure(metricName, timerStartName, timerEndName);
      performance.clearMarks(timerStartName);
      performance.clearMarks(timerEndName);
      performance.clearMeasures(metricName);
    }
  },

  createMatcher(args: SearchInput): RE2 | undefined {
    if (!args.isRegex) return undefined;
    try {
      const flags =
        (args.caseSensitive ? '' : 'i') + (args.multiline ? 'm' : '');
      return new RE2(args.pattern, flags);
    } catch (error) {
      throw new McpError(
        ErrorCode.E_INVALID_PATTERN,
        `Invalid regex pattern: ${formatUnknownErrorMessage(error)}`
      );
    }
  },

  createSearchContext(
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
  },
};

async function handleSearchContent(
  args: SearchInput,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<ToolResponse<SearchOutput>> {
  const basePath = resolvePathOrRoot(args.path);
  const patternType: SearchPatternType = args.isRegex ? 'regex' : 'literal';
  const regexMatcher = SearchExecutor.createMatcher(args);

  const result = await SearchExecutor.run(args, basePath, signal, onProgress);

  const normalizedMatches = SearchResponseBuilder.normalizeMatches(result);
  const searchContext = SearchExecutor.createSearchContext(args, regexMatcher);

  const matchPayloads = SearchResponseBuilder.buildMatchPayloads(
    normalizedMatches,
    searchContext
  );

  const fullStructured = SearchResponseBuilder.buildStructured(
    result.summary,
    matchPayloads,
    { patternType, caseSensitive: args.caseSensitive }
  );

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
    const text = SearchResponseBuilder.buildText(
      preview.heading,
      preview.visibleMatches
    );

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

  const text = SearchResponseBuilder.buildText(
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
