/**
 * Output-parity tests: worker path vs. inline path.
 *
 * Does NOT import helpers.ts (which sets FS_DISABLE_WORKERS=1).
 * Calls runInWorker directly and compares against the diff library's
 * inline equivalents to confirm identical output.
 */
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { applyPatch, createTwoFilesPatch, formatPatch, parsePatch, structuredPatch } from 'diff';

import { runInWorker, shutdownWorkerPool } from '../../src/lib/worker-pool.js';

const OLD = 'line1\nline2\nline3\n';
const NEW = 'line1\nLINE2\nline3\n';

after(async () => {
  await shutdownWorkerPool();
});

describe('worker output parity', () => {
  it('diff task matches structuredPatch inline', async () => {
    const workerResult = await runInWorker('diff', {
      oldStr: OLD,
      newStr: NEW,
      oldHeader: 'old.txt',
      newHeader: 'new.txt',
    });

    const inlineResult = structuredPatch('old.txt', 'new.txt', OLD, NEW);

    assert.equal(workerResult.hunks.length, inlineResult.hunks.length);
    assert.deepEqual(
      workerResult.hunks.map((h) => h.lines),
      inlineResult.hunks.map((h) => h.lines),
    );
  });

  it('createPatch task matches createTwoFilesPatch inline', async () => {
    const workerResult = await runInWorker('createPatch', {
      oldStr: OLD,
      newStr: NEW,
      oldHeader: 'old.txt',
      newHeader: 'new.txt',
    });

    const inlineResult = createTwoFilesPatch('old.txt', 'new.txt', OLD, NEW);

    assert.equal(workerResult, inlineResult);
  });

  it('applyPatch task matches applyPatch inline', async () => {
    const parsed0 = parsePatch(createTwoFilesPatch('old.txt', 'new.txt', OLD, NEW))[0];
    assert.ok(parsed0 !== undefined, 'expected a parsed patch');
    const patchText = formatPatch(parsed0);

    const workerResult = await runInWorker('applyPatch', {
      source: OLD,
      patchText,
    });

    const parsedDiff = parsePatch(patchText)[0];
    assert.ok(parsedDiff !== undefined, 'expected parsed diff for inline');
    const inlineResult = applyPatch(OLD, parsedDiff);

    assert.equal(workerResult.applied, typeof inlineResult === 'string' ? inlineResult : false);
  });

  it('applyPatch returns false for non-applicable patch', async () => {
    const parsed0 = parsePatch(createTwoFilesPatch('old.txt', 'new.txt', OLD, NEW))[0];
    assert.ok(parsed0 !== undefined, 'expected a parsed patch');
    const patchText = formatPatch(parsed0);
    const unrelatedSource = 'totally\ndifferent\ncontent\n';

    const workerResult = await runInWorker('applyPatch', {
      source: unrelatedSource,
      patchText,
      fuzzFactor: 0,
    });

    // diff library returns false or unchanged source on patch failure
    const parsedDiff = parsePatch(patchText)[0];
    assert.ok(parsedDiff !== undefined, 'expected parsed diff for inline');
    const inlineResult = applyPatch(unrelatedSource, parsedDiff, {
      fuzzFactor: 0,
    });

    assert.equal(workerResult.applied, typeof inlineResult === 'string' ? inlineResult : false);
  });
});
