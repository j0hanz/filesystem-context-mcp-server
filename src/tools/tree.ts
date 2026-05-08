import { basename, relative } from 'node:path';

import { z } from 'zod/v4';

import { withTimedAbortSignal } from '../lib/abort.js';
import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_SEARCH_TIMEOUT_MS,
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_ENTRIES,
  MAX_TREE_DEPTH,
  MAX_TREE_ENTRIES,
} from '../lib/constants.js';
import { ErrorCode } from '../lib/errors.js';
import {
  type DirentLike,
  type EntryAccessDependencies,
  type EntryType,
  globEntries,
  isEntryAccessibleByType,
  isIgnoredByGitignore,
  loadRootGitignore,
  resolveEntryType,
  resolveStopReason,
} from '../lib/fs-walk.js';
import {
  isPathWithinDirectories,
  isSensitivePath,
  normalizePath,
  toPosixPath,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../lib/paths.js';
import {
  FileType as FileTypeEnum,
  NonNegInt,
  OptionalPath,
} from '../schemas/fields.js';
import {
  ContinuationSchema,
  defaultFalseBoolean,
  includeHiddenField,
  includeIgnoredField,
} from '../schemas/shared.js';

import { defineTool } from './define-tool.js';
import { DIRECTORY_ICONS } from './icons.js';
import {
  buildResourceLink,
  buildToolResponse,
  maybeExternalizeTextContent,
  READ_ONLY_TOOL_ANNOTATIONS,
  resolvePathOrRoot,
  type ToolContract,
  type ToolRegistrationOptions,
  type ToolResponse,
} from './shared.js';
import {
  resolveFinalProgressCurrent,
  runWithProgressSession,
} from './tool-execution.js';

// ---------------------------------------------------------------------------
// Private tree implementation (inlined from lib/file-operations/metadata.ts)
// ---------------------------------------------------------------------------

const TREE_ACCESS_DEPS: EntryAccessDependencies = {
  normalizePath,
  isPathWithinDirectories,
  isSensitivePath,
  validateSymlinkPath: validateExistingPathDetailed,
};

interface TreeEntry {
  name: string;
  type: EntryType;
  relativePath: string;
  size?: number;
  children?: TreeEntry[];
}

interface TreeOptions {
  maxDepth?: number;
  maxEntries?: number;
  includeHidden?: boolean;
  includeIgnored?: boolean;
  includeSizes?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { total?: number; current: number }) => void;
}

interface TreeNormalizedOptions {
  maxDepth: number;
  maxEntries: number;
  includeHidden: boolean;
  includeIgnored: boolean;
  includeSizes: boolean;
  timeoutMs: number;
}

interface TreeResult {
  root: string;
  tree: TreeEntry;
  truncated: boolean;
  totalEntries: number;
}

function clampInt(value: unknown, fallback: number, min: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const asInt = Math.floor(value);
  return asInt >= min ? asInt : fallback;
}

function normalizeTreeOptions(options: TreeOptions): TreeNormalizedOptions {
  return {
    maxDepth: clampInt(options.maxDepth, 5, 0),
    maxEntries: clampInt(options.maxEntries, 1000, 0),
    includeHidden: options.includeHidden ?? false,
    includeIgnored: options.includeIgnored ?? false,
    includeSizes: options.includeSizes ?? false,
    timeoutMs: clampInt(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS, 1),
  };
}

function resolveTreeRelativePath(basePath: string, entryPath: string): string {
  return relative(basePath, entryPath) || basename(entryPath);
}

function ensureParentNodes(
  rootNode: TreeEntry,
  nodeByPath: Map<string, TreeEntry>,
  relativePath: string
): TreeEntry {
  const normalized = toPosixPath(relativePath);
  if (normalized.length === 0 || normalized === '.') return rootNode;

  const segments = normalized.split('/').filter(Boolean);
  const parentSegmentCount = Math.max(0, segments.length - 1);
  let current = rootNode;
  let currentPath = '';

  for (let index = 0; index < parentSegmentCount; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    currentPath =
      currentPath.length === 0 ? segment : `${currentPath}/${segment}`;

    let child = nodeByPath.get(currentPath);
    if (!child) {
      child = {
        name: segment,
        type: 'directory',
        relativePath: currentPath,
        children: [],
      };
      nodeByPath.set(currentPath, child);
      current.children ??= [];
      current.children.push(child);
    }

    current = child;
  }

  return current;
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const diff = getTreeTypeRank(a.type) - getTreeTypeRank(b.type);
  if (diff !== 0) return diff;
  return a.name.localeCompare(b.name);
}

const TREE_TYPE_RANKS: Record<string, number> = { directory: 0, file: 1 };

function getTreeTypeRank(type: EntryType): number {
  return TREE_TYPE_RANKS[type] ?? 2;
}

function sortTree(node: TreeEntry): void {
  if (!node.children) return;
  node.children.sort(compareTreeEntries);
  for (const child of node.children) {
    sortTree(child);
  }
}

async function resolveTreeEntry(
  entry: { path: string; dirent: DirentLike },
  root: string,
  rootDirectories: readonly string[],
  gitignoreMatcher: Awaited<ReturnType<typeof loadRootGitignore>>,
  signal: AbortSignal
): Promise<{ type: EntryType; relativePosix: string; name: string } | null> {
  const type = resolveEntryType(entry.dirent);
  const isAccessible = await isEntryAccessibleByType(
    entry.path,
    type,
    rootDirectories,
    signal,
    TREE_ACCESS_DEPS
  );
  if (!isAccessible) return null;

  if (
    gitignoreMatcher &&
    isIgnoredByGitignore(gitignoreMatcher, root, entry.path, {
      isDirectory: type === 'directory',
    })
  ) {
    return null;
  }

  const relativePosix = toPosixPath(resolveTreeRelativePath(root, entry.path));
  const name = basename(entry.path);
  return { type, relativePosix, name };
}

function upsertChildNode(
  parent: TreeEntry,
  nodeByPath: Map<string, TreeEntry>,
  resolved: { type: EntryType; relativePosix: string; name: string },
  childPathIndexByParent: WeakMap<TreeEntry, Set<string>>
): void {
  const ensureDirectoryShape = (node: TreeEntry): void => {
    if (node.type === 'directory') {
      node.children ??= [];
    } else {
      delete node.children;
    }
  };

  const maybeUpdateType = (existing: TreeEntry, nextType: EntryType): void => {
    if (existing.type === nextType) return;
    const preservePopulatedDirectory =
      existing.type === 'directory' &&
      Array.isArray(existing.children) &&
      existing.children.length > 0;
    if (preservePopulatedDirectory) return;
    existing.type = nextType;
    ensureDirectoryShape(existing);
  };

  const attachChild = (child: TreeEntry): void => {
    parent.children ??= [];
    let seen = childPathIndexByParent.get(parent);
    if (!seen) {
      seen = new Set<string>();
      for (const entry of parent.children) {
        seen.add(entry.relativePath);
      }
      childPathIndexByParent.set(parent, seen);
    }
    const key = child.relativePath;
    if (seen.has(key)) return;
    seen.add(key);
    parent.children.push(child);
  };

  const existing = nodeByPath.get(resolved.relativePosix);
  if (existing) {
    maybeUpdateType(existing, resolved.type);
    existing.name = resolved.name;
    existing.relativePath = resolved.relativePosix;
    ensureDirectoryShape(existing);
    attachChild(existing);
    return;
  }

  const node: TreeEntry = {
    name: resolved.name,
    type: resolved.type,
    relativePath: resolved.relativePosix,
    ...(resolved.type === 'directory' ? { children: [] as TreeEntry[] } : {}),
  };

  nodeByPath.set(resolved.relativePosix, node);
  attachChild(node);
}

function formatTreeAscii(tree: TreeEntry): string {
  const lines: string[] = [];

  const walk = (
    node: TreeEntry,
    prefix: string,
    isLast: boolean,
    isRoot: boolean
  ): void => {
    let connector = '';
    let linePrefix = '';
    if (!isRoot) {
      connector = isLast ? '└── ' : '├── ';
      linePrefix = prefix;
    }
    lines.push(`${linePrefix}${connector}${node.name}`);

    if (!node.children || node.children.length === 0) return;

    let nextPrefix = '';
    if (!isRoot) {
      const continuation = isLast ? '    ' : '│   ';
      nextPrefix = `${prefix}${continuation}`;
    }

    const count = node.children.length;
    for (let index = 0; index < count; index += 1) {
      const child = node.children[index];
      if (child) {
        walk(child, nextPrefix, index === count - 1, false);
      }
    }
  };

  walk(tree, '', true, true);
  return lines.join('\n');
}

async function treeDirectory(
  dirPath: string,
  options: TreeOptions = {}
): Promise<TreeResult> {
  const normalized = normalizeTreeOptions(options);
  return withTimedAbortSignal(
    options.signal,
    normalized.timeoutMs,
    async (signal) => {
      const root = await validateExistingDirectory(dirPath, signal);
      const rootNormalized = normalizePath(root);
      const rootDirectories = [rootNormalized];

      const excludePatterns = normalized.includeIgnored
        ? []
        : DEFAULT_EXCLUDE_PATTERNS;

      const gitignoreMatcher = normalized.includeIgnored
        ? null
        : await loadRootGitignore(root, signal);

      const rootNode: TreeEntry = {
        name: basename(root) || root,
        type: 'directory',
        relativePath: '.',
        children: [],
      };

      const nodeByPath = new Map<string, TreeEntry>();
      const childPathIndexByParent = new WeakMap<TreeEntry, Set<string>>();
      let totalEntries = 0;
      let truncated = false;

      const stream = globEntries({
        cwd: root,
        pattern: '**/*',
        excludePatterns,
        includeHidden: normalized.includeHidden,
        baseNameMatch: false,
        caseSensitiveMatch: true,
        maxDepth: normalized.maxDepth,
        followSymbolicLinks: false,
        onlyFiles: false,
        stats: normalized.includeSizes,
        suppressErrors: true,
      });

      for await (const entry of stream) {
        const stopReason = resolveStopReason<'aborted' | 'maxEntries'>({
          signal,
          current: totalEntries,
          max: normalized.maxEntries,
          abortedReason: 'aborted',
          maxReason: 'maxEntries',
        });
        if (stopReason) {
          truncated = true;
          break;
        }

        const resolved = await resolveTreeEntry(
          entry,
          root,
          rootDirectories,
          gitignoreMatcher,
          signal
        );
        if (!resolved) continue;

        const parent = ensureParentNodes(
          rootNode,
          nodeByPath,
          resolved.relativePosix
        );

        upsertChildNode(parent, nodeByPath, resolved, childPathIndexByParent);

        if (
          normalized.includeSizes &&
          resolved.type === 'file' &&
          entry.stats
        ) {
          const node = nodeByPath.get(resolved.relativePosix);
          if (node) {
            node.size = entry.stats.size;
          }
        }

        totalEntries += 1;
        options.onProgress?.({ current: totalEntries });
      }

      sortTree(rootNode);

      return { root, tree: rootNode, truncated, totalEntries };
    }
  );
}

// ---------------------------------------------------------------------------

const TreeInputSchema = z.strictObject({
  path: OptionalPath.describe('Base directory (default: root)'),
  maxDepth: z
    .uint32()
    .min(0)
    .max(MAX_TREE_DEPTH)
    .optional()
    .default(DEFAULT_TREE_DEPTH)
    .describe(`Max depth (default: ${String(DEFAULT_TREE_DEPTH)})`),
  maxEntries: z
    .uint32()
    .min(1)
    .max(MAX_TREE_ENTRIES)
    .optional()
    .default(DEFAULT_TREE_ENTRIES)
    .describe('Max total entries (default: 1000)'),
  includeHidden: includeHiddenField(),
  includeIgnored: includeIgnoredField(),
  includeSizes: defaultFalseBoolean('Include file sizes'),
});

// Recursive tree schema (structurally typed to avoid named type in exported signatures)
const TreeNodeSchema: z.ZodType = z.lazy(
  (): z.ZodType =>
    z.strictObject({
      name: z.string().describe('Name'),
      type: FileTypeEnum.describe('Type'),
      relativePath: z.string().optional().describe('Relative path from root'),
      size: NonNegInt.optional().describe('Size (bytes)'),
      children: z
        .array(TreeNodeSchema)
        .optional()
        .describe('Child nodes (directories/symlinks)'),
    })
);
z.globalRegistry.add(TreeNodeSchema, { id: 'TreeNode' });

const TreeOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Success indicator'),
  root: z.string().describe('Root directory path'),
  tree: TreeNodeSchema.describe('Tree structure'),
  ascii: z.string().describe('ASCII tree representation'),
  totalEntries: NonNegInt.optional().describe('Total entries in tree'),
  continuation: ContinuationSchema.optional().describe(
    'Present when tree was cut; call the named tool with the given args to continue'
  ),
  resourceUri: z
    .string()
    .optional()
    .describe('Full ascii tree URI when externalised'),
});

const TREE_TOOL: ToolContract = {
  name: 'tree',
  title: 'Tree',
  description:
    'Render a directory tree (bounded recursion). Returns ASCII tree + structured JSON. ' +
    '`maxDepth=0` returns only the root node.',
  inputSchema: TreeInputSchema,
  outputSchema: TreeOutputSchema,
  annotations: READ_ONLY_TOOL_ANNOTATIONS,
  icons: DIRECTORY_ICONS,
  nuances: [
    '`maxDepth=0` returns only the root node.',
    'Result is bounded by both `maxDepth` and `maxEntries`.',
  ],
  taskSupport: 'optional',
  defaultTimeoutMs: DEFAULT_SEARCH_TIMEOUT_MS,
} as const;

function buildTreeContinuation(
  basePath: string,
  truncated: boolean,
  totalEntries: number
): z.infer<typeof ContinuationSchema> | undefined {
  if (!truncated) return undefined;
  return {
    tool: 'ls',
    args: { path: basePath },
    hint: `Tree was cut at ${String(totalEntries)} entries. Use ls to navigate directories individually.`,
  };
}

async function handleTree(
  args: z.infer<typeof TreeInputSchema>,
  signal?: AbortSignal,
  resourceStore?: ToolRegistrationOptions['resourceStore'],
  onProgress?: (progress: { current: number }) => void
): Promise<ToolResponse<z.infer<typeof TreeOutputSchema>>> {
  const basePath = resolvePathOrRoot(args.path);
  const result = await treeDirectory(basePath, {
    maxDepth: args.maxDepth,
    maxEntries: args.maxEntries,
    includeHidden: args.includeHidden,
    includeIgnored: args.includeIgnored,
    includeSizes: args.includeSizes,
    ...(signal ? { signal } : {}),
    ...(onProgress ? { onProgress } : {}),
  });

  const ascii = formatTreeAscii(result.tree);

  const externalized = maybeExternalizeTextContent(resourceStore, ascii, {
    name: `tree:${result.root}`,
    mimeType: 'text/plain',
  });

  if (externalized) {
    const { entry, preview } = externalized;
    const continuation = buildTreeContinuation(
      basePath,
      result.truncated,
      result.totalEntries
    );
    const structured: z.infer<typeof TreeOutputSchema> = {
      ok: true,
      root: result.root,
      tree: result.tree,
      ascii: preview,
      ...(continuation ? { continuation } : {}),
      totalEntries: result.totalEntries,
      resourceUri: entry.uri,
    };
    const text = result.truncated ? `${preview}\n[truncated]` : preview;
    return buildToolResponse(text, structured, [
      buildResourceLink({
        uri: entry.uri,
        name: entry.name,
        mimeType: entry.mimeType,
        description: 'Full ASCII tree',
        expiresAt: entry.expiresAt,
      }),
    ]);
  }

  const continuation = buildTreeContinuation(
    basePath,
    result.truncated,
    result.totalEntries
  );
  const structured: z.infer<typeof TreeOutputSchema> = {
    ok: true,
    root: result.root,
    tree: result.tree,
    ascii,
    ...(continuation ? { continuation } : {}),
    totalEntries: result.totalEntries,
  };

  const text = result.truncated ? `${ascii}\n[truncated]` : ascii;
  return buildToolResponse(text, structured);
}

export const TREE = defineTool<
  z.infer<typeof TreeInputSchema>,
  z.infer<typeof TreeOutputSchema>
>({
  contract: TREE_TOOL,
  defaultErrorCode: ErrorCode.NOT_DIRECTORY,
  run: async (args, ctx) => {
    const context = args.path ? basename(args.path) : '.';
    const label = `${TREE_TOOL.title}: ${context}`;
    const knownTotal = args.maxEntries;

    return runWithProgressSession(
      ctx,
      label,
      async (progress) => {
        const onProgress = ({ current }: { current: number }): void => {
          progress.update({
            current,
            total: knownTotal,
            message: `${label} [${current} entries]`,
          });
        };

        const result = await handleTree(
          args,
          ctx.signal,
          ctx.resourceStore,
          onProgress
        );
        const sc = result.structuredContent;
        const count = sc.totalEntries ?? 0;

        let suffix = `${count} ${count === 1 ? 'entry' : 'entries'}`;
        if (sc.continuation) suffix += ' [truncated]';

        const finalCurrent = resolveFinalProgressCurrent(progress, count);
        return { value: result, suffix, finalCurrent };
      },
      knownTotal
    );
  },
});
