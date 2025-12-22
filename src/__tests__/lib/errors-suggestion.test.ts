import { expect, it } from 'vitest';

import { ErrorCode, getSuggestion } from '../../lib/errors.js';

it('getSuggestion returns suggestions for all error codes', () => {
  const errorCodes = Object.values(ErrorCode);
  for (const code of errorCodes) {
    const suggestion = getSuggestion(code);
    expect(suggestion).toBeTruthy();
    expect(typeof suggestion).toBe('string');
  }
});
