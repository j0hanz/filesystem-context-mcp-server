import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

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

const ALLOWED_FS_IMPORT_FILES = new Set<string>([
  'src/server.ts',
  'src/tools.ts',
  'src/completions.ts',
  'src/cli.ts',
  'src/lib/path-validation.ts',
  'src/lib/fs-helpers.ts',
]);
// src/tools/ and src/server/ enforce path validation via PathPolicy before any fs call.
const ALLOWED_FS_IMPORT_PREFIXES = [
  'src/lib/file-operations/',
  'src/tools/',
  'src/server/',
];

function isAllowedFsImportFile(relPath: string): boolean {
  const normalized = normalizeRelPath(relPath);
  return ALLOWED_FS_IMPORT_FILES.has(normalized)
    ? true
    : ALLOWED_FS_IMPORT_PREFIXES.some((prefix) =>
        normalized.startsWith(prefix)
      );
}

async function listSourceFiles(repoRoot: string): Promise<string[]> {
  const results: string[] = [];
  for await (const entry of fs.glob('src/**/*.ts', {
    cwd: repoRoot,
    exclude: ['src/__tests__/**'],
  })) {
    results.push(entry);
  }
  return results;
}

async function collectFsImportOffenders(
  repoRoot: string,
  sourceFiles: string[],
  allowFsImport: (relPath: string) => boolean
): Promise<string[]> {
  const results = await Promise.all(
    sourceFiles.map(async (relPath) => {
      const absPath = path.join(repoRoot, relPath);
      const content = await fs.readFile(absPath, 'utf-8');
      const isOffender = hasFsImport(content) && !allowFsImport(relPath);
      return isOffender ? relPath : null;
    })
  );
  return results.filter((value): value is string => value !== null);
}

void describe('filesystem boundary', () => {
  void it('keeps direct node:fs imports inside boundary modules', async () => {
    const repoRoot = getRepoRoot();
    const sourceFiles = await listSourceFiles(repoRoot);
    const offenders = await collectFsImportOffenders(
      repoRoot,
      sourceFiles,
      isAllowedFsImportFile
    );

    assert.deepStrictEqual(
      offenders,
      [],
      `Unexpected node:fs imports detected outside boundary modules. ` +
        `To keep "validate-before-access" auditable, route filesystem access through ` +
        `src/lib/file-operations/* and src/lib/fs-helpers.ts (and validate paths in src/lib/path-validation.ts).`
    );
  });
});
