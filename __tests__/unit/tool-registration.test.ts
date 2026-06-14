import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import type { ServerDeps } from '../../src/core/registrar.js';
import { maybeStripStructuredContentFromResult } from '../../src/core/util.js';

describe('FS_CONTEXT_STRIP_STRUCTURED', () => {
  const ENV_KEY = 'FS_CONTEXT_STRIP_STRUCTURED';
  const originalValue = process.env[ENV_KEY];

  afterEach(() => {
    if (originalValue === undefined) {
      Reflect.deleteProperty(process.env, ENV_KEY);
    } else {
      process.env[ENV_KEY] = originalValue;
    }
  });

  it('passes through result unchanged when flag is unset', () => {
    Reflect.deleteProperty(process.env, ENV_KEY);
    const result = { content: [], structuredContent: { ok: true } };
    const stripped = maybeStripStructuredContentFromResult(result);
    assert.deepEqual(stripped, result);
    assert.ok(Object.hasOwn(stripped, 'structuredContent'));
  });

  it('removes structuredContent when flag is "true"', () => {
    process.env[ENV_KEY] = 'true';
    const result = {
      content: [{ type: 'text' as const, text: '{}' }],
      structuredContent: { ok: true },
    };
    const stripped = maybeStripStructuredContentFromResult(result);
    assert.ok(!Object.hasOwn(stripped, 'structuredContent'));
    assert.equal((stripped as Record<string, unknown>).content, result.content);
  });

  it('removes structuredContent when flag is "1"', () => {
    process.env[ENV_KEY] = '1';
    const result = {
      content: [{ type: 'text' as const, text: '{}' }],
      structuredContent: { ok: true, path: '/tmp' },
    };
    const stripped = maybeStripStructuredContentFromResult(result);
    assert.ok(!Object.hasOwn(stripped, 'structuredContent'));
  });

  it('returns result as-is when it has no structuredContent', () => {
    process.env[ENV_KEY] = 'true';
    const result = { content: [], isError: true as const };
    const stripped = maybeStripStructuredContentFromResult(result);
    assert.deepEqual(stripped, result);
  });
});

describe('Tool Registration', () => {
  it('registers request_access along with other tools', async () => {
    const { toolsRegistrar } = await import('../../src/tools/index.js');
    const registered: string[] = [];
    const mockDeps = {
      server: {
        registerTool(name: string) {
          registered.push(name);
        },
      },
      isInitialized: () => true,
      pathGuard: {},
      resourceStore: {},
    };

    toolsRegistrar.register(mockDeps as unknown as ServerDeps);

    assert.ok(registered.includes('request_access'), 'Expected request_access to be registered');
    assert.ok(registered.includes('read'), 'Expected read to be registered');
    assert.ok(registered.includes('stat'), 'Expected stat to be registered');
  });
});
