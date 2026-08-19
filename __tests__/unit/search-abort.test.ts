/**
 * searchContent: an aborted scan is reported as incomplete.
 *
 * The signal carries both client cancellation and the tool's search timeout, so
 * an abort returns partial results rather than throwing — but it must set
 * `truncated`, or a cut-short scan reads as a finished one that found nothing.
 * The readFile rejection on abort used to land in the binary-file catch and be
 * swallowed outright.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PathGuard } from '../../src/core/path.js';
import { compileRegex, searchContent, searchFiles } from '../../src/core/search/engine.js';

describe('searchContent — abort marks the scan truncated', () => {
  let dir: string;
  let pathGuard: PathGuard;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'search-abort-'));
    await writeFile(join(dir, 'a.txt'), 'needle\n');
    await writeFile(join(dir, 'b.txt'), 'needle\n');
    pathGuard = await PathGuard.fromAllowedDirectories([dir]);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('returns truncated:true and no matches when the signal is already aborted', async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await searchContent(dir, 'needle', { signal: controller.signal }, pathGuard);

    assert.equal(result.matches.length, 0);
    assert.equal(result.summary.truncated, true, 'an aborted scan must not read as complete');
    assert.equal(result.summary.matchingLines, 0);
  });

  it('returns truncated:false and the matches when it runs to completion', async () => {
    const result = await searchContent(dir, 'needle', {}, pathGuard);

    assert.equal(result.matches.length, 2);
    assert.equal(result.summary.truncated, false);
    assert.equal(result.summary.filesMatched, 2);
  });
});

describe('searchContent — skipped files are counted, not silently dropped', () => {
  let dir: string;
  let pathGuard: PathGuard;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'search-skip-'));
    await writeFile(join(dir, 'small.txt'), 'needle\n');
    await writeFile(join(dir, 'big.txt'), `needle${'x'.repeat(2048)}\n`);
    pathGuard = await PathGuard.fromAllowedDirectories([dir]);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('counts oversized files in skippedTooLarge instead of reporting no match', async () => {
    const result = await searchContent(dir, 'needle', { maxFileSize: 1024 }, pathGuard);

    assert.equal(result.summary.skippedTooLarge, 1, 'the oversized file must be accounted for');
    assert.equal(result.summary.filesMatched, 1);
    assert.equal(result.summary.skippedInaccessible, 0);
  });

  it('leaves both counters at zero when every file is read', async () => {
    const result = await searchContent(dir, 'needle', {}, pathGuard);

    assert.equal(result.summary.skippedTooLarge, 0);
    assert.equal(result.summary.skippedInaccessible, 0);
    assert.equal(result.summary.filesMatched, 2);
  });
});

describe('compileRegex — unsupported constructs are rejected', () => {
  const rejected: [string, string][] = [
    ['lookahead', 'foo(?=bar)'],
    ['lookbehind', '(?<=foo)bar'],
    ['numeric backreference', '(foo)\\1'],
    ['named backreference', '(?<n>foo)\\k<n>'],
  ];

  for (const [label, pattern] of rejected) {
    it(`rejects ${label}`, () => {
      assert.throws(() => compileRegex(pattern), SyntaxError);
    });
  }

  it('accepts a named capture group, which is not a backreference', () => {
    assert.doesNotThrow(() => compileRegex('(?<name>foo)'));
  });

  it('accepts an escaped backslash followed by a digit', () => {
    // "\\1" is a literal backslash then a 1 — not a capture-group reference.
    assert.doesNotThrow(() => compileRegex('\\\\1'));
  });
});

describe('searchFiles — abort marks the scan truncated with a reason', () => {
  let dir: string;
  let pathGuard: PathGuard;

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), 'search-files-abort-'));
    await writeFile(join(dir, 'a.txt'), '');
    await writeFile(join(dir, 'b.txt'), '');
    pathGuard = await PathGuard.fromAllowedDirectories([dir]);
  });

  after(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports truncated with stoppedReason 'timeout' when the signal is aborted", async () => {
    const controller = new AbortController();
    controller.abort();

    const result = await searchFiles(dir, '*.txt', [], { signal: controller.signal }, pathGuard);

    assert.equal(result.results.length, 0);
    assert.equal(result.summary.truncated, true, 'an aborted scan must not read as complete');
    assert.equal(result.summary.stoppedReason, 'timeout');
  });

  it("reports stoppedReason 'maxResults' when the cap is hit, not 'timeout'", async () => {
    const result = await searchFiles(dir, '*.txt', [], { maxResults: 1 }, pathGuard);

    assert.equal(result.results.length, 1);
    assert.equal(result.summary.truncated, true);
    assert.equal(result.summary.stoppedReason, 'maxResults');
  });

  it('leaves stoppedReason unset when the scan runs to completion', async () => {
    const result = await searchFiles(dir, '*.txt', [], {}, pathGuard);

    assert.equal(result.results.length, 2);
    assert.equal(result.summary.truncated, false);
    assert.equal(result.summary.stoppedReason, undefined);
  });
});
