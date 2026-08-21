import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as z from 'zod/v4';

import { ErrorCode } from '../../src/core/errors.js';
import type { ValidatedPath } from '../../src/core/path.js';
import { isRecord } from '../../src/core/primitives.js';
import type { SynchronizerState } from '../../src/core/registrar.js';
import type { SingleOrBatchShape } from '../../src/core/schema.js';
import { singleOrBatchPathsInput } from '../../src/core/schema.js';

// ─── Type-Level Testing Utilities ──────────────────────────────────────────

/* eslint-disable @typescript-eslint/no-unnecessary-type-parameters -- Canonical TypeScript type-level equality check requires generic function signatures */
type Equals<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true : false;
/* eslint-enable @typescript-eslint/no-unnecessary-type-parameters */

type Expect<T extends true> = T;

describe('Type-Level Advanced Types & Invariants', () => {
  it('enforces nominal branding on ValidatedPath', () => {
    // ValidatedPath is assignable to string, but raw string is NOT assignable to ValidatedPath
    type _IsString<T extends string> = T;
    type _TestAssignableToString = _IsString<ValidatedPath>;

    // @ts-expect-error - raw string cannot be assigned to branded ValidatedPath without validation
    const _invalid: ValidatedPath = 'some/unvalidated/path';

    assert.ok(true);
  });

  it('validates SingleOrBatchShape type inference', () => {
    const extraSchema = { query: z.string() };
    const schema = singleOrBatchPathsInput({ extra: extraSchema });

    type Inferred = z.infer<typeof schema>;
    type _HasQuery = Expect<Equals<Inferred['query'], string>>;
    type _HasPath = Expect<Equals<Inferred['path'], string | undefined>>;
    type _HasPaths = Expect<Equals<Inferred['paths'], string[] | undefined>>;
    type _TestShape = SingleOrBatchShape<typeof extraSchema>;
    type _TestShapePath = Expect<Equals<_TestShape['path'], z.ZodOptional<z.ZodString>>>;

    assert.ok(schema);
  });

  it('correctly narrows isRecord only on plain record objects and rejects arrays', () => {
    const recordObj: unknown = { key: 'value' };
    const arrayObj: unknown = [1, 2, 3];
    const nullObj: unknown = null;
    const primStr: unknown = 'hello';

    assert.equal(isRecord(recordObj), true);
    assert.equal(isRecord(arrayObj), false);
    assert.equal(isRecord(nullObj), false);
    assert.equal(isRecord(primStr), false);

    if (isRecord(recordObj)) {
      assert.equal(recordObj['key'], 'value');
    }
  });

  it('verifies SynchronizerState union members', () => {
    type ExpectedStates = 'initializing' | 'idle' | 'updating' | 'shutting_down';
    type _TestSyncStates = Expect<Equals<SynchronizerState, ExpectedStates>>;

    assert.ok(true);
  });

  it('verifies ErrorCode union completeness', () => {
    type ExpectedCodes =
      | 'ACCESS_DENIED'
      | 'NOT_FOUND'
      | 'NOT_FILE'
      | 'NOT_DIRECTORY'
      | 'TOO_LARGE'
      | 'TIMEOUT'
      | 'CANCELLED'
      | 'INVALID_PATTERN'
      | 'INVALID_INPUT'
      | 'PERMISSION_DENIED'
      | 'SYMLINK_NOT_ALLOWED'
      | 'VALIDATION_FAILED'
      | 'IO_ERROR'
      | 'UNKNOWN';

    type _TestErrorCodes = Expect<Equals<ErrorCode, ExpectedCodes>>;
    assert.ok(true);
  });
});
