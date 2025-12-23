import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, expect, it } from 'vitest';

import { findUTF8Boundary } from '../../../lib/fs-helpers/readers/utf8.js';

const EURO_CHAR = '\u20AC';
const HAN_CHAR = '\u4E2D';
const CONTENT = `A${EURO_CHAR}B${HAN_CHAR}C`;

let tempDir = '';
let filePath = '';
let handle: fs.FileHandle | null = null;

beforeAll(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-utf8-'));
  filePath = path.join(tempDir, 'utf8.txt');
  await fs.writeFile(filePath, CONTENT, 'utf-8');
  handle = await fs.open(filePath, 'r');
});

afterAll(async () => {
  await handle?.close().catch(() => {});
  await fs.rm(tempDir, { recursive: true, force: true });
});

it('returns 0 for non-positive positions', async () => {
  if (!handle) throw new Error('Missing file handle');
  expect(await findUTF8Boundary(handle, 0)).toBe(0);
});

it('aligns to the start of a multibyte sequence', async () => {
  if (!handle) throw new Error('Missing file handle');
  const buffer = Buffer.from(CONTENT, 'utf8');
  const euroStart = buffer.indexOf(Buffer.from(EURO_CHAR));
  const insideEuro = euroStart + 1;

  expect(await findUTF8Boundary(handle, insideEuro)).toBe(euroStart);
});

it('returns the previous boundary when positioned at a later character', async () => {
  if (!handle) throw new Error('Missing file handle');
  const buffer = Buffer.from(CONTENT, 'utf8');
  const asciiPos = buffer.indexOf(Buffer.from('B'));
  const euroStart = buffer.indexOf(Buffer.from(EURO_CHAR));

  expect(await findUTF8Boundary(handle, asciiPos)).toBe(euroStart);
});
