import { basename, relative } from 'node:path';

import { z } from 'zod/v4';

import { withTimedAbortSignal } from '../core/concurrency.js';
import { ErrorCode } from '../core/errors.js';
import {
  type EntryType,
  globEntries,
  isIgnoredByGitignore,
  loadRootGitignore,
} from '../core/fs.js';
import { toPosixPath } from '../core/path.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_TREE_ENTRIES,
  MAX_LIST_ENTRIES,
  MAX_TREE_DEPTH,
} from '../core/util.js';
import {
  FileType as FileTypeEnum,
  includeHiddenField,
  includeIgnoredField,
  NonNegInt,
  OptionalPath,
  PositiveInt,
} from '../schema.js';
import { buildToolResponse, putResource } from './_helpers.js';
import { defineTool } from './define.js';

// ─── Types ───────────────────────────────────────────────────────────────────

interface CollectedEntry {
  name: string;
  relativePath: string; // POSIX
  type: EntryType;
}

interface CollectOptions {
  maxDepth: number;
  maxEntries: number;
  includeHidden: boolean;
  includeIgnored: boolean;
  signal: AbortSignal;
}

interface CollectResult {
  entries: CollectedEntry[];
  totalEntries: number;
  totalFiles: number;
  totalDirectories: number;
}

// ─── collect — single DFS via globEntries ────────────────────────────────────

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

  const all: CollectedEntry[] = [];

  for await (const entry of globEntries({
    cwd: rootPath,
    pattern: '**/*',
    excludePatterns: options.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    includeHidden: options.includeHidden,
    baseNameMatch: false,
    caseSensitiveMatch: true,
    maxDepth: options.maxDepth,
    followSymbolicLinks: false,
    onlyFiles: false,
    stats: false,
  })) {
    if (options.signal.aborted) break;

    // Type detection: check if it's a directory
    const isDir = entry.dirent.isDirectory();
    const entryType: EntryType = isDir ? 'directory' : 'file';

    // Get relative path (entry.path is absolute)
    const relPath = relative(rootPath, entry.path);
    const name = basename(relPath);

    // Gitignore filter
    if (
      gitignoreMatcher &&
      isIgnoredByGitignore(gitignoreMatcher, rootPath, entry.path, {
        isDirectory: isDir,
      })
    ) {
      continue;
    }

    all.push({
      name,
      relativePath: toPosixPath(relPath),
      type: entryType,
    });
  }

  // Sort all entries before slicing
  all.sort(compareEntries);

  // Count types from all entries
  let totalFiles = 0;
  let totalDirectories = 0;
  for (const entry of all) {
    if (entry.type === 'directory') {
      totalDirectories++;
    } else {
      totalFiles++;
    }
  }

  return {
    entries: all.slice(0, options.maxEntries),
    totalEntries: all.length,
    totalFiles,
    totalDirectories,
  };
}

// ─── renderMarkdown — pure, box-drawing ASCII tree ───────────────────────────

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

// ─── Schemas ─────────────────────────────────────────────────────────────────

const DEFAULT_LIST_DEPTH = 1;
const DEFAULT_LIST_ENTRIES = DEFAULT_TREE_ENTRIES;

const ListInputSchema = z.strictObject({
  path: OptionalPath,
  maxDepth: PositiveInt.max(MAX_TREE_DEPTH)
    .default(DEFAULT_LIST_DEPTH)
    .describe(`Max directory depth (default: ${String(DEFAULT_LIST_DEPTH)}, flat listing)`),
  maxEntries: PositiveInt.max(MAX_LIST_ENTRIES)
    .default(DEFAULT_LIST_ENTRIES)
    .describe(`Max entries to return (default: ${String(DEFAULT_LIST_ENTRIES)})`),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
});

const ListOutputSchema = z.strictObject({
  ok: z.literal(true),
  path: z.string().describe('Listed directory path'),
  entries: z
    .array(
      z.strictObject({
        name: z.string().describe('Entry name'),
        relativePath: z.string().describe('POSIX path relative to directory'),
        type: FileTypeEnum.describe('Entry type'),
      }),
    )
    .describe('Directory entries, dirs-first then alphabetical'),
  markdown: z.string().describe('ASCII tree representation'),
  entryCount: NonNegInt.describe('Number of entries returned'),
  totalEntries: NonNegInt.describe('Total entries found before cap'),
  totalFiles: NonNegInt.describe('Total files'),
  totalDirectories: NonNegInt.describe('Total directories'),
  resourceUri: z.string().optional().describe('Full result (present when result is truncated)'),
});

// ─── Handler ─────────────────────────────────────────────────────────────────

async function handleList(
  args: z.infer<typeof ListInputSchema>,
  pathGuard: PathGuard,
  signal?: AbortSignal,
  resourceStore?: ResourceStore,
): Promise<z.infer<typeof ListOutputSchema>> {
  const path = args.path;
  const resolvedPath = pathGuard.resolvePathOrRoot(path);
  const validDir = await pathGuard.validateExistingDirectory(resolvedPath);

  return withTimedAbortSignal(signal, DEFAULT_SEARCH_TIMEOUT_MS, async (timedSignal) => {
    const result = await collect(validDir, {
      maxDepth: args.maxDepth,
      maxEntries: args.maxEntries,
      includeHidden: args.includeHidden,
      includeIgnored: args.includeIgnored,
      signal: timedSignal,
    });

    const markdown = renderMarkdown(basename(validDir), result.entries);

    let resourceUri: string | undefined;
    if (result.totalEntries > result.entries.length && resourceStore) {
      const fullOutput = {
        entries: result.entries,
        markdown,
        totalEntries: result.totalEntries,
        totalFiles: result.totalFiles,
        totalDirectories: result.totalDirectories,
      };
      const { entry } = putResource({
        store: resourceStore,
        name: 'list-result.json',
        mimeType: 'application/json',
        kind: 'text',
        content: JSON.stringify(fullOutput, null, 2),
      });
      resourceUri = entry.uri;
    }

    const output: z.infer<typeof ListOutputSchema> = {
      ok: true,
      path: validDir,
      entries: result.entries,
      markdown,
      entryCount: result.entries.length,
      totalEntries: result.totalEntries,
      totalFiles: result.totalFiles,
      totalDirectories: result.totalDirectories,
      ...(resourceUri ? { resourceUri } : {}),
    };

    return output;
  });
}

// ─── Tool ─────────────────────────────────────────────────────────────────────

export const LIST = defineTool({
  name: 'list',
  title: 'List',
  description:
    'List directory contents. Returns entries (dirs-first, alphabetical) and a markdown ASCII tree. ' +
    'Default maxDepth=1 lists top-level only; maxDepth>1 recurses. ' +
    'Full result stored as resourceUri when truncated.',
  input: ListInputSchema,
  output: ListOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  timeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
  defaultErrorCode: ErrorCode.NOT_DIRECTORY,
  progressLabel: (args) => {
    const path = args.path;
    return `List: ${path ? basename(path) : '.'}`;
  },
  run: async (args, ctx) => {
    const output = await handleList(args, ctx.pathGuard, ctx.signal, ctx.resourceStore);
    const path = args.path;
    const label = 'List: ' + (path ? basename(path) : '.');
    return buildToolResponse(label, output);
  },
});
