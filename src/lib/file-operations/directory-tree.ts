import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { DirectoryTreeResult, TreeEntry } from '../../config/types.js';
import {
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_MAX_FILES,
  DIR_TRAVERSAL_CONCURRENCY,
} from '../constants.js';
import { ErrorCode, McpError } from '../errors.js';
import { runWorkQueue } from '../fs-helpers.js';
import {
  validateExistingPath,
  validateExistingPathDetailed,
} from '../path-validation.js';
import {
  classifyAccessError,
  createExcludeMatcher,
  forEachDirectoryEntry,
} from './directory-helpers.js';

interface CollectedEntry {
  parentPath: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  depth: number;
}

interface TreeState {
  totalFiles: number;
  totalDirectories: number;
  maxDepthReached: number;
  skippedInaccessible: number;
  symlinksNotFollowed: number;
  truncated: boolean;
  collectedEntries: CollectedEntry[];
  directoriesFound: Set<string>;
}

function initTreeState(basePath: string): TreeState {
  return {
    totalFiles: 0,
    totalDirectories: 0,
    maxDepthReached: 0,
    skippedInaccessible: 0,
    symlinksNotFollowed: 0,
    truncated: false,
    collectedEntries: [],
    directoriesFound: new Set<string>([basePath]),
  };
}

function hitMaxFiles(state: TreeState, maxFiles: number): boolean {
  if (state.totalFiles < maxFiles) return false;
  state.truncated = true;
  return true;
}

function markTruncated(state: TreeState): void {
  state.truncated = true;
}

function addFileEntry(
  state: TreeState,
  params: { currentPath: string; depth: number },
  name: string,
  size: number | undefined
): void {
  state.totalFiles++;
  state.collectedEntries.push({
    parentPath: params.currentPath,
    name,
    type: 'file',
    size,
    depth: params.depth,
  });
}

function addDirectoryEntry(
  state: TreeState,
  params: { currentPath: string; depth: number },
  name: string,
  resolvedPath: string,
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  maxDepth: number
): void {
  state.totalDirectories++;
  state.directoriesFound.add(resolvedPath);
  state.collectedEntries.push({
    parentPath: params.currentPath,
    name,
    type: 'directory',
    depth: params.depth,
  });

  if (params.depth + 1 <= maxDepth) {
    enqueue({ currentPath: resolvedPath, depth: params.depth + 1 });
  } else {
    markTruncated(state);
  }
}

async function handleTreeNode(
  params: { currentPath: string; depth: number },
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  state: TreeState,
  options: {
    basePath: string;
    maxDepth: number;
    includeHidden: boolean;
    includeSize: boolean;
    maxFiles: number;
    shouldExclude: (name: string, relativePath: string) => boolean;
  }
): Promise<void> {
  if (hitMaxFiles(state, options.maxFiles)) return;
  if (params.depth > options.maxDepth) {
    markTruncated(state);
    return;
  }

  state.maxDepthReached = Math.max(state.maxDepthReached, params.depth);

  await forEachDirectoryEntry(
    params.currentPath,
    options.basePath,
    {
      includeHidden: options.includeHidden,
      shouldExclude: options.shouldExclude,
      onInaccessible: () => {
        state.skippedInaccessible++;
      },
      shouldStop: () => hitMaxFiles(state, options.maxFiles),
    },
    async ({ item, name, fullPath }) => {
      if (item.isSymbolicLink()) {
        state.symlinksNotFollowed++;
        return;
      }

      try {
        const { resolvedPath, isSymlink } =
          await validateExistingPathDetailed(fullPath);
        if (isSymlink) {
          state.symlinksNotFollowed++;
          return;
        }

        const stats = await fs.stat(resolvedPath);
        if (stats.isFile()) {
          addFileEntry(
            state,
            params,
            name,
            options.includeSize ? stats.size : undefined
          );
          return;
        }

        if (stats.isDirectory()) {
          addDirectoryEntry(
            state,
            params,
            name,
            resolvedPath,
            enqueue,
            options.maxDepth
          );
        }
      } catch (error) {
        if (classifyAccessError(error) === 'symlink') {
          state.symlinksNotFollowed++;
        } else {
          state.skippedInaccessible++;
        }
      }
    }
  );
}

function buildChildrenByParent(
  directoriesFound: Set<string>,
  collectedEntries: CollectedEntry[]
): Map<string, TreeEntry[]> {
  const childrenByParent = new Map<string, TreeEntry[]>();

  for (const dirPath of directoriesFound) {
    childrenByParent.set(dirPath, []);
  }

  for (const entry of collectedEntries) {
    const treeEntry: TreeEntry = {
      name: entry.name,
      type: entry.type,
    };
    if (entry.type === 'file' && entry.size !== undefined) {
      treeEntry.size = entry.size;
    }
    if (entry.type === 'directory') {
      const fullPath = path.join(entry.parentPath, entry.name);
      treeEntry.children = childrenByParent.get(fullPath) ?? [];
    }

    const siblings = childrenByParent.get(entry.parentPath);
    if (siblings) {
      siblings.push(treeEntry);
    }
  }

  return childrenByParent;
}

function sortTreeChildren(childrenByParent: Map<string, TreeEntry[]>): void {
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }
}

function buildTree(
  rootPath: string,
  childrenByParent: Map<string, TreeEntry[]>
): TreeEntry {
  const rootName = path.basename(rootPath);
  return {
    name: rootName || rootPath,
    type: 'directory',
    children: childrenByParent.get(rootPath) ?? [],
  };
}

export async function getDirectoryTree(
  dirPath: string,
  options: {
    maxDepth?: number;
    excludePatterns?: string[];
    includeHidden?: boolean;
    includeSize?: boolean;
    maxFiles?: number;
  } = {}
): Promise<DirectoryTreeResult> {
  const {
    maxDepth = DEFAULT_TREE_DEPTH,
    excludePatterns = [],
    includeHidden = false,
    includeSize = false,
    maxFiles,
  } = options;

  const basePath = await validateExistingPath(dirPath);
  const rootStats = await fs.stat(basePath);
  if (!rootStats.isDirectory()) {
    throw new McpError(
      ErrorCode.E_NOT_DIRECTORY,
      `Not a directory: ${dirPath}`,
      dirPath
    );
  }

  const state = initTreeState(basePath);
  const shouldExclude = createExcludeMatcher(excludePatterns);
  const effectiveMaxFiles = maxFiles ?? DEFAULT_TREE_MAX_FILES;

  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: basePath, depth: 0 }],
    async (params, enqueue) =>
      handleTreeNode(params, enqueue, state, {
        basePath,
        maxDepth,
        includeHidden,
        includeSize,
        maxFiles: effectiveMaxFiles,
        shouldExclude,
      }),
    DIR_TRAVERSAL_CONCURRENCY
  );

  const childrenByParent = buildChildrenByParent(
    state.directoriesFound,
    state.collectedEntries
  );
  sortTreeChildren(childrenByParent);
  const tree = buildTree(basePath, childrenByParent);

  return {
    tree,
    summary: {
      totalFiles: state.totalFiles,
      totalDirectories: state.totalDirectories,
      maxDepthReached: state.maxDepthReached,
      truncated: state.truncated,
      skippedInaccessible: state.skippedInaccessible,
      symlinksNotFollowed: state.symlinksNotFollowed,
    },
  };
}
