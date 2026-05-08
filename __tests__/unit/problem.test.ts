import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import { ErrorCode } from '../../src/config.js';
import { resolveSuggestion } from '../../src/lib/error-suggestions.js';
import { classify, Problem, zodErrorToProblem } from '../../src/lib/problem.js';

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
      ErrorCode.IO_ERROR
    );
    assert.equal(
      classify(new Error('no such file or directory')).code,
      ErrorCode.IO_ERROR
    );
    assert.equal(
      classify(new Error('operation timed out')).code,
      ErrorCode.IO_ERROR
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

describe('zodErrorToProblem', () => {
  it('maps a Zod validation error to VALIDATION_FAILED with issues[]', () => {
    const schema = z.strictObject({ name: z.string().min(3) });
    const result = schema.safeParse({ name: 'a' });
    assert.equal(result.success, false);
    if (result.success) return;

    const p = zodErrorToProblem(result.error);
    assert.equal(p.code, ErrorCode.VALIDATION_FAILED);
    assert.ok(p.issues && p.issues.length >= 1);
    const first = p.issues.at(0);
    assert.ok(first);
    assert.deepEqual([...first.path], ['name']);
    assert.equal(first.code, 'too_small');
  });

  it('preserves custom params from superRefine issues', () => {
    const schema = z
      .strictObject({ a: z.string().optional(), b: z.string().optional() })
      .superRefine((value, ctx) => {
        if (value.a !== undefined && value.b !== undefined) {
          ctx.addIssue({
            code: 'custom',
            path: ['a'],
            message: "Cannot use 'a' with 'b'",
            params: {
              rule: 'mutually_exclusive',
              conflictsWith: ['b'],
              suggestion: 'Pick one.',
            },
          });
        }
      });
    const result = schema.safeParse({ a: 'x', b: 'y' });
    assert.equal(result.success, false);
    if (result.success) return;

    const p = zodErrorToProblem(result.error);
    const issue = p.issues?.[0];
    assert.equal(issue?.code, 'custom');
    assert.equal(issue?.params?.['rule'], 'mutually_exclusive');
    assert.deepEqual(issue?.params?.['conflictsWith'], ['b']);
  });

  it('classify(ZodError) routes through zodErrorToProblem', () => {
    const schema = z.strictObject({ x: z.number() });
    const result = schema.safeParse({ x: 'nope' });
    if (result.success) return;
    assert.equal(classify(result.error).code, ErrorCode.VALIDATION_FAILED);
  });
});

describe('resolveSuggestion', () => {
  it('returns per-code default when no issues and no schema', () => {
    const s = resolveSuggestion({ code: ErrorCode.NOT_FOUND, issues: [] });
    assert.equal(typeof s, 'string');
    assert.ok(s !== undefined && s.length > 0);
  });

  it('returns undefined for VALIDATION_FAILED with no issues + no schema', () => {
    assert.equal(
      resolveSuggestion({ code: ErrorCode.VALIDATION_FAILED, issues: [] }),
      undefined
    );
  });

  it('rule-params suggestion wins over per-code default', () => {
    const s = resolveSuggestion({
      code: ErrorCode.VALIDATION_FAILED,
      issues: [
        {
          path: ['head'],
          code: 'custom',
          message: 'conflict',
          params: { suggestion: 'Use line ranges OR head, not both.' },
        },
      ],
    });
    assert.equal(s, 'Use line ranges OR head, not both.');
  });

  it('schema-meta suggestion wins over rule-params and default', () => {
    const schema = z.strictObject({
      pattern: z.string().min(1).meta({ suggestion: 'meta wins' }),
    });
    const s = resolveSuggestion(
      {
        code: ErrorCode.VALIDATION_FAILED,
        issues: [
          {
            path: ['pattern'],
            code: 'too_small',
            message: 'min',
            params: { suggestion: 'rule loses' },
          },
        ],
      },
      schema
    );
    assert.equal(s, 'meta wins');
  });
});
