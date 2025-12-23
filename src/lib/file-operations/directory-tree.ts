import * as fs from 'node:fs/promises';

import type { DirectoryTreeResult } from '../../config/types.js';
import {
  DEFAULT_TREE_DEPTH,
  DEFAULT_TREE_MAX_FILES,
  DIR_TRAVERSAL_CONCURRENCY,
} from '../constants.js';
import { ErrorCode, McpError } from '../errors.js';
import { runWorkQueue } from '../fs-helpers.js';
import { mergeDefined } from '../merge-defined.js';
import { validateExistingPath } from '../path-validation.js';
import { createExcludeMatcher } from './directory-helpers.js';
import {
  buildChildrenByParent,
  buildTree,
  buildTreeSummary,
  handleTreeNode,
  initTreeState,
  sortTreeChildren,
  type TreeState,
} from './directory-tree-helpers.js';

async function resolveBaseDirectory(dirPath: string): Promise<string> {
  const basePath = await validateExistingPath(dirPath);
  const rootStats = await fs.stat(basePath);
  if (!rootStats.isDirectory()) {
    throw new McpError(
      ErrorCode.E_NOT_DIRECTORY,
      `Not a directory: ${dirPath}`,
      dirPath
    );
  }
  return basePath;
}

async function buildTreeState(
  basePath: string,
  options: {
    maxDepth: number;
    includeHidden: boolean;
    includeSize: boolean;
    maxFiles: number;
    shouldExclude: (name: string, relativePath: string) => boolean;
    signal?: AbortSignal;
  }
): Promise<TreeState> {
  const state = initTreeState(basePath);
  await runWorkQueue<{ currentPath: string; depth: number }>(
    [{ currentPath: basePath, depth: 0 }],
    async (params, enqueue) =>
      handleTreeNode(params, enqueue, state, {
        basePath,
        maxDepth: options.maxDepth,
        includeHidden: options.includeHidden,
        includeSize: options.includeSize,
        maxFiles: options.maxFiles,
        shouldExclude: options.shouldExclude,
      }),
    DIR_TRAVERSAL_CONCURRENCY,
    options.signal
  );
  return state;
}

export async function getDirectoryTree(
  dirPath: string,
  options: {
    maxDepth?: number;
    excludePatterns?: string[];
    includeHidden?: boolean;
    includeSize?: boolean;
    maxFiles?: number;
    signal?: AbortSignal;
  } = {}
): Promise<DirectoryTreeResult> {
  const normalized = normalizeTreeOptions(options);
  const basePath = await resolveBaseDirectory(dirPath);
  const shouldExclude = createExcludeMatcher(normalized.excludePatterns);

  const state = await buildTreeState(basePath, {
    maxDepth: normalized.maxDepth,
    includeHidden: normalized.includeHidden,
    includeSize: normalized.includeSize,
    maxFiles: normalized.maxFiles,
    shouldExclude,
    signal: options.signal,
  });

  const childrenByParent = buildChildrenByParent(
    state.directoriesFound,
    state.collectedEntries
  );
  sortTreeChildren(childrenByParent);
  const tree = buildTree(basePath, childrenByParent);

  return {
    tree,
    summary: buildTreeSummary(state),
  };
}

function normalizeTreeOptions(options: {
  maxDepth?: number;
  excludePatterns?: string[];
  includeHidden?: boolean;
  includeSize?: boolean;
  maxFiles?: number;
}): {
  maxDepth: number;
  excludePatterns: string[];
  includeHidden: boolean;
  includeSize: boolean;
  maxFiles: number;
} {
  const defaults = {
    maxDepth: DEFAULT_TREE_DEPTH,
    excludePatterns: [] as string[],
    includeHidden: false,
    includeSize: false,
    maxFiles: DEFAULT_TREE_MAX_FILES,
  };
  return mergeDefined(defaults, options);
}
