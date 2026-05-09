import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { maybeStripStructuredContentFromResult } from '../src/core/util.js';
import { withDefaultIcons } from '../../src/tools/shared.js';

describe('tool registration shape', () => {
  it('normalizes top-level taskSupport into execution.taskSupport', () => {
    const registered = withDefaultIcons(
      {
        name: 'example',
        description: 'example',
        inputSchema: { type: 'object', additionalProperties: false },
        taskSupport: 'optional' as const,
      },
      undefined,
    ) as {
      execution?: { taskSupport?: string };
      taskSupport?: string;
    };

    assert.equal(registered.taskSupport, undefined);
    assert.equal(registered.execution?.taskSupport, 'optional');
  });

  it('strips invalid top-level taskSupport without disturbing execution metadata', () => {
    const registered = withDefaultIcons(
      {
        name: 'example',
        description: 'example',
        inputSchema: { type: 'object', additionalProperties: false },
        taskSupport: 'sometimes',
        execution: {
          taskSupport: 'required' as const,
          mode: 'background',
        },
      },
      undefined,
    ) as {
      execution?: { taskSupport?: string; mode?: string };
      taskSupport?: string;
    };

    assert.equal(registered.taskSupport, undefined);
    assert.equal(registered.execution?.taskSupport, 'required');
    assert.equal(registered.execution?.mode, 'background');
  });
});

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


