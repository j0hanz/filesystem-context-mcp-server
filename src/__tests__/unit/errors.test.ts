import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { describe, it } from 'node:test';

import {
  ErrorCode,
  getSuggestion,
  isNodeError,
  McpError,
} from '../../lib/errors.js';

// ─── isNodeError ────────────────────────────────────────────────────────────

describe('isNodeError', () => {
  it('returns true for system errors with a string code', () => {
    let err: NodeJS.ErrnoException | undefined;
    try {
      readdirSync('/nonexistent-path-that-cannot-exist-' + Date.now());
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

// ─── McpError ───────────────────────────────────────────────────────────────

describe('McpError', () => {
  it('stores code, message, and is instanceof Error', () => {
    const err = new McpError(ErrorCode.E_NOT_FOUND, 'file not found');
    assert.equal(err.code, ErrorCode.E_NOT_FOUND);
    assert.equal(err.message, 'file not found');
    assert.ok(err instanceof Error);
  });

  it('has name "McpError"', () => {
    const err = new McpError(ErrorCode.E_PERMISSION_DENIED, 'no access');
    assert.equal(err.name, 'McpError');
  });

  it('stores optional path', () => {
    const err = new McpError(ErrorCode.E_NOT_FOUND, 'msg', '/some/path');
    assert.equal(err.path, '/some/path');
  });

  it('stores no path when not provided', () => {
    const err = new McpError(ErrorCode.E_NOT_FOUND, 'msg');
    assert.equal(err.path, undefined);
  });
});

// ─── getSuggestion ──────────────────────────────────────────────────────────

describe('getSuggestion', () => {
  it('returns a non-empty string for every ErrorCode value', () => {
    for (const code of Object.values(ErrorCode)) {
      const suggestion = getSuggestion(code);
      assert.equal(typeof suggestion, 'string');
      assert.ok(
        suggestion.length > 0,
        `Expected non-empty suggestion for ${code}`
      );
    }
  });
});
