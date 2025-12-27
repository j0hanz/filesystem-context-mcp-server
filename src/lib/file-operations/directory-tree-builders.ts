import * as path from 'node:path';

import type { DirectoryTreeResult, TreeEntry } from '../../config/types.js';
import type { CollectedEntry, TreeState } from './directory-tree-helpers.js';

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
