import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { normalizePath } from '../../../lib/path-utils.js';
import { setAllowedDirectories } from '../../../lib/path-validation.js';

interface FileOpsFixture {
  testDir: string;
}

const TEST_DIR_PREFIX = 'mcp-fileops-test-';

async function createBaseDir(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), TEST_DIR_PREFIX));
}

async function createDirectories(base: string): Promise<void> {
  await Promise.all([
    fs.mkdir(path.join(base, 'src')),
    fs.mkdir(path.join(base, 'docs')),
    fs.mkdir(path.join(base, '.hidden')),
  ]);
}

async function writeReadme(base: string): Promise<void> {
  await fs.writeFile(
    path.join(base, 'README.md'),
    '# Test Project\nThis is a test.\n'
  );
}

async function writeSourceFiles(base: string): Promise<void> {
  await Promise.all([
    fs.writeFile(
      path.join(base, 'src', 'index.ts'),
      'export const hello = "world";\n'
    ),
    fs.writeFile(
      path.join(base, 'src', 'utils.ts'),
      'export function add(a: number, b: number) { return a + b; }\n'
    ),
  ]);
}

async function writeDocs(base: string): Promise<void> {
  await fs.writeFile(
    path.join(base, 'docs', 'guide.md'),
    '# Guide\nSome documentation.\n'
  );
}

async function writeHidden(base: string): Promise<void> {
  await fs.writeFile(
    path.join(base, '.hidden', 'secret.txt'),
    'hidden content'
  );
}

async function writeMultiline(base: string): Promise<void> {
  const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join(
    '\n'
  );
  await fs.writeFile(path.join(base, 'multiline.txt'), lines);
}

async function writeBinary(base: string): Promise<void> {
  const binaryData = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
  ]);
  await fs.writeFile(path.join(base, 'image.png'), binaryData);
}

async function populateTestDir(base: string): Promise<void> {
  await Promise.all([
    writeReadme(base),
    writeSourceFiles(base),
    writeDocs(base),
    writeHidden(base),
    writeMultiline(base),
    writeBinary(base),
  ]);
}

async function createFixture(): Promise<FileOpsFixture> {
  const testDir = await createBaseDir();
  await createDirectories(testDir);
  await populateTestDir(testDir);
  setAllowedDirectories([normalizePath(testDir)]);
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
  if (activeUsers === 0) return;
  activeUsers -= 1;
  if (activeUsers !== 0 || !sharedFixture) return;
  const { testDir } = sharedFixture;
  sharedFixture = null;
  fixturePromise = null;
  await cleanupFixture(testDir);
}
