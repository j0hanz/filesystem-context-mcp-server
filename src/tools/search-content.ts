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

import { formatOperationSummary, joinLines } from '../config.js';
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
  withDefaultIcons,
  withValidatedArgs,
  wrapToolHandler,
} from './shared.js';
import { registerToolTaskIfAvailable } from './task-support.js';

const MAX_INLINE_MATCHES =
  parseInt(process.env['FS_CONTEXT_MAX_INLINE_MATCHES'] ?? '', 10) || 50;
const SEARCH_COMPLETION_REASON_LABELS = {
  timeout: 'timeout',
  maxResults: 'max results',
  maxFiles: 'max files',
} as const;

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
    'Skips binary and oversized files.',
  ],
  gotchas: [
    'Skips binary/oversized files silently — verify with `stat` if no matches.',
  ],
  taskSupport: 'optional',
} as const;

function findColumnOffset(
  content: string,
  pattern: string,
  matcher: RE2 | undefined,
  caseSensitive: boolean
): number | undefined {
  try {
    if (matcher) {
      matcher.lastIndex = 0;
      const match = matcher.exec(content);
      return match ? match.index : undefined;
    }
    if (caseSensitive) {
      const idx = content.indexOf(pattern);
      return idx >= 0 ? idx : undefined;
    }
    const lowerContent = content.toLowerCase();
    const lowerPattern = pattern.toLowerCase();
    const idx = lowerContent.indexOf(lowerPattern);
    return idx >= 0 ? idx : undefined;
  } catch {
    return undefined;
  }
}

function buildSearchTextResult(
  heading: string,
  normalizedMatches: readonly NormalizedSearchMatch[],
  summary?: SearchContentSummary
): string {
  if (normalizedMatches.length === 0) return 'No matches';

  const text = buildMatchListText(heading, normalizedMatches);
  if (!summary) {
    return text;
  }

  const truncatedReason = summary.truncated
    ? resolveTruncatedReason(summary)
    : undefined;
  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: summary.truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
  };

  return text + formatOperationSummary(summaryOptions);
}

function resolveTruncatedReason(summary: SearchContentSummary): string {
  if (summary.stoppedReason === 'timeout') return 'timeout';
  if (summary.stoppedReason === 'maxFiles') {
    return `max files (${summary.filesScanned})`;
  }
  return `max results (${summary.matches})`;
}

function buildMatchListText(
  heading: string,
  matches: readonly NormalizedSearchMatch[]
): string {
  const lines: string[] = [heading];
  for (const match of matches) {
    lines.push(formatSearchMatchLine(match));
  }
  return joinLines(lines);
}

type SearchMatchPayload = NonNullable<
  z.infer<typeof SearchContentOutputSchema>['matches']
>[number];

interface SearchMatchBuildContext {
  pattern: string;
  matcher: RE2 | undefined;
  caseSensitive: boolean;
}

type SearchContentResultValue = Awaited<ReturnType<typeof searchContent>>;
type SearchContentSummary = SearchContentResultValue['summary'];
type SearchPatternType = 'literal' | 'regex';
type SearchStoppedReason = SearchContentSummary['stoppedReason'];

function buildSearchMatchPayload(
  match: NormalizedSearchMatch,
  context: SearchMatchBuildContext
): SearchMatchPayload {
  const column = findColumnOffset(
    match.content,
    context.pattern,
    context.matcher,
    context.caseSensitive
  );
  return {
    file: match.relativeFile,
    line: match.line,
    ...(column !== undefined ? { column } : {}),
    content: match.content,
    matchCount: match.matchCount,
    ...(match.contextBefore ? { contextBefore: [...match.contextBefore] } : {}),
    ...(match.contextAfter ? { contextAfter: [...match.contextAfter] } : {}),
  };
}

function formatSearchMatchLine(match: NormalizedSearchMatch): string {
  const lineNum = String(match.line).padStart(4);
  return `  ${match.relativeFile}:${lineNum}: ${match.content}`;
}

function buildSearchMatchPayloads(
  matches: readonly NormalizedSearchMatch[],
  context: SearchMatchBuildContext
): SearchMatchPayload[] {
  return matches.map((match) => buildSearchMatchPayload(match, context));
}

function buildStructuredSearchResult(
  summary: SearchContentSummary,
  matches: SearchMatchPayload[],
  options: { patternType: SearchPatternType; caseSensitive: boolean }
): z.infer<typeof SearchContentOutputSchema> {
  return {
    ok: true,
    patternType: options.patternType,
    caseSensitive: options.caseSensitive,
    matches,
    totalMatches: summary.matches,
    filesScanned: summary.filesScanned,
    ...(summary.truncated ? { truncated: summary.truncated } : {}),
    ...(summary.filesMatched ? { filesMatched: summary.filesMatched } : {}),
    ...(summary.skippedTooLarge
      ? { skippedTooLarge: summary.skippedTooLarge }
      : {}),
    ...(summary.skippedBinary ? { skippedBinary: summary.skippedBinary } : {}),
    ...(summary.skippedInaccessible
      ? { skippedInaccessible: summary.skippedInaccessible }
      : {}),
    ...(summary.linesSkippedDueToRegexTimeout
      ? { linesSkippedDueToRegexTimeout: summary.linesSkippedDueToRegexTimeout }
      : {}),
    ...(summary.stoppedReason ? { stoppedReason: summary.stoppedReason } : {}),
  };
}

type NormalizedSearchMatch = SearchContentResultValue['matches'][number] & {
  relativeFile: string;
  index: number;
};

function normalizeSearchMatches(
  result: SearchContentResultValue
): NormalizedSearchMatch[] {
  const relativeByFile = new Map<string, string>();
  const normalized: NormalizedSearchMatch[] = [];
  let index = 0;
  for (const match of result.matches) {
    const cached = relativeByFile.get(match.file);
    const relative = cached ?? path.relative(result.basePath, match.file);
    if (!cached) relativeByFile.set(match.file, relative);
    normalized.push({
      ...match,
      relativeFile: relative,
      index,
    });
    index += 1;
  }
  normalized.sort((a, b) => {
    const fileCompare = a.relativeFile.localeCompare(b.relativeFile);
    if (fileCompare !== 0) return fileCompare;
    if (a.line !== b.line) return a.line - b.line;
    return a.index - b.index;
  });
  return normalized;
}

async function handleSearchContent(
  args: z.infer<typeof SearchContentInputSchema>,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<ToolResponse<z.infer<typeof SearchContentOutputSchema>>> {
  const basePath = resolvePathOrRoot(args.path);
  const excludePatterns = args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS;
  const patternType = args.isRegex ? 'regex' : 'literal';

  let regexMatcher: RE2 | undefined;
  if (args.isRegex) {
    try {
      const flags =
        (args.caseSensitive ? '' : 'i') + (args.multiline ? 'm' : '');
      regexMatcher = new RE2(args.pattern, flags);
    } catch (error) {
      throw new McpError(
        ErrorCode.E_INVALID_PATTERN,
        `Invalid regex pattern: ${formatUnknownErrorMessage(error)}`
      );
    }
  }

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
  };
  if (signal) {
    options.signal = signal;
  }
  if (onProgress) {
    options.onProgress = onProgress;
  }

  let result: Awaited<ReturnType<typeof searchContent>>;
  try {
    result = await searchContent(basePath, args.pattern, options);
  } catch (error) {
    if (error instanceof Error && /regular expression/i.test(error.message)) {
      throw new McpError(ErrorCode.E_INVALID_PATTERN, error.message);
    }
    throw error;
  }

  const normalizedMatches = normalizeSearchMatches(result);
  const searchContext: SearchMatchBuildContext = {
    pattern: args.pattern,
    matcher: regexMatcher,
    caseSensitive: args.caseSensitive,
  };
  const matchPayloads = buildSearchMatchPayloads(
    normalizedMatches,
    searchContext
  );
  const structuredFull = buildStructuredSearchResult(
    result.summary,
    matchPayloads,
    {
      patternType,
      caseSensitive: args.caseSensitive,
    }
  );
  const needsExternalize = normalizedMatches.length > MAX_INLINE_MATCHES;

  if (!resourceStore || !needsExternalize) {
    return buildToolResponse(
      buildSearchTextResult(
        `Found ${normalizedMatches.length}:`,
        normalizedMatches,
        result.summary
      ),
      structuredFull
    );
  }

  const previewMatches = normalizedMatches.slice(0, MAX_INLINE_MATCHES);
  const previewPayload = buildSearchMatchPayloads(
    previewMatches,
    searchContext
  );
  const previewStructured: z.infer<typeof SearchContentOutputSchema> = {
    ...structuredFull,
    matches: previewPayload,
    truncated: true,
    resourceUri: undefined,
  };

  const entry = resourceStore.putText({
    name: 'grep:matches',
    mimeType: 'application/json',
    text: JSON.stringify(structuredFull),
  });

  previewStructured.resourceUri = entry.uri;
  const text = buildSearchTextResult(
    `Found ${normalizedMatches.length} (showing first ${MAX_INLINE_MATCHES}):`,
    previewMatches
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

export function registerSearchContentTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const handler = (
    args: z.infer<typeof SearchContentInputSchema>,
    extra: ToolExtra
  ): Promise<ToolResult<z.infer<typeof SearchContentOutputSchema>>> =>
    executeToolWithDiagnostics({
      toolName: 'grep',
      extra,
      context: { path: args.path ?? '.' },
      run: async (signal) => {
        const scope = args.filePattern;
        const { pattern } = args;
        const progress = createToolProgressSession(
          extra,
          `🔎︎ grep: ${pattern}`
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
            message: `🔎︎ grep: ${pattern} [${current} files]`,
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
          const suffix = buildCompletionSuffix({
            count,
            filesMatched,
            scope,
            stoppedReason,
          });

          const finalCurrent = resolveFinalProgressCurrent(
            progress,
            (sc.filesScanned ?? 0) + 1
          );

          progress.complete(`🔎︎ grep: ${pattern} • ${suffix}`, finalCurrent);
          return result;
        } catch (error) {
          progress.fail(`🔎︎ grep: ${pattern} • failed`);
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

function buildCompletionSuffix(params: {
  count: number;
  filesMatched: number;
  scope: string;
  stoppedReason: SearchStoppedReason;
}): string {
  if (params.count === 0) {
    return `No matches in ${params.scope}`;
  }

  const matchWord = params.count === 1 ? 'match' : 'matches';
  const fileWord = params.filesMatched === 1 ? 'file' : 'files';
  const reasonSuffix =
    params.stoppedReason !== undefined
      ? ` [${SEARCH_COMPLETION_REASON_LABELS[params.stoppedReason]}]`
      : '';
  return `${params.count} ${matchWord} in ${params.filesMatched} ${fileWord}${reasonSuffix}`;
}
