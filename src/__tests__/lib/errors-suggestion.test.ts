import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ErrorCode, getSuggestion } from '../../lib/errors.js';

void it('getSuggestion returns suggestions for all error codes', () => {
  const errorCodes = Object.values(ErrorCode);
  for (const code of errorCodes) {
    const suggestion = getSuggestion(code);
    assert.ok(suggestion);
    assert.strictEqual(typeof suggestion, 'string');
  }
});
