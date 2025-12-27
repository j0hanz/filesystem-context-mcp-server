import { expect, it } from 'vitest';

import { processMatches } from '../../../lib/file-operations/search-definitions/matchers.js';
import {
  buildCombinedPattern,
  buildSearchOptions,
  getMaxResults,
} from '../../../lib/file-operations/search-definitions/patterns.js';

it('buildCombinedPattern falls back without name or type', () => {
  const pattern = buildCombinedPattern({ path: '/tmp' });
  expect(pattern).toContain('class');
});

it('buildCombinedPattern adds variable-function patterns when needed', () => {
  const pattern = buildCombinedPattern({
    path: '/tmp',
    name: 'handler',
    type: 'function',
  });
  expect(pattern).toContain('|');
});

it('buildSearchOptions expands max results safely', () => {
  const options = buildSearchOptions(
    { path: '/tmp', includeHidden: true, contextLines: 1 },
    getMaxResults({ path: '/tmp', maxResults: 5 })
  );
  expect(options.maxResults).toBe(15);
  expect(options.includeHidden).toBe(true);
});

it('processMatches skips non-arrow const when searching for function', () => {
  const matches = [
    {
      file: '/tmp/sample.ts',
      line: 1,
      content: 'const value = 123;',
    },
  ];

  const results = processMatches(matches, '/tmp', undefined, 'function', true);
  expect(results).toHaveLength(0);
});

it('processMatches skips unknown function names', () => {
  const matches = [
    {
      file: '/tmp/sample.ts',
      line: 1,
      content: 'export default function () {}',
    },
  ];

  const results = processMatches(matches, '/tmp', undefined, 'function', true);
  expect(results).toHaveLength(0);
});
