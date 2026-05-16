import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import { ErrorCode } from '../../src/core/errors.js';
import {
  classifyError,
  createDetailedError,
  FsError,
  getSuggestion,
  isAbortError,
  isNodeError,
  isTimeoutLikeError,
  Problem,
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

// ─── FsError — legacy positional constructor ─────────────────────────────────

describe('FsError — legacy constructor', () => {
  it('stores code, message, and is instanceof Error', () => {
    const err = new FsError(ErrorCode.NOT_FOUND, 'file not found');
    assert.equal(err.code, ErrorCode.NOT_FOUND);
    assert.equal(err.message, 'file not found');
    assert.ok(err instanceof Error);
  });

  it('has name "FsError"', () => {
    const err = new FsError(ErrorCode.PERMISSION_DENIED, 'no access');
    assert.equal(err.name, 'FsError');
  });

  it('stores optional path', () => {
    const err = new FsError(ErrorCode.NOT_FOUND, 'msg', '/some/path');
    assert.equal(err.path, '/some/path');
  });

  it('stores no path when not provided', () => {
    const err = new FsError(ErrorCode.NOT_FOUND, 'msg');
    assert.equal(err.path, undefined);
  });

  it('has a problem property with the correct code', () => {
    const err = new FsError(ErrorCode.TOO_LARGE, 'too big');
    assert.equal(err.problem.code, ErrorCode.TOO_LARGE);
    assert.equal(err.problem.message, 'too big');
  });
});

// ─── FsError — Problem constructor ──────────────────────────────────────────

describe('FsError — Problem constructor', () => {
  it('wraps a Problem directly', () => {
    const problem: Problem = {
      code: ErrorCode.VALIDATION_FAILED,
      message: 'bad input',
      issues: [{ code: 'invalid_type', message: 'Expected string', path: ['name'] }],
    };
    const err = new FsError(problem);
    assert.equal(err.code, ErrorCode.VALIDATION_FAILED);
    assert.equal(err.message, 'bad input');
    assert.equal(err.problem, problem);
    assert.ok(err instanceof Error);
    assert.ok(err instanceof FsError);
  });

  it('wraps a Problem with cause', () => {
    const cause = new Error('underlying');
    const problem: Problem = { code: ErrorCode.IO_ERROR, message: 'io failed' };
    const err = new FsError(problem, cause);
    assert.equal(err.cause, cause);
    assert.equal(err.code, ErrorCode.IO_ERROR);
  });

  it('VALIDATION_FAILED problem exposes issues', () => {
    const problem: Problem = {
      code: ErrorCode.VALIDATION_FAILED,
      message: 'validation failed',
      issues: [{ code: 'custom', message: 'required', path: ['field'] }],
    };
    const err = new FsError(problem);
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
    const err = new FsError(problem);
    const d = createDetailedError(err);
    assert.equal(d.code, ErrorCode.VALIDATION_FAILED);
    assert.ok(Array.isArray(d.issues));
    assert.ok((d.issues?.length ?? 0) > 0);
  });
});

describe('Problem.fromUnknown', () => {
  it('overrides IO_ERROR from plain Error with defaultCode', () => {
    const err = new Error('boom');
    const result = Problem.fromUnknown(err, ErrorCode.UNKNOWN);
    assert.equal(result.code, ErrorCode.UNKNOWN);
    assert.equal(result.message, 'boom');
    assert.equal(result.path, undefined);
    assert.equal(result.suggestion, undefined);
  });

  it('overrides UNKNOWN code with defaultCode', () => {
    const err = new Error('something went wrong');
    const result = Problem.fromUnknown(err, ErrorCode.NOT_FOUND);
    assert.equal(result.code, ErrorCode.NOT_FOUND);
  });

  it('overrides IO_ERROR code with defaultCode', () => {
    const ioErr = Object.assign(new Error('io'), { code: 'EMFILE' });
    const result = Problem.fromUnknown(ioErr, ErrorCode.TOO_LARGE);
    assert.equal(result.code, ErrorCode.TOO_LARGE);
  });

  it('populates suggestion from defaultCode when overriding', () => {
    const err = new Error('io');
    const result = Problem.fromUnknown(err, ErrorCode.NOT_FOUND);
    assert.equal(result.code, ErrorCode.NOT_FOUND);
    // suggestion should come from getSuggestion(NOT_FOUND)
    assert.ok(result.suggestion !== undefined, 'suggestion should be populated when overriding');
  });

  it('preserves specific error codes (e.g. NOT_FOUND from ENOENT)', () => {
    const notFound = Object.assign(new Error('not found'), { code: 'ENOENT' });
    const result = Problem.fromUnknown(notFound, ErrorCode.UNKNOWN);
    assert.equal(result.code, ErrorCode.NOT_FOUND);
  });

  it('includes path when provided', () => {
    const err = new Error('oops');
    const result = Problem.fromUnknown(err, ErrorCode.UNKNOWN, '/some/path');
    assert.equal(result.path, '/some/path');
  });

  it('does not include issues or details fields', () => {
    const err = new Error('oops');
    const result = Problem.fromUnknown(err, ErrorCode.UNKNOWN) as Record<string, unknown>;
    assert.equal('issues' in result, false);
    assert.equal('details' in result, false);
  });

  it('preserves FsError problem fields without overriding', () => {
    const err = new FsError(ErrorCode.PERMISSION_DENIED, 'no access', '/locked');
    const result = Problem.fromUnknown(err, ErrorCode.UNKNOWN);
    assert.equal(result.code, ErrorCode.PERMISSION_DENIED);
    assert.equal(result.message, 'no access');
    assert.equal(result.path, '/locked');
  });
});

describe('toProblemIssue — path segment types', () => {
  it('preserves numeric path segments from array-indexed Zod issues', () => {
    const schema = z.strictObject({
      items: z.array(z.strictObject({ name: z.string() })),
    });
    const result = schema.safeParse({ items: [{ name: 42 }] });
    assert.ok(!result.success, 'Should fail: name must be string');

    const problem = zodErrorToProblem(result.error, schema);
    assert.ok(problem.issues && problem.issues.length > 0, 'Should have issues');

    // The path to the failing field is [items, 0, name] — index 0 must remain a number
    const issue = problem.issues?.find((i) => i.path.includes('name'));
    assert.ok(issue, 'Should find the name field issue');
    const indexSegment = issue?.path[1]; // position 1 is the array index
    assert.equal(
      typeof indexSegment,
      'number',
      'Array index must remain a number, not be stringified',
    );
    assert.equal(indexSegment, 0);
  });
});
