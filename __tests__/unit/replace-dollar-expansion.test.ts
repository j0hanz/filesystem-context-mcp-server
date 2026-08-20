/**
 * search_and_replace: `$` substitutions in the replacement template.
 *
 * RE2's own string replacer throws `Invalid replacement string` on any `$` it
 * does not recognise — so a replacement of `$100` or a trailing `$` used to
 * fail the whole tool where RegExp inserts the `$` literally — and renders an
 * out-of-range `$5` as `$4`. The matcher expands the template itself instead,
 * and these cases pin it to RegExp's behaviour.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { compileRegex, freeRegex } from '../../src/core/search/engine.js';
import { createRegexReplacementMatcher } from '../../src/tools/replace-in-files.js';

function replaceWith(pattern: string, content: string, template: string): string {
  const regex = compileRegex(pattern, { caseSensitive: true });
  try {
    return createRegexReplacementMatcher(regex, true).replace(content, template);
  } finally {
    freeRegex(regex);
  }
}

describe('regex replacement — $ expansion matches RegExp', () => {
  const cases: [name: string, pattern: string, content: string, template: string][] = [
    ['a bare dollar stays literal', '(\\d+)', 'price 42 here', 'cost $'],
    ['an unrecognised $x stays literal', '(\\d+)', 'price 42 here', '$x'],
    ['a literal amount survives', 'PRICE', 'PRICE here', '$100'],
    ['capture groups expand', '(\\d)(\\d)', 'a12b', '$2$1'],
    ['$& is the whole match', '\\d+', 'a12b', '[$&]'],
    ['$$ is one dollar', '\\d+', 'a12b', '$$'],
    ['an out-of-range group stays literal', '(\\d+)', 'a12b', '$5'],
    ['$12 falls back to group 1 plus a literal 2', '(\\d)(\\d)', 'a12b', '$12'],
    ['$` is the prefix', '\\d+', 'a12b', '$`'],
    ["$' is the suffix", '\\d+', 'a12b', "$'"],
  ];

  for (const [name, pattern, content, template] of cases) {
    it(name, () => {
      const expected = content.replace(new RegExp(pattern, 'g'), template);
      assert.equal(replaceWith(pattern, content, template), expected);
    });
  }

  it('inserts the replacement verbatim when expansion is off', () => {
    const regex = compileRegex('needle', { caseSensitive: true });
    try {
      // Literal search: `$&` must land as those two characters, not the match.
      assert.equal(
        createRegexReplacementMatcher(regex, false).replace('a needle b', '$&'),
        'a $& b',
      );
    } finally {
      freeRegex(regex);
    }
  });

  it('rescans from the start for each file it is asked about', () => {
    const regex = compileRegex('needle', { caseSensitive: true });
    try {
      const matcher = createRegexReplacementMatcher(regex, false);
      // The regex is global and shared across the batch: a stale lastIndex from
      // the first file would make the second one read as having no match.
      assert.equal(matcher.testBuffer(Buffer.from('needle at the front')), true);
      assert.equal(matcher.testBuffer(Buffer.from('needle again')), true);
    } finally {
      freeRegex(regex);
    }
  });
});
