import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { DirectoryTreeResult, TreeEntry } from '../../config/types.js';
import { validateExistingPathDetailed } from '../path-validation.js';
import {
  classifyAccessError,
  forEachDirectoryEntry,
} from './directory-helpers.js';

export interface CollectedEntry {
  parentPath: string;
  name: string;
  type: 'file' | 'directory';
  size?: number;
  depth: number;
}

export interface TreeState {
  totalFiles: number;
  totalDirectories: number;
  maxDepthReached: number;
  skippedInaccessible: number;
  symlinksNotFollowed: number;
  truncated: boolean;
  collectedEntries: CollectedEntry[];
  directoriesFound: Set<string>;
}

export function initTreeState(basePath: string): TreeState {
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

function shouldStopAtMaxFiles(state: TreeState, maxFiles: number): boolean {
  return hitMaxFiles(state, maxFiles);
}

async function resolveEntryPath(
  fullPath: string,
  item: { isSymbolicLink: () => boolean },
  state: TreeState
): Promise<string | null> {
  if (item.isSymbolicLink()) {
    state.symlinksNotFollowed++;
    return null;
  }

  try {
    const { resolvedPath, isSymlink } =
      await validateExistingPathDetailed(fullPath);
    if (isSymlink) {
      state.symlinksNotFollowed++;
      return null;
    }
    return resolvedPath;
  } catch (error) {
    if (classifyAccessError(error) === 'symlink') {
      state.symlinksNotFollowed++;
    } else {
      state.skippedInaccessible++;
    }
    return null;
  }
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

async function processTreeEntry(
  params: { currentPath: string; depth: number },
  entry: {
    item: { isSymbolicLink: () => boolean };
    name: string;
    fullPath: string;
  },
  enqueue: (entry: { currentPath: string; depth: number }) => void,
  state: TreeState,
  options: { includeSize: boolean; maxDepth: number }
): Promise<void> {
  const resolvedPath = await resolveEntryPath(
    entry.fullPath,
    entry.item,
    state
  );
  if (!resolvedPath) return;

  const stats = await fs.stat(resolvedPath);
  if (stats.isFile()) {
    addFileEntry(
      state,
      params,
      entry.name,
      options.includeSize ? stats.size : undefined
    );
    return;
  }

  if (stats.isDirectory()) {
    addDirectoryEntry(
      state,
      params,
      entry.name,
      resolvedPath,
      enqueue,
      options.maxDepth
    );
  }
}

export async function handleTreeNode(
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
  if (shouldStopAtMaxFiles(state, options.maxFiles)) return;
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
      shouldStop: () => shouldStopAtMaxFiles(state, options.maxFiles),
    },
    async ({ item, name, fullPath }) =>
      processTreeEntry(params, { item, name, fullPath }, enqueue, state, {
        includeSize: options.includeSize,
        maxDepth: options.maxDepth,
      })
  );
}

export function buildChildrenByParent(
  directoriesFound: Set<string>,
  collectedEntries: CollectedEntry[]
): Map<string, TreeEntry[]> {
  const childrenByParent = new Map<string, TreeEntry[]>();

  for (const dirPath of directoriesFound) {
    childrenByParent.set(dirPath, []);
  }

  for (const entry of collectedEntries) {
    const treeEntry = buildTreeEntry(entry, childrenByParent);
    const siblings = childrenByParent.get(entry.parentPath);
    if (siblings) {
      siblings.push(treeEntry);
    }
  }

  return childrenByParent;
}

function buildTreeEntry(
  entry: CollectedEntry,
  childrenByParent: Map<string, TreeEntry[]>
): TreeEntry {
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
  return treeEntry;
}

export function sortTreeChildren(
  childrenByParent: Map<string, TreeEntry[]>
): void {
  for (const children of childrenByParent.values()) {
    children.sort((a, b) => {
      if (a.type !== b.type) {
        return a.type === 'directory' ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }
}

export function buildTree(
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

export function buildTreeSummary(
  state: TreeState
): DirectoryTreeResult['summary'] {
  return {
    totalFiles: state.totalFiles,
    totalDirectories: state.totalDirectories,
    maxDepthReached: state.maxDepthReached,
    truncated: state.truncated,
    skippedInaccessible: state.skippedInaccessible,
    symlinksNotFollowed: state.symlinksNotFollowed,
  };
}
