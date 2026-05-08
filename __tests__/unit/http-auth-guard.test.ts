// __tests__/unit/http-auth-guard.test.ts
import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  assertHttpBindingPolicy,
  isAllowedLocalhostOrigin,
  isLoopbackHttpHost,
  validateBearerAuthorization,
} from '../../src/server/bootstrap.js';

describe('isLoopbackHttpHost', () => {
  it('accepts canonical loopback hosts', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) {
      assert.equal(isLoopbackHttpHost(host), true, host);
    }
  });

  it('is case-insensitive and trims whitespace', () => {
    assert.equal(isLoopbackHttpHost('  LOCALHOST  '), true);
    assert.equal(isLoopbackHttpHost('LocalHost'), true);
  });

  it('rejects non-loopback hosts', () => {
    for (const host of ['0.0.0.0', '10.0.0.1', '192.168.1.1', 'example.com']) {
      assert.equal(isLoopbackHttpHost(host), false, host);
    }
  });
});

describe('isAllowedLocalhostOrigin', () => {
  it('allows http and https localhost origins with optional port', () => {
    for (const origin of [
      'http://localhost',
      'http://localhost:3000',
      'https://localhost:8443',
      'http://127.0.0.1',
      'http://127.0.0.1:1234',
    ]) {
      assert.equal(isAllowedLocalhostOrigin(origin), true, origin);
    }
  });

  it('rejects non-localhost origins', () => {
    for (const origin of [
      'http://example.com',
      'http://localhost.example.com',
      'http://127.0.0.2',
      'file:///etc/passwd',
    ]) {
      assert.equal(isAllowedLocalhostOrigin(origin), false, origin);
    }
  });
});

describe('validateBearerAuthorization', () => {
  const apiKey = 'super-secret-key';

  it('accepts a matching Bearer token', () => {
    assert.equal(validateBearerAuthorization(apiKey, `Bearer ${apiKey}`), true);
  });

  it('rejects a mismatched token', () => {
    assert.equal(validateBearerAuthorization(apiKey, 'Bearer wrong'), false);
  });

  it('rejects missing or non-Bearer headers', () => {
    assert.equal(validateBearerAuthorization(apiKey, undefined), false);
    assert.equal(validateBearerAuthorization(apiKey, ''), false);
    assert.equal(validateBearerAuthorization(apiKey, 'Basic xyz'), false);
    assert.equal(validateBearerAuthorization(apiKey, 123), false);
  });

  it('rejects a token exceeding the 4096-byte cap', () => {
    const oversized = 'x'.repeat(4097);
    assert.equal(
      validateBearerAuthorization(apiKey, `Bearer ${oversized}`),
      false
    );
  });
});

describe('assertHttpBindingPolicy', () => {
  const originalKey = process.env['FILESYSTEM_MCP_API_KEY'];

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env['FILESYSTEM_MCP_API_KEY'];
    } else {
      process.env['FILESYSTEM_MCP_API_KEY'] = originalKey;
    }
  });

  it('allows loopback bind without an API key', () => {
    assert.doesNotThrow(() => {
      assertHttpBindingPolicy('127.0.0.1', undefined);
    });
    assert.doesNotThrow(() => {
      assertHttpBindingPolicy('localhost', undefined);
    });
  });

  it('allows non-loopback bind when an API key is set', () => {
    assert.doesNotThrow(() => {
      assertHttpBindingPolicy('0.0.0.0', 'a-key');
    });
  });

  it('refuses non-loopback bind without an API key', () => {
    assert.throws(() => {
      assertHttpBindingPolicy('0.0.0.0', undefined);
    }, /Refusing to bind HTTP server to non-loopback host/);
    assert.throws(() => {
      assertHttpBindingPolicy('192.168.1.1', '');
    }, /Refusing to bind HTTP server to non-loopback host/);
  });
});
