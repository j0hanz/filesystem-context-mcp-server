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

function makeErrno(code: string, message = 'fake'): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

describe('classify — errno table', () => {
  const cases: [string, ErrorCode][] = [
    ['ENOENT', ErrorCode.NOT_FOUND],
    ['EACCES', ErrorCode.PERMISSION_DENIED],
    ['EPERM', ErrorCode.PERMISSION_DENIED],
    ['ENOTDIR', ErrorCode.NOT_DIRECTORY],
    ['EISDIR', ErrorCode.NOT_FILE],
    ['ELOOP', ErrorCode.SYMLINK_NOT_ALLOWED],
    ['ENAMETOOLONG', ErrorCode.INVALID_INPUT],
    ['ETIMEDOUT', ErrorCode.TIMEOUT],
    ['ENOTEMPTY', ErrorCode.NOT_DIRECTORY],
    ['EEXIST', ErrorCode.INVALID_INPUT],
    ['EINVAL', ErrorCode.INVALID_INPUT],
  ];
  for (const [errno, expected] of cases) {
    it(`${errno} → ${expected}`, () => {
      assert.equal(classify(makeErrno(errno)).code, expected);
    });
  }
});

describe('classify — errno fixes (regression locks)', () => {
  it('EMFILE → IO_ERROR (was TIMEOUT)', () => {
    assert.equal(classify(makeErrno('EMFILE')).code, ErrorCode.IO_ERROR);
  });
  it('ENFILE → IO_ERROR (was TIMEOUT)', () => {
    assert.equal(classify(makeErrno('ENFILE')).code, ErrorCode.IO_ERROR);
  });
  it('EBUSY → IO_ERROR (was PERMISSION_DENIED)', () => {
    assert.equal(classify(makeErrno('EBUSY')).code, ErrorCode.IO_ERROR);
  });
});

describe('classify — abort & timeout', () => {
  it('AbortError name → CANCELLED', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    assert.equal(classify(e).code, ErrorCode.CANCELLED);
  });
  it('code ABORT_ERR → CANCELLED', () => {
    const e = makeErrno('ABORT_ERR');
    assert.equal(classify(e).code, ErrorCode.CANCELLED);
  });
  it('TimeoutError name → TIMEOUT', () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    assert.equal(classify(e).code, ErrorCode.TIMEOUT);
  });
});

describe('classify — cause chain', () => {
  it('walks .cause to find errno', () => {
    const inner = makeErrno('ENOENT');
    const outer = new Error('wrapper', { cause: inner });
    assert.equal(classify(outer).code, ErrorCode.NOT_FOUND);
  });
  it('terminates on first abort hit even if outer has errno cause', () => {
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    const outer = new Error('wrapper', { cause: abort });
    assert.equal(classify(outer).code, ErrorCode.CANCELLED);
  });
});

describe('classify — Problem details propagate errno', () => {
  it('records errno + syscall in details', () => {
    const e = makeErrno('ENOENT');
    e.syscall = 'open';
    const p = classify(e);
    assert.equal(p.details?.errno, 'ENOENT');
    assert.equal(p.details?.syscall, 'open');
  });
});
