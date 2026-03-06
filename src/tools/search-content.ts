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

type NormalizedSearchMatch = SearchResultValue['matches'][number] & {
  relativeFile: string;
  index: number;
};

interface SearchContext {
  pattern: string;
  matcher?: RE2;
  caseSensitive: boolean;
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
    'Skips binary and oversized files.',
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
    options: { patternType: 'literal' | 'regex'; caseSensitive: boolean }
  ): SearchOutput {
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
      ...(summary.skippedBinary
        ? { skippedBinary: summary.skippedBinary }
        : {}),
      ...(summary.skippedInaccessible
        ? { skippedInaccessible: summary.skippedInaccessible }
        : {}),
      ...(summary.linesSkippedDueToRegexTimeout
        ? {
            linesSkippedDueToRegexTimeout:
              summary.linesSkippedDueToRegexTimeout,
          }
        : {}),
      ...(summary.stoppedReason
        ? { stoppedReason: summary.stoppedReason }
        : {}),
    };
  },

  normalizeMatches(
    result: SearchResultValue,
    basePath: string
  ): NormalizedSearchMatch[] {
    const relativeByFile = new Map<string, string>();
    const normalized: NormalizedSearchMatch[] = [];

    // Pre-calculate relative paths efficiently
    for (let i = 0; i < result.matches.length; i++) {
      const match = result.matches[i];
      if (!match) continue;
      let relative = relativeByFile.get(match.file);
      if (!relative) {
        relative = path.relative(basePath, match.file);
        relativeByFile.set(match.file, relative);
      }
      normalized.push({
        ...match,
        relativeFile: relative,
        index: i,
      } as NormalizedSearchMatch);
    }

    return normalized.sort((a, b) => {
      const fileCompare = a.relativeFile.localeCompare(b.relativeFile);
      if (fileCompare !== 0) return fileCompare;
      if (a.line !== b.line) return a.line - b.line;
      return a.index - b.index;
    });
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
    const lines = [heading];
    for (const match of matches) {
      const lineNum = String(match.line).padStart(4);
      lines.push(`  ${match.relativeFile}:${lineNum}: ${match.content}`);
    }
    return joinLines(lines);
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
      const idx = content.toLowerCase().indexOf(context.pattern.toLowerCase());
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

    try {
      return await searchContent(basePath, args.pattern, options);
    } catch (error) {
      if (error instanceof Error && /regular expression/i.test(error.message)) {
        throw new McpError(ErrorCode.E_INVALID_PATTERN, error.message);
      }
      throw error;
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
};

async function handleSearchContent(
  args: SearchInput,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onProgress?: (progress: { total?: number; current: number }) => void
): Promise<ToolResponse<SearchOutput>> {
  const basePath = resolvePathOrRoot(args.path);
  const patternType = args.isRegex ? 'regex' : 'literal';
  const regexMatcher = SearchExecutor.createMatcher(args);

  const result = await SearchExecutor.run(args, basePath, signal, onProgress);

  const normalizedMatches = SearchResponseBuilder.normalizeMatches(
    result,
    result.basePath // Use result.basePath which is the resolved absolute path
  );

  const searchContext: SearchContext = {
    pattern: args.pattern,
    caseSensitive: args.caseSensitive,
    ...(regexMatcher ? { matcher: regexMatcher } : {}),
  };

  const matchPayloads = SearchResponseBuilder.buildMatchPayloads(
    normalizedMatches,
    searchContext
  );

  const fullStructured = SearchResponseBuilder.buildStructured(
    result.summary,
    matchPayloads,
    { patternType, caseSensitive: args.caseSensitive }
  );

  const needsExternalize = normalizedMatches.length > CONFIG.MAX_INLINE_MATCHES;

  if (resourceStore && needsExternalize) {
    const previewMatches = normalizedMatches.slice(
      0,
      CONFIG.MAX_INLINE_MATCHES
    );
    const previewPayload = matchPayloads.slice(0, CONFIG.MAX_INLINE_MATCHES);

    const previewStructured: SearchOutput = {
      ...fullStructured,
      matches: previewPayload,
      truncated: true,
    };

    const entry = resourceStore.putText({
      name: 'grep:matches',
      mimeType: 'application/json',
      text: JSON.stringify(fullStructured),
    });

    previewStructured.resourceUri = entry.uri;
    const text = SearchResponseBuilder.buildText(
      `Found ${normalizedMatches.length} (showing first ${CONFIG.MAX_INLINE_MATCHES}):`,
      previewMatches
    ); // No summary in text if externalized, or maybe simpler? Old logic just passed heading+matches.

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
    `Found ${normalizedMatches.length}:`,
    normalizedMatches,
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
      context: { path: args.path ?? '.' },
      run: async (signal) => {
        const { pattern, filePattern: scope } = args;
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

          // Helper logic for completion suffix
          const suffix = (() => {
            if (count === 0) return `No matches in ${scope}`;
            const matchWord = count === 1 ? 'match' : 'matches';
            const fileWord = filesMatched === 1 ? 'file' : 'files';
            const reasonSuffix =
              stoppedReason !== undefined
                ? ` [${CONFIG.COMPLETION_LABELS[stoppedReason]}]`
                : '';
            return `${count} ${matchWord} in ${filesMatched} ${fileWord}${reasonSuffix}`;
          })();

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
