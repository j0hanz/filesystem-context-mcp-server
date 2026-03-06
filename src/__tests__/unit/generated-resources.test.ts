import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildServerInstructions } from '../../resources/generated-instructions.js';
import { buildToolCatalog } from '../../resources/tool-catalog.js';
import { buildToolInfo } from '../../resources/tool-info.js';

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

  it('includes primitive routing and result contract guidance in the catalog', () => {
    const catalog = buildToolCatalog();

    assert.match(catalog, /## Primitive Routing/u);
    assert.match(
      catalog,
      /Successful tools return `content` and usually `structuredContent`\./u
    );
    assert.match(catalog, /Task-capable tools: .*`grep`/u);
  });

  it('includes schema and protocol notes in tool info', () => {
    const toolInfo = buildToolInfo('read');

    assert.ok(toolInfo, 'Expected tool info for read');
    assert.match(toolInfo, /<input_fields>/u);
    assert.match(toolInfo, /- path \(string, required\):/u);
    assert.match(toolInfo, /- taskSupport: forbidden/u);
    assert.match(
      toolInfo,
      /Protocol failures use JSON-RPC `error`; execution failures use tool result `isError: true`\./u
    );
  });
});
