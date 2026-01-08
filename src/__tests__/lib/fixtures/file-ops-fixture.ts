import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { normalizePath } from '../../../lib/path-utils.js';
import { setAllowedDirectoriesResolved } from '../../../lib/path-validation/allowed-directories.js';

interface FileOpsFixture {
  testDir: string;
}

const TEST_DIR_PREFIX = 'mcp-fileops-test-';

async function ensureFixtureDirs(base: string): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join(base, 'src')),
    fs.mkdir(path.join(base, 'docs')),
    fs.mkdir(path.join(base, '.hidden')),
  ]);
}

function buildMultilineContent(): string {
  return Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join('\n');
}

function buildBinaryData(): Buffer {
  return Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
  ]);
}

async function writeFixtureFiles(
  base: string,
  lines: string,
  binaryData: Buffer
): Promise<void> {
  await Promise.all([
    fs.writeFile(
      path.join(base, 'README.md'),
      '# Test Project\nThis is a test.\n'
    ),
    fs.writeFile(
      path.join(base, 'src', 'index.ts'),
      'export const hello = "world";\n'
    ),
    fs.writeFile(
      path.join(base, 'src', 'utils.ts'),
      'export function add(a: number, b: number) { return a + b; }\n'
    ),
    fs.writeFile(
      path.join(base, 'docs', 'guide.md'),
      '# Guide\nSome documentation.\n'
    ),
    fs.writeFile(path.join(base, '.hidden', 'secret.txt'), 'hidden content'),
    fs.writeFile(path.join(base, 'multiline.txt'), lines),
    fs.writeFile(path.join(base, 'image.png'), binaryData),
  ]);
}

async function populateTestDir(base: string): Promise<void> {
  await ensureFixtureDirs(base);
  const lines = buildMultilineContent();
  const binaryData = buildBinaryData();
  await writeFixtureFiles(base, lines, binaryData);
}

async function createFixture(): Promise<FileOpsFixture> {
  const testDir = await fs.mkdtemp(path.join(os.tmpdir(), TEST_DIR_PREFIX));
  await populateTestDir(testDir);
  await setAllowedDirectoriesResolved([normalizePath(testDir)]);
  return { testDir };
}

async function cleanupFixture(testDir: string): Promise<void> {
  try {
    await fs.rm(testDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
}

let activeUsers = 0;
let fixturePromise: Promise<FileOpsFixture> | null = null;
let sharedFixture: FileOpsFixture | null = null;

export async function acquireFileOpsFixture(): Promise<FileOpsFixture> {
  activeUsers += 1;
  fixturePromise ??= createFixture();
  sharedFixture = await fixturePromise;
  return sharedFixture;
}

export async function releaseFileOpsFixture(): Promise<void> {
  const previousUsers = activeUsers;
  activeUsers = Math.max(0, activeUsers - 1);
  const shouldCleanup =
    previousUsers > 0 && activeUsers === 0 && sharedFixture !== null;
  const testDir = shouldCleanup ? (sharedFixture?.testDir ?? '') : '';
  sharedFixture = shouldCleanup ? null : sharedFixture;
  fixturePromise = shouldCleanup ? null : fixturePromise;
  await (shouldCleanup ? cleanupFixture(testDir) : Promise.resolve());
}
