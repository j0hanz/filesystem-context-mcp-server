import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildServerInstructions } from '../../resources/generated-instructions.js';
import { buildToolCatalog } from '../../resources/tool-catalog.js';

describe('generated LLM resources', () => {
  it('uses valid cross-tool routing examples', () => {
    const catalog = buildToolCatalog();

    assert.ok(catalog.includes('find.results[].path -> read.path'));
    assert.ok(catalog.includes('grep.matches[].file -> read.path'));
    assert.ok(!catalog.includes('grep.paths'));
  });

  it('derives task-capable guidance from tool contracts', () => {
    const instructions = buildServerInstructions();

    assert.match(instructions, /Optional task mode: .*`grep`/u);
    assert.match(instructions, /Optional task mode: .*`read_many`/u);
    assert.match(instructions, /Optional task mode: .*`search_and_replace`/u);
    assert.doesNotMatch(instructions, /Task-capable: .*`roots`/u);
    assert.match(instructions, /Required task mode: none\./u);
  });
});
