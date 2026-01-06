import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ErrorCode, getSuggestion } from '../../lib/errors.js';

void it('getSuggestion returns suggestions for all error codes', () => {
  const errorCodes = Object.values(ErrorCode);
  const suggestions = errorCodes.map((code) => getSuggestion(code));
  assert.ok(
    suggestions.every(
      (suggestion) =>
        typeof suggestion === 'string' && suggestion.trim().length > 0
    )
  );
});
