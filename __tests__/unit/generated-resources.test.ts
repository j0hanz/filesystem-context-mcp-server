import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildServerInstructions } from '../../src/resources/generated-instructions.js';
import { buildToolCatalog } from '../../src/resources/tool-catalog.js';
import { buildToolInfo } from '../../src/resources/tool-info.js';

describe('generated LLM resources', () => {
  it('uses valid cross-tool routing examples', () => {
    const catalog = buildToolCatalog();

    assert.ok(catalog.includes('find.results[].path -> read.path'));
    assert.ok(catalog.includes('grep.matches[].file -> read.path'));
    assert.ok(!catalog.includes('grep.paths'));
  });

  it('derives task-capable guidance from tool contracts', () => {
    const instructions = buildServerInstructions();

    assert.match(instructions, /Task-capable tools: .*`grep`/u);
    assert.match(instructions, /Task-capable tools: .*`read_many`/u);
    assert.match(instructions, /Task-capable tools: .*`search_and_replace`/u);
    assert.doesNotMatch(instructions, /Task-capable tools: .*`roots`/u);
  });

  it('includes primitive routing and result contract guidance in the catalog', () => {
    const catalog = buildToolCatalog();

    assert.match(catalog, /## Primitive Routing/u);
    assert.match(
      catalog,
      /Success: returns both `content` \(JSON text\) and `structuredContent` \(when `outputSchema` is declared\)\./u
    );
    assert.match(catalog, /Task-capable tools: .*`grep`/u);
  });

  it('includes schema fields and execution info in tool info', () => {
    const toolInfo = buildToolInfo('read');

    assert.ok(toolInfo, 'Expected tool info for read');
    assert.match(toolInfo, /\*\*Input Fields:\*\*/u);
    assert.match(toolInfo, /- Schema constraints: Use one read mode only:/u);
    assert.match(
      toolInfo,
      /- Unknown fields are rejected \(`additionalProperties: false`\)\./u
    );
    assert.match(toolInfo, /- path \(string, required\):/u);
    assert.match(toolInfo, /- includeHash \(boolean, optional\):/u);
    assert.match(toolInfo, /- taskSupport: forbidden/u);
  });

  it('includes cross-field schema constraints for multi-path tools', () => {
    const mkdirInfo = buildToolInfo('mkdir');
    const moveInfo = buildToolInfo('mv');

    assert.ok(mkdirInfo, 'Expected tool info for mkdir');
    assert.ok(moveInfo, 'Expected tool info for mv');
    assert.match(
      mkdirInfo,
      /- Schema constraints: Provide either 'path' or 'paths'\./u
    );
    assert.match(
      moveInfo,
      /- Schema constraints: Provide either 'source' or 'sources'\./u
    );
  });

  it('preserves tuple and literal detail from Zod v4 JSON Schema', () => {
    const editInfo = buildToolInfo('edit');
    const rootsInfo = buildToolInfo('roots');

    assert.ok(editInfo, 'Expected tool info for edit');
    assert.ok(rootsInfo, 'Expected tool info for roots');
    assert.match(
      editInfo,
      /- lineRange \(tuple<integer, integer>, optional\): Line range modified \[start, end\] \(1-based\)/u
    );
    assert.match(
      rootsInfo,
      /- ok \(const\(true\), required\): No description\./u
    );
  });
});
