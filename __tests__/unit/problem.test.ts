import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../../src/config.js';
import { classify, Problem } from '../../src/lib/problem.js';

describe('classify', () => {
  it('returns UNKNOWN for non-Error values', () => {
    assert.equal(classify(undefined).code, ErrorCode.UNKNOWN);
    assert.equal(classify(null).code, ErrorCode.UNKNOWN);
    assert.equal(classify('plain string').code, ErrorCode.UNKNOWN);
    assert.equal(classify({}).code, ErrorCode.UNKNOWN);
  });

  it('returns IO_ERROR for plain Error with no errno and no cause', () => {
    assert.equal(classify(new Error('boom')).code, ErrorCode.IO_ERROR);
  });

  it('does NOT classify by message substring', () => {
    // Locks the no-sniffing property.
    assert.equal(
      classify(new Error('permission denied')).code,
      ErrorCode.IO_ERROR,
    );
    assert.equal(
      classify(new Error('no such file or directory')).code,
      ErrorCode.IO_ERROR,
    );
    assert.equal(
      classify(new Error('operation timed out')).code,
      ErrorCode.IO_ERROR,
    );
  });
});

describe('Problem factories', () => {
  it('Problem.notFound builds a NOT_FOUND problem', () => {
    const p = Problem.notFound('missing', { path: '/x' });
    assert.equal(p.code, ErrorCode.NOT_FOUND);
    assert.equal(p.message, 'missing');
    assert.equal(p.path, '/x');
  });
});
