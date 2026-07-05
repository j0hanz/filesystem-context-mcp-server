// __tests__/unit/session-id.test.ts
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { isValidSessionId } from '../../src/transport.js';

describe('isValidSessionId (REQ-006)', () => {
  it('accepts the SDK transport own generated id (crypto.randomUUID)', () => {
    // The SDK's default sessionIdGenerator is () => crypto.randomUUID().
    // Pin it so the tightening can never reject the server's own freshly-issued id.
    for (let i = 0; i < 50; i++) {
      assert.equal(isValidSessionId(randomUUID()), true, randomUUID());
    }
  });

  it('accepts a representative UUID v4', () => {
    assert.equal(isValidSessionId('12345678-1234-4abc-8def-1234567890ab'), true);
  });

  it('accepts a max-length (256) opaque token', () => {
    assert.equal(isValidSessionId('a'.repeat(256)), true);
  });

  it('rejects an over-length id', () => {
    assert.equal(isValidSessionId('a'.repeat(257)), false);
  });

  it('rejects an empty id', () => {
    assert.equal(isValidSessionId(''), false);
  });

  it('rejects embedded whitespace', () => {
    assert.equal(isValidSessionId('abc def'), false);
    assert.equal(isValidSessionId('abc\tdef'), false);
    assert.equal(isValidSessionId('abc\ndef'), false);
    assert.equal(isValidSessionId(' abc'), false);
    assert.equal(isValidSessionId('abc '), false);
  });

  it('rejects control / non-printable characters', () => {
    assert.equal(isValidSessionId('abc\x00def'), false);
    assert.equal(isValidSessionId('abc\x1Fdef'), false);
    assert.equal(isValidSessionId('abc\x7Fdef'), false);
  });
});
