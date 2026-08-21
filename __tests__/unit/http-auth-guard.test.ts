// __tests__/unit/http-auth-guard.test.ts
import { hostHeaderValidation, localhostHostValidation } from '@modelcontextprotocol/express';
import { localhostAllowedHostnames } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { Request } from 'express';

import {
  assertHttpBindingPolicy,
  assertHttpHostPolicy,
  isAllowedLocalhostOrigin,
  isLoopbackHttpHost,
  parseAllowedHostsEnv,
  protectedResourceUrl,
  resolveAllowedHosts,
  resolveTrustProxySetting,
  validateBearerAuthorization,
} from '../../src/http-policy.js';

describe('express host validation exports', () => {
  it('exposes host validation middleware factories as functions', () => {
    assert.equal(typeof hostHeaderValidation, 'function');
    assert.equal(typeof localhostHostValidation, 'function');
  });
});

describe('isLoopbackHttpHost', () => {
  it('accepts canonical loopback hosts from SDK list', () => {
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      assert.equal(isLoopbackHttpHost(host), true, host);
    }
  });

  it('does not accept bare unbracketed ::1 (invalid in HTTP Host headers)', () => {
    assert.equal(isLoopbackHttpHost('::1'), false);
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
    assert.equal(validateBearerAuthorization(apiKey, `Bearer ${oversized}`), false);
  });
});

describe('parseAllowedHostsEnv', () => {
  it('trims entries and drops empty ones', () => {
    assert.deepEqual(parseAllowedHostsEnv(' a.local , b.local ,'), ['a.local', 'b.local']);
  });

  it('reads a whitespace- or separator-only value as unset', () => {
    // A list that survived as [''] would 403 every Host while looking configured.
    for (const value of [undefined, '', ' ', ',', ', ,']) {
      assert.deepEqual(parseAllowedHostsEnv(value), [], JSON.stringify(value));
    }
  });

  it('agrees with assertHttpHostPolicy on what counts as configured', () => {
    assert.throws(() => {
      assertHttpHostPolicy('0.0.0.0', parseAllowedHostsEnv(', ,'), false);
    }, /Refusing to bind wildcard host/);
    assert.doesNotThrow(() => {
      assertHttpHostPolicy('0.0.0.0', parseAllowedHostsEnv('public.example'), false);
    });
  });
});

describe('resolveAllowedHosts', () => {
  it('prefers a configured allowlist over the bind host', () => {
    assert.deepEqual(resolveAllowedHosts('0.0.0.0', 'public.example'), ['public.example']);
  });

  it('takes the full localhost hostname set for a loopback bind', () => {
    assert.deepEqual(resolveAllowedHosts('127.0.0.1', undefined), localhostAllowedHostnames());
    assert.deepEqual(resolveAllowedHosts('localhost', undefined), localhostAllowedHostnames());
  });

  it('returns an empty list for a wildcard bind with no allowlist', () => {
    assert.deepEqual(resolveAllowedHosts('0.0.0.0', undefined), []);
    assert.deepEqual(resolveAllowedHosts('::', undefined), []);
  });

  it('takes just itself for a concrete non-loopback bind with no allowlist', () => {
    assert.deepEqual(resolveAllowedHosts('192.168.1.1', undefined), ['192.168.1.1']);
  });
});

describe('resolveTrustProxySetting', () => {
  it('leaves the default (disabled) in place when unset or empty', () => {
    assert.equal(resolveTrustProxySetting(undefined), undefined);
    assert.equal(resolveTrustProxySetting(''), undefined);
  });

  it('parses a non-negative integer hop count as a number, including zero', () => {
    assert.equal(resolveTrustProxySetting('0'), 0);
    assert.equal(resolveTrustProxySetting('1'), 1);
    assert.equal(resolveTrustProxySetting('3'), 3);
  });

  it('passes through a non-integer or negative value unchanged for Express to interpret', () => {
    assert.equal(resolveTrustProxySetting('loopback'), 'loopback');
    assert.equal(resolveTrustProxySetting('-1'), '-1');
    assert.equal(resolveTrustProxySetting('10.0.0.0/8'), '10.0.0.0/8');
  });
});

describe('assertHttpBindingPolicy', () => {
  const originalKey = process.env['API_KEY'];

  afterEach(() => {
    if (originalKey === undefined) {
      delete process.env['API_KEY'];
    } else {
      process.env['API_KEY'] = originalKey;
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

  it('allows non-loopback bind when a secure API key (>= 16 chars) is set', () => {
    assert.doesNotThrow(() => {
      assertHttpBindingPolicy('0.0.0.0', 'a-very-long-secure-key-12345');
    });
  });

  it('refuses non-loopback bind when an API key is weak or missing', () => {
    assert.throws(() => {
      assertHttpBindingPolicy('0.0.0.0', 'too-short');
    }, /API_KEY.*insecure|Refusing to bind/);
    assert.throws(() => {
      assertHttpBindingPolicy('0.0.0.0', undefined);
    }, /Refusing to bind HTTP server to non-loopback host/);
    assert.throws(() => {
      assertHttpBindingPolicy('192.168.1.1', '');
    }, /Refusing to bind HTTP server to non-loopback host/);
  });
});

describe('protectedResourceUrl', () => {
  const originalUrl = process.env['FILESYSTEM_MCP_PUBLIC_URL'];

  afterEach(() => {
    if (originalUrl === undefined) {
      delete process.env['FILESYSTEM_MCP_PUBLIC_URL'];
    } else {
      process.env['FILESYSTEM_MCP_PUBLIC_URL'] = originalUrl;
    }
  });

  it('returns null when FILESYSTEM_MCP_PUBLIC_URL is unset and hostValidated is false', () => {
    delete process.env['FILESYSTEM_MCP_PUBLIC_URL'];
    const req = { headers: { host: 'example.com' }, secure: true } as Request;
    assert.equal(protectedResourceUrl(req, false), null);
  });

  it('returns the configured URL when it is set, regardless of hostValidated', () => {
    process.env['FILESYSTEM_MCP_PUBLIC_URL'] = 'https://configured.example.com/mcp';
    const req = { headers: { host: 'example.com' }, secure: true } as Request;
    const urlFalse = protectedResourceUrl(req, false);
    assert.ok(urlFalse);
    assert.equal(urlFalse?.href, 'https://configured.example.com/mcp');

    const urlTrue = protectedResourceUrl(req, true);
    assert.ok(urlTrue);
    assert.equal(urlTrue?.href, 'https://configured.example.com/mcp');
  });
});
