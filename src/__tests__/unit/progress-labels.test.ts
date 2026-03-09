import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { truncateProgressPattern } from '../../tools/shared.js';

describe('truncateProgressPattern', () => {
  it('returns short patterns unchanged', () => {
    assert.equal(truncateProgressPattern('foo'), 'foo');
    assert.equal(truncateProgressPattern('a|b'), 'a|b');
  });

  it('returns pattern at exact maxLength unchanged', () => {
    const exact = 'a'.repeat(40);
    assert.equal(truncateProgressPattern(exact), exact);
  });

  it('hard-truncates long patterns without pipe', () => {
    const long = 'a'.repeat(50);
    const result = truncateProgressPattern(long);
    assert.equal(result, `${'a'.repeat(40)}…`);
    assert.equal(result.length, 41); // 40 chars + ellipsis
  });

  it('shows first 2 segments for pipe-separated patterns', () => {
    const pattern =
      'MatcherOptionsSchema|validatePattern|buildMatcher|scanFileInWorker|sortSearchResults|headFile';
    const result = truncateProgressPattern(pattern);
    assert.equal(result, 'MatcherOptionsSchema|validatePattern…');
  });

  it('hard-truncates when first 2 segments exceed maxLength', () => {
    const pattern = `${'a'.repeat(25)}|${'b'.repeat(25)}|ccc`;
    const result = truncateProgressPattern(pattern);
    // first 2 segments = 25 + 1 + 25 = 51 chars > 40
    assert.equal(result.length, 41); // 40 + ellipsis
    assert.ok(result.endsWith('…'));
  });

  it('respects custom maxLength', () => {
    const result = truncateProgressPattern('abcdefghij', 5);
    assert.equal(result, 'abcde…');
  });

  it('handles single-segment pipe pattern (trailing pipe)', () => {
    // edge: split on '|' with empty second segment
    const result = truncateProgressPattern('a'.repeat(50) + '|', 40);
    assert.ok(result.endsWith('…'));
    // preview = first + '|' + '' = first + '|' which is 51 chars, hard-truncated
    assert.equal(result.length, 41);
  });
});
