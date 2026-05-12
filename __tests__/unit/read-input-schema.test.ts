import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReadFileInputSchema } from '../../src/tools/read.js';

describe('ReadFileInputSchema superRefine early returns', () => {
  it('emits only the path-missing error when conflicting range params are also present', () => {
    // Root cause: no path provided. Secondary issue: head+startLine conflict.
    // After the fix, only the root-cause error should be reported.
    const result = ReadFileInputSchema.safeParse({
      head: 5,
      startLine: 1,
    });
    assert.equal(result.success, false);
    const issues = result.error.issues;
    assert.equal(
      issues.length,
      1,
      `Expected 1 issue, got ${issues.length}: ${JSON.stringify(issues.map((i) => i.message))}`,
    );
    assert.equal(issues[0]?.message, "Either 'path' or 'paths' must be provided");
  });

  it('emits only the mutual-exclusion error when both path and paths are given with offset', () => {
    // Root cause: both path and paths provided. Secondary issue: offset-in-batch-mode.
    const result = ReadFileInputSchema.safeParse({
      path: '/tmp/file.txt',
      paths: ['/tmp/file.txt'],
      offset: 0,
    });
    assert.equal(result.success, false);
    const issues = result.error.issues;
    assert.equal(
      issues.length,
      1,
      `Expected 1 issue, got ${issues.length}: ${JSON.stringify(issues.map((i) => i.message))}`,
    );
    assert.equal(issues[0]?.message, "Cannot use both 'path' and 'paths'");
  });
});
