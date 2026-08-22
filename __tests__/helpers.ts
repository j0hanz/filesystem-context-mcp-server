import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createServer } from '../src/server.js';
import type { FilesystemServerContext } from '../src/server.js';

/** Create an isolated temp directory for a test. */
export async function createTestRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fsmcp-test-'));
}

/** Remove a test root directory. */
export async function cleanupTestRoot(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Create an MCP server context pointed at the given allowed dirs. */
export async function createTestServer(
  allowedDirs: string[],
  options: { readOnly?: boolean } = {},
): Promise<FilesystemServerContext> {
  return createServer({
    cliAllowedDirs: allowedDirs,
    ...(options.readOnly ? { readOnly: true } : {}),
  });
}

/** Write a text file into the test root. */
export async function writeTestFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const fullPath = join(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

/** Generate a file with N lines. */
export async function writeNLineFile(
  root: string,
  name: string,
  lineCount: number,
): Promise<string> {
  const lines = Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}`);
  return writeTestFile(root, name, lines.join('\n') + '\n');
}
