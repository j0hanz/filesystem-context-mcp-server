import assert from 'node:assert/strict';
import { afterEach, describe, it, test } from 'node:test';

import {
  WORKER_CANCEL_GRACE_MS,
  WORKER_IDLE_TIMEOUT_MS,
  WORKER_OFFLOAD_THRESHOLD_BYTES,
  WORKER_POOL_MAX,
  WORKERS_DISABLED,
} from '../../src/core/util.js';

describe('FS_CONTEXT_MAX_INLINE_MATCHES parsing', () => {
  const ORIG = process.env['FS_CONTEXT_MAX_INLINE_MATCHES'];

  afterEach(() => {
    if (ORIG === undefined) {
      delete process.env['FS_CONTEXT_MAX_INLINE_MATCHES'];
    } else {
      process.env['FS_CONTEXT_MAX_INLINE_MATCHES'] = ORIG;
    }
  });

  it('parseEnvInt treats "0" as below-minimum, returning default', async () => {
    const { parseEnvInt } = await import('../../src/core/util.js');
    process.env['FS_CONTEXT_TEST_INLINE'] = '0';
    const result = parseEnvInt('FS_CONTEXT_TEST_INLINE', 50, 1, 10_000);
    delete process.env['FS_CONTEXT_TEST_INLINE'];
    assert.equal(result, 50);
  });

  it('parseEnvInt treats "25" as valid, returning 25', async () => {
    const { parseEnvInt } = await import('../../src/core/util.js');
    process.env['FS_CONTEXT_TEST_INLINE'] = '25';
    const result = parseEnvInt('FS_CONTEXT_TEST_INLINE', 50, 1, 10_000);
    delete process.env['FS_CONTEXT_TEST_INLINE'];
    assert.equal(result, 25);
  });
});

test('worker constants are within sensible bounds', () => {
  assert.ok(WORKER_POOL_MAX >= 1 && WORKER_POOL_MAX <= 4);
  assert.equal(WORKER_IDLE_TIMEOUT_MS, 30_000);
  assert.equal(WORKER_OFFLOAD_THRESHOLD_BYTES, 256 * 1024);
  assert.equal(WORKER_CANCEL_GRACE_MS, 500);
  assert.equal(typeof WORKERS_DISABLED, 'boolean');
});
