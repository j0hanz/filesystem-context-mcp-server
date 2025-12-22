import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { getDirectoryTree } from '../../../lib/file-operations.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

interface TreeEntry {
  name: string;
  children?: TreeEntry[];
}

const getTestDir = useFileOpsFixture();

function containsName(entry: TreeEntry, name: string): boolean {
  if (entry.name === name) return true;
  if (!entry.children) return false;
  return entry.children.some((child) => containsName(child, name));
}

async function createOutsideDirectory(): Promise<string> {
  const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-outside-'));
  await fs.writeFile(path.join(outsideDir, 'outside.txt'), 'outside');
  return outsideDir;
}

async function tryCreateSymlink(
  baseDir: string,
  outsideDir: string
): Promise<{ linkPath: string; created: boolean }> {
  const linkPath = path.join(baseDir, 'escape');
  const linkType: 'junction' | 'dir' =
    process.platform === 'win32' ? 'junction' : 'dir';
  try {
    await fs.symlink(outsideDir, linkPath, linkType);
    return { linkPath, created: true };
  } catch {
    return { linkPath, created: false };
  }
}

async function cleanupSymlink(
  linkPath: string,
  outsideDir: string
): Promise<void> {
  await fs.rm(linkPath, { recursive: true, force: true }).catch(() => {});
  await fs.rm(outsideDir, { recursive: true, force: true }).catch(() => {});
}

it('getDirectoryTree returns tree structure', async () => {
  const result = await getDirectoryTree(getTestDir());
  expect(result.tree.type).toBe('directory');
  expect(result.tree.children).toBeDefined();
  expect(result.tree.children?.length).toBeGreaterThan(0);
});

it('getDirectoryTree respects maxDepth', async () => {
  const result = await getDirectoryTree(getTestDir(), { maxDepth: 1 });
  expect(result.summary.maxDepthReached).toBeLessThanOrEqual(1);
});

it('getDirectoryTree excludes patterns', async () => {
  const result = await getDirectoryTree(getTestDir(), {
    excludePatterns: ['docs'],
  });
  const hasDocsDir = result.tree.children?.some((c) => c.name === 'docs');
  expect(hasDocsDir).toBe(false);
});

it('getDirectoryTree includes sizes when specified', async () => {
  const result = await getDirectoryTree(getTestDir(), { includeSize: true });
  const fileEntry = result.tree.children?.find((c) => c.type === 'file');
  expect(fileEntry?.size).toBeDefined();
});

it('getDirectoryTree skips symlinks that escape allowed directories', async () => {
  const outsideDir = await createOutsideDirectory();
  const { linkPath, created } = await tryCreateSymlink(
    getTestDir(),
    outsideDir
  );
  try {
    if (!created) {
      expect(created).toBe(false);
      return;
    }
    const result = await getDirectoryTree(getTestDir(), { maxDepth: 3 });
    const childNames = (result.tree.children ?? []).map((c) => c.name);
    expect(childNames.includes('escape')).toBe(false);
    expect(containsName(result.tree as TreeEntry, 'outside.txt')).toBe(false);
    expect(result.summary.symlinksNotFollowed).toBeGreaterThanOrEqual(1);
  } finally {
    await cleanupSymlink(linkPath, outsideDir);
  }
});
