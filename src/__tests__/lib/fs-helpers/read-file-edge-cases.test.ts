import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import { expect, it } from 'vitest';

import { readFile } from '../../../lib/fs-helpers.js';
import { useFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const getTestDir = useFileOpsFixture();

it('readFile rejects when both head and tail are provided', async () => {
  await expect(
    readFile(path.join(getTestDir(), 'multiline.txt'), { head: 5, tail: 5 })
  ).rejects.toThrow(/Cannot specify multiple/);
});

it('readFile rejects when lineRange and head are provided', async () => {
  await expect(
    readFile(path.join(getTestDir(), 'multiline.txt'), {
      lineRange: { start: 1, end: 5 },
      head: 5,
    })
  ).rejects.toThrow(/Cannot specify multiple/);
});

it('readFile rejects invalid lineRange start', async () => {
  await expect(
    readFile(path.join(getTestDir(), 'multiline.txt'), {
      lineRange: { start: 0, end: 5 },
    })
  ).rejects.toThrow(/start must be at least 1/);
});

it('readFile rejects lineRange where end < start', async () => {
  await expect(
    readFile(path.join(getTestDir(), 'multiline.txt'), {
      lineRange: { start: 10, end: 5 },
    })
  ).rejects.toThrow(/end.*must be >= start/);
});

it('readFile handles reading beyond file length gracefully', async () => {
  const result = await readFile(path.join(getTestDir(), 'multiline.txt'), {
    lineRange: { start: 95, end: 200 },
  });
  expect(result.content).toContain('Line 100');
  expect(result.truncated).toBe(true);
});

it('readFile head read is not truncated when file is shorter than head', async () => {
  const result = await readFile(path.join(getTestDir(), 'multiline.txt'), {
    head: 200,
  });
  expect(result.content).toContain('Line 100');
  expect(result.truncated).toBe(false);
  expect(result.hasMoreLines).toBe(false);
});

it('readFile tail read is not truncated when file is shorter than tail', async () => {
  const result = await readFile(path.join(getTestDir(), 'multiline.txt'), {
    tail: 200,
  });
  expect(result.content).toContain('Line 1');
  expect(result.truncated).toBe(false);
  expect(result.hasMoreLines).toBe(false);
});

it('readFile handles empty file', async () => {
  const emptyFile = path.join(getTestDir(), 'empty-read.txt');
  await fs.writeFile(emptyFile, '');

  const result = await readFile(emptyFile);
  expect(result.content).toBe('');
  expect(result.truncated).toBe(false);

  await fs.rm(emptyFile);
});
