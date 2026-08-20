import assert from 'node:assert/strict';
import test from 'node:test';

import { compileRegex, freeRegex } from '../../src/core/search.js';

test('freeRegex releases compiled patterns: many compile/free cycles do not abort', () => {
  // The old re2-wasm never freed wasm-heap memory and its FinalizationRegistry
  // could not keep up, so enough compiled patterns aborted the process. This
  // pins that freeRegex actually disposes on the @adguard fork.
  for (let i = 0; i < 5000; i++) {
    const re = compileRegex(`a${i}`, { caseSensitive: true });
    // A trivial exec proves the handle is live before freeing.
    assert.equal(re.exec(`a${i}`)?.[0], `a${i}`);
    freeRegex(re);
  }
  // Reaching here at all is the assertion — an emscripten abort would throw.
  assert.ok(true);
});

test('compileRegex rejects backreferences and lookahead (RE2 semantics, not V8 RegExp)', () => {
  // RE2 does not support backreferences or lookahead; V8 RegExp does. If the
  // engine silently swapped to a backtracking RegExp, these would compile
  // instead of throwing, and the ReDoS defense would be gone.
  assert.throws(() => compileRegex('(foo)\\1'), SyntaxError); // backreference
  assert.throws(() => compileRegex('(?=foo)'), SyntaxError); // lookahead
  // A plain pattern still compiles and matches.
  const re = compileRegex('foo', { caseSensitive: false });
  try {
    assert.equal(re.exec('FOO bar')?.[0], 'FOO');
  } finally {
    freeRegex(re);
  }
});
