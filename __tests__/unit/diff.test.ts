import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildPatchDiff } from '../../src/core/diff.js';

describe('buildPatchDiff', () => {
  it('returns unified diff headers and the changed line', async () => {
    const patch = await buildPatchDiff('file.txt', 'line one\n', 'line two\n');
    assert.ok(patch.includes('---'));
    assert.ok(patch.includes('+++'));
    assert.ok(patch.includes('-line one'));
    assert.ok(patch.includes('+line two'));
  });

  it('resolves to a string without throwing for identical inputs', async () => {
    const patch = await buildPatchDiff('file.txt', 'same\n', 'same\n');
    assert.equal(typeof patch, 'string');
  });
});
