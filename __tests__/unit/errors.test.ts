import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import { ErrorCode } from '../../src/config.js';
import {
  classifyError,
  createDetailedError,
  getSuggestion,
  isAbortError,
  isNodeError,
  isTimeoutLikeError,
  McpError,
  type Problem,
  zodErrorToProblem,
} from '../../src/core/errors.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeErrno(code: string, message = 'fake'): NodeJS.ErrnoException {
  const e = new Error(message) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

// ─── isNodeError ────────────────────────────────────────────────────────────

describe('isNodeError', () => {
  it('returns true for system errors with a string code', () => {
    let err: NodeJS.ErrnoException | undefined;
    try {
      readdirSync(`/nonexistent-path-that-cannot-exist-${Date.now()}`);
    } catch (e: unknown) {
      err = e as NodeJS.ErrnoException;
    }
    assert.ok(err !== undefined, 'Should have thrown');
    assert.equal(isNodeError(err), true);
  });

  it('returns false for plain Error with no code', () => {
    assert.equal(isNodeError(new Error('plain')), false);
  });

  it('returns false for plain Error with numeric code', () => {
    const e = Object.assign(new Error('numeric'), { code: 42 });
    assert.equal(isNodeError(e), false);
  });

  it('returns false for non-Error primitives', () => {
    assert.equal(isNodeError('not an error'), false);
    assert.equal(isNodeError(null), false);
    assert.equal(isNodeError(undefined), false);
    assert.equal(isNodeError({}), false);
  });
});

// ─── McpError — legacy positional constructor ────────────────────────────────

describe('McpError — legacy constructor', () => {
  it('stores code, message, and is instanceof Error', () => {
    const err = new McpError(ErrorCode.NOT_FOUND, 'file not found');
    assert.equal(err.code, ErrorCode.NOT_FOUND);
    assert.equal(err.message, 'file not found');
    assert.ok(err instanceof Error);
  });

  it('has name "McpError"', () => {
    const err = new McpError(ErrorCode.PERMISSION_DENIED, 'no access');
    assert.equal(err.name, 'McpError');
  });

  it('stores optional path', () => {
    const err = new McpError(ErrorCode.NOT_FOUND, 'msg', '/some/path');
    assert.equal(err.path, '/some/path');
  });

  it('stores no path when not provided', () => {
    const err = new McpError(ErrorCode.NOT_FOUND, 'msg');
    assert.equal(err.path, undefined);
  });

  it('has a problem property with the correct code', () => {
    const err = new McpError(ErrorCode.TOO_LARGE, 'too big');
    assert.equal(err.problem.code, ErrorCode.TOO_LARGE);
    assert.equal(err.problem.message, 'too big');
  });
});

// ─── McpError — Problem constructor ─────────────────────────────────────────

describe('McpError — Problem constructor', () => {
  it('wraps a Problem directly', () => {
    const problem: Problem = {
      code: ErrorCode.VALIDATION_FAILED,
      message: 'bad input',
      issues: [{ code: 'invalid_type', message: 'Expected string', path: ['name'] }],
    };
    const err = new McpError(problem);
    assert.equal(err.code, ErrorCode.VALIDATION_FAILED);
    assert.equal(err.message, 'bad input');
    assert.equal(err.problem, problem);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof McpError);
  });

  it('wraps a Problem with cause', () => {
    const cause = new Error('underlying');
    const problem: Problem = { code: ErrorCode.IO_ERROR, message: 'io failed' };
    const err = new McpError(problem, cause);
    assert.equal(err.cause, cause);
    assert.equal(err.code, ErrorCode.IO_ERROR);
  });

  it('VALIDATION_FAILED problem exposes issues', () => {
    const problem: Problem = {
      code: ErrorCode.VALIDATION_FAILED,
      message: 'validation failed',
      issues: [{ code: 'custom', message: 'required', path: ['field'] }],
    };
    const err = new McpError(problem);
    assert.ok(Array.isArray(err.problem.issues));
    assert.equal(err.problem.issues?.length, 1);
  });
});

// ─── getSuggestion ──────────────────────────────────────────────────────────

describe('getSuggestion', () => {
  it('returns a string or undefined for every ErrorCode value', () => {
    const withSuggestion: string[] = [];
    const withoutSuggestion: string[] = [];
    for (const code of Object.values(ErrorCode)) {
      const suggestion = getSuggestion(code);
      if (suggestion !== undefined) {
        assert.equal(typeof suggestion, 'string');
        assert.ok(suggestion.length > 0, `Expected non-empty suggestion for ${code}`);
        withSuggestion.push(code);
      } else {
        withoutSuggestion.push(code);
      }
    }
    assert.ok(withSuggestion.length > 0, 'At least some codes should have suggestions');
  });
});

// ─── classifyError — no message sniffing ────────────────────────────────────

describe('classifyError — no message sniffing', () => {
  it('classifies plain Error with no errno as IO_ERROR', () => {
    assert.equal(classifyError(new Error('boom')), ErrorCode.IO_ERROR);
  });

  it('does NOT classify by message substring', () => {
    // Locks the no-sniffing invariant.
    assert.equal(classifyError(new Error('permission denied')), ErrorCode.IO_ERROR);
    assert.equal(classifyError(new Error('no such file or directory')), ErrorCode.IO_ERROR);
    assert.equal(classifyError(new Error('ENOENT: file not found')), ErrorCode.IO_ERROR);
  });

  it('classifies by errno code when present', () => {
    assert.equal(classifyError(makeErrno('ENOENT')), ErrorCode.NOT_FOUND);
    assert.equal(classifyError(makeErrno('EACCES')), ErrorCode.PERMISSION_DENIED);
    assert.equal(classifyError(makeErrno('EPERM')), ErrorCode.PERMISSION_DENIED);
  });

  it('classifies non-Error as UNKNOWN', () => {
    assert.equal(classifyError(null), ErrorCode.UNKNOWN);
    assert.equal(classifyError(undefined), ErrorCode.UNKNOWN);
    assert.equal(classifyError('string'), ErrorCode.UNKNOWN);
  });
});

// ─── errno fix regressions ──────────────────────────────────────────────────

describe('classifyError — errno regression locks', () => {
  it('EMFILE → IO_ERROR (was TIMEOUT)', () => {
    assert.equal(classifyError(makeErrno('EMFILE')), ErrorCode.IO_ERROR);
  });

  it('ENFILE → IO_ERROR (was TIMEOUT)', () => {
    assert.equal(classifyError(makeErrno('ENFILE')), ErrorCode.IO_ERROR);
  });

  it('EBUSY → IO_ERROR (was PERMISSION_DENIED)', () => {
    assert.equal(classifyError(makeErrno('EBUSY')), ErrorCode.IO_ERROR);
  });
});

// ─── isAbortError / isTimeoutLikeError ──────────────────────────────────────

describe('isAbortError', () => {
  it('returns true for AbortError by name', () => {
    const e = new Error('aborted');
    e.name = 'AbortError';
    assert.equal(isAbortError(e), true);
  });

  it('returns true for ABORT_ERR errno', () => {
    assert.equal(isAbortError(makeErrno('ABORT_ERR')), true);
  });

  it('returns false for plain Error', () => {
    assert.equal(isAbortError(new Error('plain')), false);
  });

  it('returns false for non-Error', () => {
    assert.equal(isAbortError(null), false);
  });
});

describe('isTimeoutLikeError', () => {
  it('returns true for TimeoutError by name', () => {
    const e = new Error('timed out');
    e.name = 'TimeoutError';
    assert.equal(isTimeoutLikeError(e), true);
  });

  it('returns true for ETIMEDOUT errno', () => {
    assert.equal(isTimeoutLikeError(makeErrno('ETIMEDOUT')), true);
  });

  it('returns false for plain Error', () => {
    assert.equal(isTimeoutLikeError(new Error('plain')), false);
  });
});

// ─── createDetailedError ────────────────────────────────────────────────────

describe('createDetailedError', () => {
  it('produces code and message from errno error', () => {
    const err = makeErrno('ENOENT', 'no such file');
    const d = createDetailedError(err);
    assert.equal(d.code, ErrorCode.NOT_FOUND);
    assert.equal(typeof d.message, 'string');
  });

  it('accepts optional path override', () => {
    const err = makeErrno('EACCES', 'forbidden');
    const d = createDetailedError(err, '/foo/bar');
    assert.equal(d.path, '/foo/bar');
  });

  it('VALIDATION_FAILED error exposes issues array', () => {
    const schema = z.strictObject({ name: z.string() });
    const parsed = schema.safeParse({ name: 42 });
    assert.ok(!parsed.success);
    const problem = zodErrorToProblem(parsed.error, schema);
    const err = new McpError(problem);
    const d = createDetailedError(err);
    assert.equal(d.code, ErrorCode.VALIDATION_FAILED);
    assert.ok(Array.isArray(d.issues));
    assert.ok((d.issues?.length ?? 0) > 0);
  });
});
