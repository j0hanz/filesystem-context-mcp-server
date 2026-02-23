import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import type { z } from 'zod';

import RE2 from 're2';

import { formatOperationSummary, joinLines } from '../config.js';
import { DEFAULT_EXCLUDE_PATTERNS } from '../lib/constants.js';
import {
  ErrorCode,
  formatUnknownErrorMessage,
  McpError,
} from '../lib/errors.js';
import { searchContent } from '../lib/file-operations/search-content.js';
import type { SearchContentOptions } from '../lib/file-operations/search-content.js';
import {
  SearchContentInputSchema,
  SearchContentOutputSchema,
} from '../schemas.js';
import {
  buildResourceLink,
  buildToolErrorResponse,
  buildToolResponse,
  createProgressReporter,
  executeToolWithDiagnostics,
  notifyProgress,
  READ_ONLY_TOOL_ANNOTATIONS,
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

export const SEARCH_CONTENT_TOOL: ToolContract = {
  name: 'grep',
  title: 'Search Content',
  description:
    'Search for text within file contents (grep-like). ' +
    'Returns matching lines. ' +
    'Path may be a directory or a single file. ' +
    'Use `filePattern` to scope by file type (e.g. `**/*.ts`) and avoid noisy results. ' +
    'Use includeHidden=true to include hidden files and directories.',
  inputSchema: SearchContentInputSchema,
  outputSchema: SearchContentOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  nuances: [
    'Inline match rows are capped (first 50); full structured results are externalized via `resourceUri`.',
    'Skips binary and oversized files.',
  ],
  gotchas: [
    'Skips binary and oversized files silently — check file type with `stat` if no matches appear.',
  ],
  taskSupport: 'optional',
} as const;

function assertValidRegexPattern(pattern: string): void {
  try {
    new RE2(pattern);
  } catch (error) {
    throw new McpError(
      ErrorCode.E_INVALID_PATTERN,
      `Invalid regex pattern: ${formatUnknownErrorMessage(error)}`
    );
  }
}

function buildSearchTextResult(
  result: Awaited<ReturnType<typeof searchContent>>,
  normalizedMatches: NormalizedSearchMatch[]
): string {
  const { summary } = result;

  if (normalizedMatches.length === 0) return 'No matches';

  let truncatedReason: string | undefined;
  if (summary.truncated) {
    if (summary.stoppedReason === 'timeout') {
      truncatedReason = 'timeout';
    } else if (summary.stoppedReason === 'maxFiles') {
      truncatedReason = `max files (${summary.filesScanned})`;
    } else {
      truncatedReason = `max results (${summary.matches})`;
    }
  }

  const summaryOptions: Parameters<typeof formatOperationSummary>[0] = {
    truncated: summary.truncated,
    ...(truncatedReason ? { truncatedReason } : {}),
  };

  const lines: string[] = [`Found ${normalizedMatches.length}:`];
  for (const match of normalizedMatches) {
    lines.push(formatSearchMatchLine(match));
  }

  return joinLines(lines) + formatOperationSummary(summaryOptions);
}

type SearchMatchPayload = NonNullable<
  z.infer<typeof SearchContentOutputSchema>['matches']
>[number];

function buildSearchMatchPayload(
  match: NormalizedSearchMatch
): SearchMatchPayload {
  return {
    file: match.relativeFile,
    line: match.line,
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

function buildStructuredSearchResult(
  result: Awaited<ReturnType<typeof searchContent>>,
  normalizedMatches: NormalizedSearchMatch[],
  options: { patternType: 'literal' | 'regex'; caseSensitive: boolean }
): z.infer<typeof SearchContentOutputSchema> {
  const { summary } = result;
  const matches = normalizedMatches.map((match) =>
    buildSearchMatchPayload(match)
  );

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

type SearchContentResultValue = Awaited<ReturnType<typeof searchContent>>;
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

  if (args.isRegex) {
    assertValidRegexPattern(args.pattern);
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
  const structuredFull = buildStructuredSearchResult(
    result,
    normalizedMatches,
    {
      patternType,
      caseSensitive: args.caseSensitive,
    }
  );
  const needsExternalize = normalizedMatches.length > MAX_INLINE_MATCHES;

  if (!resourceStore || !needsExternalize) {
    return buildToolResponse(
      buildSearchTextResult(result, normalizedMatches),
      structuredFull
    );
  }

  const previewMatches = normalizedMatches.slice(0, MAX_INLINE_MATCHES);
  const previewPayload = previewMatches.map((match) =>
    buildSearchMatchPayload(match)
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

  const textLines: string[] = [
    `Found ${normalizedMatches.length} (showing first ${MAX_INLINE_MATCHES}):`,
  ];
  for (const match of previewMatches) {
    textLines.push(formatSearchMatchLine(match));
  }
  const text = joinLines(textLines);

  return buildToolResponse(text, previewStructured, [
    buildResourceLink({
      uri: entry.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      description: 'Full grep results as JSON (structuredContent)',
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
        let progressCursor = 0;

        notifyProgress(extra, {
          current: 0,
          message: `🔎︎ grep: ${pattern} in ${scope}`,
        });

        const baseReporter = createProgressReporter(extra);
        const progressWithMessage = ({
          current,
          total,
        }: {
          total?: number;
          current: number;
        }): void => {
          if (current > progressCursor) progressCursor = current;
          const fileWord = current === 1 ? 'file' : 'files';
          baseReporter({
            current,
            ...(total !== undefined ? { total } : {}),
            message: `🔎︎ grep: ${pattern} [${current} ${fileWord} scanned]`,
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

          let suffix: string;
          if (count === 0) {
            suffix = `No matches in ${scope}`;
          } else {
            const matchWord = count === 1 ? 'match' : 'matches';
            const fileInfo =
              filesMatched > 0
                ? ` in ${filesMatched} ${filesMatched === 1 ? 'file' : 'files'}`
                : '';
            suffix = `${count} ${matchWord}${fileInfo}`;
            if (stoppedReason === 'timeout') {
              suffix += ' [stopped — timeout]';
            } else if (stoppedReason === 'maxResults') {
              suffix += ' [truncated — max results]';
            } else if (stoppedReason === 'maxFiles') {
              suffix += ' [truncated — max files]';
            }
          }

          const finalCurrent = Math.max(
            (sc.filesScanned ?? 0) + 1,
            progressCursor + 1
          );

          notifyProgress(extra, {
            current: finalCurrent,
            total: finalCurrent,
            message: `🔎︎ grep: ${pattern} • ${suffix}`,
          });
          return result;
        } catch (error) {
          const finalCurrent = Math.max(progressCursor + 1, 1);
          notifyProgress(extra, {
            current: finalCurrent,
            total: finalCurrent,
            message: `🔎︎ grep: ${pattern} in ${scope} • failed`,
          });
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
