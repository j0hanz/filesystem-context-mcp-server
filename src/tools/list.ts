import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';

import { timedSignal } from '../core/concurrency.js';
import { closePage, openPage } from '../core/cursor.js';
import { ErrorCode } from '../core/errors.js';
import type { EntryType } from '../core/glob.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  globEntries,
  isIgnoredByGitignore,
  loadRootGitignore,
  resolveEntryType,
} from '../core/glob.js';
import type { PathGuard } from '../core/path.js';
import { toPosixRelative } from '../core/path.js';
import {
  CursorSchema,
  FileType as FileTypeEnum,
  includeHiddenField,
  includeIgnoredField,
  NextCursorSchema,
  NonNegInt,
  OptionalPath,
  PositiveInt,
} from '../core/schema.js';
import { putJsonResource } from '../core/store.js';
import {
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_TREE_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_TREE_DEPTH,
} from '../core/util.js';
import { defineTool, type ToolCtx } from './define.js';

interface CollectedEntry {
  name: string;
  relativePath: string; // POSIX
  type: EntryType;
}

interface CollectOptions {
  maxDepth: number;
  includeHidden: boolean;
  includeIgnored: boolean;
  signal: AbortSignal;
  pathGuard: PathGuard;
  // Upper bound on the collected (and thus paginable) entry array. MUST match
  // the `max` passed to openPage: offset pagination is only correct when
  // every page scans and sorts the same universe up to the same cap. The
  // caller threads openPage's fetchMax here so the invariant is enforced,
  // not implicit across two constants.
  entryCap: number;
  onProgress?: (progress: { current: number; total?: number }) => void;
}

interface CollectResult {
  entries: CollectedEntry[];
  totalEntries: number;
  totalFiles: number;
  totalDirectories: number;
}

function entryTypeRank(type: EntryType): number {
  if (type === 'directory') return 0;
  return 1;
}

function compareEntries(a: CollectedEntry, b: CollectedEntry): number {
  // Compare by parent directory first (depth-level grouping)
  const slashA = a.relativePath.lastIndexOf('/');
  const slashB = b.relativePath.lastIndexOf('/');
  const parentA = slashA === -1 ? '' : a.relativePath.slice(0, slashA);
  const parentB = slashB === -1 ? '' : b.relativePath.slice(0, slashB);

  if (parentA !== parentB) return parentA.localeCompare(parentB);

  // Within same parent: dirs first, then alphabetical
  const rankDiff = entryTypeRank(a.type) - entryTypeRank(b.type);
  if (rankDiff !== 0) return rankDiff;
  return a.name.localeCompare(b.name);
}

async function collect(rootPath: string, options: CollectOptions): Promise<CollectResult> {
  const gitignoreMatcher = options.includeIgnored
    ? null
    : await loadRootGitignore(rootPath, options.signal);

  const entries: CollectedEntry[] = [];
  let scanned = 0;
  let totalEntries = 0;
  let totalFiles = 0;
  let totalDirectories = 0;

  for await (const entry of globEntries({
    cwd: rootPath,
    pattern: '**/*',
    excludePatterns: options.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    includeHidden: options.includeHidden,
    baseNameMatch: false,
    // ListInputSchema.maxDepth is 1-based (1 = top-level only); the shared
    // globEntries primitive is now 0-based, so subtract one here. options.maxDepth
    // is guaranteed >= 1 by its PositiveInt schema, so this never underflows.
    maxDepth: options.maxDepth - 1,
    onlyFiles: false,
  })) {
    if (options.signal.aborted) break;
    scanned++;
    options.onProgress?.({ current: scanned });

    const entryType: EntryType = resolveEntryType(entry.dirent);
    const isDir = entryType === 'directory';
    const relPath = toPosixRelative(rootPath, entry.path);
    const name = basename(relPath);

    if (
      gitignoreMatcher &&
      isIgnoredByGitignore(gitignoreMatcher, rootPath, entry.path, {
        isDirectory: isDir,
      })
    ) {
      continue;
    }
    const accessible = await options.pathGuard.isEntryAccessible(entry.path, entryType, [rootPath]);
    if (!accessible) continue;

    totalEntries++;
    if (entryType === 'directory') {
      totalDirectories++;
    } else {
      totalFiles++;
    }

    const collectedEntry: CollectedEntry = {
      name,
      relativePath: relPath,
      type: entryType,
    };

    if (entries.length < options.entryCap) {
      entries.push(collectedEntry);
    }
  }

  entries.sort(compareEntries);

  return {
    entries,
    totalEntries,
    totalFiles,
    totalDirectories,
  };
}

const TEE = '├── ';
const ELBOW = '└── ';
const PIPE = '│   ';
const INDENT = '    ';

function renderMarkdown(rootName: string, entries: CollectedEntry[]): string {
  if (entries.length === 0) return rootName;

  // Group entries by parent path
  const childrenOf = new Map<string, CollectedEntry[]>();
  for (const entry of entries) {
    const slash = entry.relativePath.lastIndexOf('/');
    const parentKey = slash === -1 ? '' : entry.relativePath.slice(0, slash);
    if (!childrenOf.has(parentKey)) childrenOf.set(parentKey, []);
    const children = childrenOf.get(parentKey);
    if (children) children.push(entry);
  }

  const lines: string[] = [rootName];

  function renderChildren(parentKey: string, prefix: string): void {
    const children = childrenOf.get(parentKey);
    if (!children) return;

    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (!child) continue;
      const isLast = i === children.length - 1;
      const connector = isLast ? ELBOW : TEE;
      lines.push(prefix + connector + child.name);

      const childKey = child.relativePath;
      const nextPrefix = prefix + (isLast ? INDENT : PIPE);
      renderChildren(childKey, nextPrefix);
    }
  }

  renderChildren('', '');
  return lines.join('\n');
}

const DEFAULT_LIST_DEPTH = 1;
const DEFAULT_LIST_ENTRIES = DEFAULT_TREE_ENTRIES;

const ListInputSchema = z.strictObject({
  path: OptionalPath,
  maxDepth: PositiveInt.max(MAX_TREE_DEPTH)
    .default(DEFAULT_LIST_DEPTH)
    .describe(
      `Max directory depth to traverse (default: ${String(DEFAULT_LIST_DEPTH)} = top-level only; increase to recurse deeper)`,
    ),
  maxEntries: PositiveInt.max(MAX_LIST_ENTRIES)
    .default(DEFAULT_LIST_ENTRIES)
    .describe(
      `Maximum number of entries to include in the inline result (default: ${String(DEFAULT_LIST_ENTRIES)}); full result is stored at resourceUri when exceeded`,
    ),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  cursor: CursorSchema,
});

const ListOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().optional().describe('Resolved absolute path of the listed directory'),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry basename'),
        relativePath: z.string().describe('POSIX path relative to the listed directory'),
        type: FileTypeEnum.describe('Entry type: file, directory, symlink, or other'),
      }),
    )
    .describe('Inline directory entries sorted directories-first then alphabetically by name'),
  markdown: z.string().describe('ASCII tree representation of the directory structure'),
  entryCount: NonNegInt.describe('Number of entries included in this response'),
  totalEntries: NonNegInt.describe('Total entries found before the maxEntries cap was applied'),
  totalFiles: NonNegInt.describe('Total number of files found'),
  totalDirectories: NonNegInt.describe('Total number of directories found'),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the full entry list in the resource store. Only present when total entries exceed the hard cap ' +
        '(the same cap that bounds pagination); below it, page through the remaining entries with nextCursor. ' +
        'The stored list is itself capped at the hard limit and marked truncated if total entries exceed it.',
    ),
  nextCursor: NextCursorSchema,
});

async function handleList(
  args: z.infer<typeof ListInputSchema>,
  ctx: ToolCtx,
): Promise<{ structured: z.infer<typeof ListOutputSchema>; link?: ContentBlock }> {
  const path = args.path;
  const resolvedPath = ctx.fs.pathGuard.resolvePathOrRoot(path);
  const validDir = await ctx.fs.pathGuard.validateExistingDirectory(resolvedPath);

  const { offset, fetchMax } = openPage({ cursor: args.cursor, max: MAX_LIST_ENTRIES });

  const result = await collect(validDir, {
    maxDepth: args.maxDepth,
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
    signal: timedSignal(ctx.signal, DEFAULT_SEARCH_TIMEOUT_MS),
    pathGuard: ctx.fs.pathGuard,
    entryCap: fetchMax,
    ...(ctx.onProgress ? { onProgress: ctx.onProgress } : {}),
  });
  const page = result.entries.slice(offset, offset + args.maxEntries);
  const nextCursor = closePage({
    total: result.entries.length,
    offset,
    pageCount: page.length,
  });
  const markdown = renderMarkdown(basename(validDir), page);

  let resourceUri: string | undefined;
  let link: ContentBlock | undefined;
  if (result.totalEntries > result.entries.length && ctx.resourceStore) {
    const fullMarkdown = renderMarkdown(basename(validDir), result.entries);
    const fullTruncated = result.totalEntries > result.entries.length;
    const fullOutput = {
      entries: result.entries,
      markdown: fullMarkdown,
      totalEntries: result.totalEntries,
      totalFiles: result.totalFiles,
      totalDirectories: result.totalDirectories,
      ...(fullTruncated ? { truncated: true } : {}),
    };
    const res = putJsonResource(ctx.resourceStore, `${basename(validDir)} tree`, fullOutput);
    resourceUri = res.entry.uri;
    link = res.link;
  }

  const output: z.infer<typeof ListOutputSchema> = {
    ok: true,
    path: validDir,
    entries: page,
    markdown,
    entryCount: page.length,
    totalEntries: result.totalEntries,
    totalFiles: result.totalFiles,
    totalDirectories: result.totalDirectories,
    ...(resourceUri ? { resourceUri } : {}),
    ...(nextCursor !== undefined ? { nextCursor } : {}),
  };

  return { structured: output, ...(link ? { link } : {}) };
}

export const LIST = defineTool({
  name: 'list',
  title: 'List',
  description:
    'List directory contents. Returns entries sorted directories-first then alphabetically, plus a markdown ASCII tree. ' +
    'Default maxDepth=1 lists top-level entries only; increase to recurse deeper. ' +
    'When results exceed maxEntries, the full list is stored at resourceUri.',
  input: ListInputSchema,
  output: ListOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.NOT_DIRECTORY,
  progress: (args) => ({
    label: 'List',
    subject: args.path ? basename(args.path) : '.',
  }),
  accessPaths: (args) => (args.path ? [args.path] : []),
  run: async (args, ctx) => {
    const { structured, link } = await handleList(args, ctx);
    return {
      structured,
      text: structured.markdown,
      ...(link ? { resources: [link] } : {}),
    };
  },
});
