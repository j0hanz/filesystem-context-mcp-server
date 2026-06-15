import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ReadFileInputSchema } from '../../src/tools/read.js';

describe('ReadFileInputSchema superRefine validation', () => {
  it('reports both the path-missing error and conflicting range params', () => {
    // All validation errors are reported regardless of path-selection state.
    const result = ReadFileInputSchema.safeParse({
      head: 5,
      startLine: 1,
    });
    assert.equal(result.success, false);
    const messages = result.error.issues.map((i) => i.message);
    assert.ok(
      messages.includes("Either 'path' or 'paths' must be provided"),
      `Missing path error. Got: ${JSON.stringify(messages)}`,
    );
    assert.ok(
      messages.includes("Cannot use 'head' with 'startLine'/'endLine'"),
      `Missing range conflict error. Got: ${JSON.stringify(messages)}`,
    );
  });

  it('reports both the mutual-exclusion error and offset-in-batch-mode error', () => {
    // All validation errors are reported regardless of path-selection state.
    const result = ReadFileInputSchema.safeParse({
      path: '/tmp/file.txt',
      paths: ['/tmp/file.txt'],
      offset: 0,
    });
    assert.equal(result.success, false);
    const messages = result.error.issues.map((i) => i.message);
    assert.ok(
      messages.includes("Cannot use both 'path' and 'paths'"),
      `Missing mutual-exclusion error. Got: ${JSON.stringify(messages)}`,
    );
    assert.ok(
      messages.includes("'offset' and 'length' are not supported in batch mode"),
      `Missing batch-mode error. Got: ${JSON.stringify(messages)}`,
    );
  });
});
