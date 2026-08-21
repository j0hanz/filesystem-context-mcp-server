import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isLevelEnabled } from '../../src/core/observability.js';

describe('isLevelEnabled', () => {
  it('passes messages at or above the minimum severity', () => {
    for (const level of ['emergency', 'alert', 'critical', 'error', 'warning'] as const) {
      assert.equal(isLevelEnabled(level, 'warning'), true, level);
    }
  });

  it('drops messages below the minimum severity', () => {
    for (const level of ['notice', 'info', 'debug'] as const) {
      assert.equal(isLevelEnabled(level, 'warning'), false, level);
    }
  });

  it('passes everything at debug and only emergency at emergency', () => {
    assert.equal(isLevelEnabled('debug', 'debug'), true);
    assert.equal(isLevelEnabled('debug', 'emergency'), false);
    assert.equal(isLevelEnabled('emergency', 'emergency'), true);
  });

  it('defaults to info: debug suppressed, info through', () => {
    // No LOG_LEVEL is set in the test environment.
    assert.equal(isLevelEnabled('debug'), false);
    assert.equal(isLevelEnabled('info'), true);
  });

  it('formats json log entries when LOG_FORMAT=json', async () => {
    const { Logger, withSession } = await import('../../src/core/observability.js');
    const originalFormat = process.env['LOG_FORMAT'];
    process.env['LOG_FORMAT'] = 'json';
    const logged: string[] = [];
    const originalConsoleError = console.error;
    console.error = (msg: unknown) => {
      logged.push(String(msg));
    };

    try {
      const err = new Error('database connection failed');
      const circular: Record<string, unknown> = { name: 'circular' };
      circular['self'] = circular;

      await withSession('test-session-123', async () => {
        Logger.info('hello structured log', { foo: 'bar' }, err, circular);
      });
      assert.equal(logged.length, 1);
      const parsed = JSON.parse(logged[0] ?? '{}') as {
        level: string;
        message: string;
        sessionId?: string;
        details?: unknown[];
      };
      assert.equal(parsed.level, 'info');
      assert.equal(parsed.message, 'hello structured log');
      assert.equal(parsed.sessionId, 'test-session-123');
      assert.equal(parsed.details?.length, 3);
      assert.deepEqual(parsed.details?.[0], { foo: 'bar' });
      assert.equal(
        (parsed.details?.[1] as { message?: string })?.message,
        'database connection failed',
      );
      assert.equal((parsed.details?.[1] as { name?: string })?.name, 'Error');
      assert.equal(typeof parsed.details?.[2], 'string');
    } finally {
      console.error = originalConsoleError;
      if (originalFormat !== undefined) {
        process.env['LOG_FORMAT'] = originalFormat;
      } else {
        delete process.env['LOG_FORMAT'];
      }
    }
  });
});
