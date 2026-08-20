import assert from 'node:assert/strict';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { readFileWithStats } from '../../src/core/fs.js';

let dir: string;

async function write(name: string, content: string): Promise<string> {
  const filePath = join(dir, name);
  await writeFile(filePath, content, 'utf-8');
  return filePath;
}

async function readRange(
  filePath: string,
  start: number,
  end?: number,
  maxSize?: number,
): Promise<string> {
  const stats = await stat(filePath);
  const result = await readFileWithStats(filePath, filePath, stats, {
    kind: 'range',
    start,
    ...(end !== undefined ? { end } : {}),
    ...(maxSize !== undefined ? { maxSize } : {}),
  });
  return result.content;
}

before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'fs-line-bounds-'));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('byte-bounded range reader', () => {
  it('rejects a single line larger than maxSize instead of materializing it', async () => {
    const filePath = await write('one-huge-line.txt', 'x'.repeat(50_000));
    await assert.rejects(readRange(filePath, 1, undefined, 1_000), (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /single line 50000 > 1000 bytes/);
      return true;
    });
  });

  it('does not fail on an over-long line the caller skipped past', async () => {
    const filePath = await write('huge-then-small.txt', `${'x'.repeat(50_000)}\nkeep\ntail`);
    assert.equal(await readRange(filePath, 2, 3, 1_000), 'keep\ntail');
  });

  it('does not fail on an over-long line past the requested end', async () => {
    // Deciding hasMoreLines pulls one line beyond `end`; that peek must not
    // size-check a line the caller never sees.
    const filePath = await write('small-then-huge.txt', `keep\nalso\n${'x'.repeat(50_000)}\n`);
    assert.equal(await readRange(filePath, 1, 2, 1_000), 'keep\nalso');
  });

  it('normalizes CRLF and keeps blank lines, matching readLines', async () => {
    const filePath = await write('crlf.txt', 'a\r\n\r\nb\r\n');
    assert.equal(await readRange(filePath, 1), 'a\n\nb');
  });

  it('emits a final line with no trailing newline, and none when one is present', async () => {
    const noNewline = await write('no-newline.txt', 'a\nb');
    const withNewline = await write('with-newline.txt', 'a\nb\n');
    assert.equal(await readRange(noNewline, 1), 'a\nb');
    assert.equal(await readRange(withNewline, 1), 'a\nb');
  });

  it('decodes a multi-byte character split across chunk boundaries', async () => {
    // 64 KiB chunks: pad so a 3-byte char straddles the first boundary.
    const filler = 'a'.repeat(64 * 1024 - 1);
    const filePath = await write('split-utf8.txt', `${filler}あrest\nsecond`);
    const content = await readRange(filePath, 1, 1, 1024 * 1024);
    assert.equal(content, `${filler}あrest`);
  });

  it('reports empty content for an empty file', async () => {
    const filePath = await write('empty.txt', '');
    assert.equal(await readRange(filePath, 1), '');
  });
});
