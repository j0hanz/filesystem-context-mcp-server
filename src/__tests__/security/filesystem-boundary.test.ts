import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import fg from 'fast-glob';
import { expect, it } from 'vitest';

function getRepoRoot(): string {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(currentDir, '../../../../');
}

function hasFsImport(source: string): boolean {
  return (
    /from\s+['"]node:fs\/promises['"]/u.test(source) ||
    /from\s+['"]node:fs['"]/u.test(source)
  );
}

function normalizeRelPath(relPath: string): string {
  return relPath.replace(/\\/gu, '/');
}

function getAllowedFsImportFiles(): Set<string> {
  return new Set<string>([
    'src/server.ts',
    'src/lib/path-validation.ts',
    'src/lib/file-operations.ts',
    'src/lib/fs-helpers.ts',
    'src/lib/file-operations/search-content.ts',
  ]);
}

async function listSourceFiles(repoRoot: string): Promise<string[]> {
  return await fg(['src/**/*.ts'], {
    cwd: repoRoot,
    ignore: ['src/__tests__/**'],
    onlyFiles: true,
    dot: false,
  });
}

async function collectFsImportOffenders(
  repoRoot: string,
  sourceFiles: string[],
  allowedFsImportFiles: Set<string>
): Promise<string[]> {
  const offenders: string[] = [];
  for (const relPath of sourceFiles) {
    const absPath = path.join(repoRoot, relPath);
    const content = await fs.readFile(absPath, 'utf-8');
    if (!hasFsImport(content)) continue;
    if (!allowedFsImportFiles.has(normalizeRelPath(relPath))) {
      offenders.push(relPath);
    }
  }
  return offenders;
}

it('keeps direct node:fs imports inside boundary modules', async () => {
  const repoRoot = getRepoRoot();
  const sourceFiles = await listSourceFiles(repoRoot);
  const allowedFsImportFiles = getAllowedFsImportFiles();
  const offenders = await collectFsImportOffenders(
    repoRoot,
    sourceFiles,
    allowedFsImportFiles
  );

  expect(
    offenders,
    `Unexpected node:fs imports detected outside boundary modules. ` +
      `To keep "validate-before-access" auditable, route filesystem access through ` +
      `src/lib/file-operations.ts and src/lib/fs-helpers.ts (and validate paths in src/lib/path-validation.ts).`
  ).toEqual([]);
});
