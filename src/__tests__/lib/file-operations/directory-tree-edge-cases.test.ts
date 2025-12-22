import { expect, it } from 'vitest';

import { getDirectoryTree } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

interface TreeChild {
  type: string;
}

const getTestDir = useFileOpsFixture();

function firstIndexOfType(children: TreeChild[], type: string): number | null {
  const index = children.findIndex((child) => child.type === type);
  return index >= 0 ? index : null;
}

function lastIndexOfType(children: TreeChild[], type: string): number | null {
  for (let i = children.length - 1; i >= 0; i--) {
    if (children[i]?.type === type) return i;
  }
  return null;
}

it('getDirectoryTree handles deep nesting with truncation', async () => {
  const result = await getDirectoryTree(getTestDir(), { maxDepth: 0 });
  expect(result.summary.truncated).toBe(true);
});

it('getDirectoryTree sorts entries with directories first', async () => {
  const result = await getDirectoryTree(getTestDir());
  const children = result.tree.children ?? [];
  const lastDirIndex = lastIndexOfType(children, 'directory');
  const firstFileIndex = firstIndexOfType(children, 'file');
  if (lastDirIndex !== null && firstFileIndex !== null) {
    expect(lastDirIndex).toBeLessThan(firstFileIndex);
  }
});
