import * as path from 'node:path';

import {
  DEFAULT_EXCLUDE_PATTERNS,
  DEFAULT_SEARCH_TIMEOUT_MS,
} from '../constants.js';
import { withTimedAbortSignal } from '../fs-helpers.js';
import { toPosixPath } from '../paths.js';
import { isSensitivePath } from '../paths.js';
import {
  isPathWithinDirectories,
  normalizePath,
  validateExistingDirectory,
  validateExistingPathDetailed,
} from '../paths.js';
import {
  isEntryAccessibleByType,
  resolveEntryType,
  resolveStopReason,
} from './common.js';
import type { DirentLike, EntryType } from './common.js';
import { isIgnoredByGitignore, loadRootGitignore } from './gitignore.js';
import { globEntries } from './glob-engine.js';

interface TreeEntry {
  name: string;
  type: EntryType;
  relativePath: string;
  children?: TreeEntry[];
}

interface TreeOptions {
  maxDepth?: number;
  maxEntries?: number;
  includeHidden?: boolean;
  includeIgnored?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: (progress: { total?: number; current: number }) => void;
}

interface NormalizedOptions {
  maxDepth: number;
  maxEntries: number;
  includeHidden: boolean;
  includeIgnored: boolean;
  timeoutMs: number;
}

interface TreeResult {
  root: string;
  tree: TreeEntry;
  truncated: boolean;
  totalEntries: number;
}

function toSafeNonNegativeInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const asInt = Math.floor(value);
  return asInt >= 0 ? asInt : fallback;
}

function toSafePositiveInt(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  const asInt = Math.floor(value);
  return asInt > 0 ? asInt : fallback;
}

function toSafeBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value !== 'boolean') return fallback;
  return value;
}

function normalizeOptions(options: TreeOptions): NormalizedOptions {
  return {
    maxDepth: toSafeNonNegativeInt(options.maxDepth, 5),
    maxEntries: toSafeNonNegativeInt(options.maxEntries, 1000),
    includeHidden: toSafeBoolean(options.includeHidden, false),
    includeIgnored: toSafeBoolean(options.includeIgnored, false),
    timeoutMs: toSafePositiveInt(options.timeoutMs, DEFAULT_SEARCH_TIMEOUT_MS),
  };
}

function ensureParentNodes(
  rootNode: TreeEntry,
  nodeByPath: Map<string, TreeEntry>,
  relativePath: string
): TreeEntry {
  const normalized = toPosixPath(relativePath);
  if (normalized.length === 0 || normalized === '.') return rootNode;

  const segments: string[] = [];
  for (const segment of normalized.split('/')) {
    if (segment.length > 0) {
      segments.push(segment);
    }
  }
  const parentSegmentCount = Math.max(0, segments.length - 1);
  let current = rootNode;
  let currentPath = '';

  for (let index = 0; index < parentSegmentCount; index += 1) {
    const segment = segments[index];
    if (!segment) continue;
    currentPath =
      currentPath.length === 0
        ? segment
        : path.posix.join(currentPath, segment);

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

function sortTree(node: TreeEntry): void {
  if (!node.children) return;
  node.children.sort(compareTreeEntries);
  for (const child of node.children) {
    sortTree(child);
  }
}

function compareTreeEntries(a: TreeEntry, b: TreeEntry): number {
  const diff = getTreeTypeRank(a.type) - getTreeTypeRank(b.type);
  if (diff !== 0) return diff;
  return a.name.localeCompare(b.name);
}

function getTreeTypeRank(type: EntryType): number {
  if (type === 'directory') return 0;
  if (type === 'file') return 1;
  return 2;
}

async function resolveTreeEntry(
  entry: {
    path: string;
    dirent: DirentLike;
  },
  root: string,
  rootDirectories: readonly string[],
  gitignoreMatcher: Awaited<ReturnType<typeof loadRootGitignore>>,
  signal: AbortSignal,
  accessDeps: Parameters<typeof isEntryAccessibleByType>[4]
): Promise<{
  type: EntryType;
  relativePosix: string;
  name: string;
} | null> {
  const type = resolveEntryType(entry.dirent);
  const isAccessible = await isEntryAccessibleByType(
    entry.path,
    type,
    rootDirectories,
    signal,
    accessDeps
  );
  if (!isAccessible) {
    return null;
  }

  if (
    gitignoreMatcher &&
    isIgnoredByGitignore(gitignoreMatcher, root, entry.path, {
      isDirectory: type === 'directory',
    })
  ) {
    return null;
  }

  const relative = path.relative(root, entry.path) || path.basename(entry.path);
  const relativePosix = toPosixPath(relative);
  const name = path.basename(entry.path);
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
    // Avoid duplicate directory nodes when a child file is encountered before the directory entry.
    // Prefer preserving an existing populated directory node over overwriting it.
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

export function formatTreeAscii(tree: TreeEntry): string {
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

export async function treeDirectory(
  dirPath: string,
  options: TreeOptions = {}
): Promise<TreeResult> {
  const normalized = normalizeOptions(options);
  return withTimedAbortSignal(
    options.signal,
    normalized.timeoutMs,
    async (signal) => {
      const root = await validateExistingDirectory(dirPath, signal);
      const rootNormalized = normalizePath(root);
      const rootDirectories = [rootNormalized];
      const accessDeps = {
        normalizePath,
        isPathWithinDirectories,
        isSensitivePath,
        validateSymlinkPath: validateExistingPathDetailed,
      };

      const excludePatterns = normalized.includeIgnored
        ? []
        : DEFAULT_EXCLUDE_PATTERNS;

      const gitignoreMatcher = normalized.includeIgnored
        ? null
        : await loadRootGitignore(root, signal);

      const rootNode: TreeEntry = {
        name: path.basename(root) || root,
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
        stats: false,
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
          signal,
          accessDeps
        );
        if (!resolved) {
          continue;
        }

        const parent = ensureParentNodes(
          rootNode,
          nodeByPath,
          resolved.relativePosix
        );

        upsertChildNode(parent, nodeByPath, resolved, childPathIndexByParent);
        totalEntries += 1;
        options.onProgress?.({ current: totalEntries });
      }

      sortTree(rootNode);

      return {
        root,
        tree: rootNode,
        truncated,
        totalEntries,
      };
    }
  );
}
