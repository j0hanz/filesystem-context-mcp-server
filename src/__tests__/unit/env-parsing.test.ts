import assert from 'node:assert/strict';
import { describe, it, afterEach } from 'node:test';

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
    const { parseEnvInt } = await import('../../lib/constants.js');
    process.env['FS_CONTEXT_TEST_INLINE'] = '0';
    const result = parseEnvInt('FS_CONTEXT_TEST_INLINE', 50, 1, 10_000);
    delete process.env['FS_CONTEXT_TEST_INLINE'];
    assert.equal(result, 50);
  });

  it('parseEnvInt treats "25" as valid, returning 25', async () => {
    const { parseEnvInt } = await import('../../lib/constants.js');
    process.env['FS_CONTEXT_TEST_INLINE'] = '25';
    const result = parseEnvInt('FS_CONTEXT_TEST_INLINE', 50, 1, 10_000);
    delete process.env['FS_CONTEXT_TEST_INLINE'];
    assert.equal(result, 25);
  });
});
