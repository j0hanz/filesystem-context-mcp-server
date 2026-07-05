// __tests__/unit/transport-bind.test.ts
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { assertHttpHostPolicy, isOriginAllowed } from '../../src/transport.js';

describe('assertHttpHostPolicy (REQ-002)', () => {
  it('allows loopback binds without allowed-hosts config', () => {
    assert.doesNotThrow(() => assertHttpHostPolicy('127.0.0.1', undefined, false));
    assert.doesNotThrow(() => assertHttpHostPolicy('localhost', undefined, false));
    assert.doesNotThrow(() => assertHttpHostPolicy('[::1]', undefined, false));
  });

  it('allows a concrete non-loopback bind (Host validated against the bind host)', () => {
    assert.doesNotThrow(() => assertHttpHostPolicy('192.168.1.1', undefined, false));
  });

  it('refuses a wildcard bind (0.0.0.0) without FILESYSTEM_MCP_ALLOWED_HOSTS', () => {
    assert.throws(
      () => assertHttpHostPolicy('0.0.0.0', undefined, false),
      /Refusing to bind wildcard host.*FILESYSTEM_MCP_ALLOWED_HOSTS/,
    );
  });

  it('refuses a wildcard bind (::) without FILESYSTEM_MCP_ALLOWED_HOSTS', () => {
    assert.throws(
      () => assertHttpHostPolicy('::', undefined, false),
      /Refusing to bind wildcard host.*FILESYSTEM_MCP_ALLOWED_HOSTS/,
    );
  });

  it('allows a wildcard bind when FILESYSTEM_MCP_ALLOWED_HOSTS is set', () => {
    assert.doesNotThrow(() =>
      assertHttpHostPolicy('0.0.0.0', 'example.com,api.example.com', false),
    );
  });

  it('allows a wildcard bind under the escape hatch (ALLOW_UNRESTRICTED_HOSTS=1)', () => {
    assert.doesNotThrow(() => assertHttpHostPolicy('0.0.0.0', undefined, true));
    assert.doesNotThrow(() => assertHttpHostPolicy('::', undefined, true));
  });
});

describe('isOriginAllowed (REQ-003, end-to-end CORS)', () => {
  it('accepts localhost origins via the existing localhost pattern', () => {
    assert.equal(isOriginAllowed('http://localhost:3000', ['localhost', '127.0.0.1']), true);
    assert.equal(isOriginAllowed('https://127.0.0.1', ['localhost', '127.0.0.1']), true);
  });

  it('accepts a remote origin whose hostname is in the env-derived set (hostname-form match)', () => {
    // Origin header carries scheme + port; env value is hostname-form.
    assert.equal(isOriginAllowed('https://example.com:8080', ['example.com']), true);
    assert.equal(isOriginAllowed('http://example.com', ['example.com']), true);
  });

  it('rejects a remote origin whose hostname is not in the set', () => {
    assert.equal(isOriginAllowed('https://evil.com:8080', ['example.com']), false);
    assert.equal(isOriginAllowed('https://example.com.evil.com', ['example.com']), false);
  });

  it('rejects a malformed Origin header', () => {
    assert.equal(isOriginAllowed('not-a-url', ['example.com']), false);
    assert.equal(isOriginAllowed('', ['example.com']), false);
  });

  it('with default hostnames, a remote origin is rejected', () => {
    assert.equal(isOriginAllowed('https://example.com', ['localhost', '127.0.0.1']), false);
  });
});
