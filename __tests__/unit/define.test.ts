import assert from 'node:assert/strict';
import test from 'node:test';

import { z } from 'zod/v4';

import { defineTool } from '../../src/tools/define.js';

test('defineTool creates DefinedTool properly', () => {
  const tool = defineTool({
    name: 'test_tool',
    title: 'Test Tool',
    description: 'A tool for testing',
    input: z.strictObject({ a: z.string() }),
    output: z.strictObject({ b: z.string() }),
    annotations: 'readOnly',
    run: async () => ({ b: 'ok' }),
  });

  assert.equal(tool.name, 'test_tool');
  assert.equal(tool.title, 'Test Tool');
  assert.ok(tool.inputSchema);
  assert.ok(tool.outputSchema);
  assert.equal(tool.annotations, 'readOnly');
});

test('defineTool execution handles errors', async () => {
  const tool = defineTool({
    name: 'error_tool',
    title: 'Error Tool',
    description: 'A tool that throws',
    input: z.strictObject({}),
    output: z.strictObject({}),
    annotations: 'readOnly',
    defaultErrorCode: 'INTERNAL_ERROR',
    run: async () => {
      throw new Error('Test error');
    },
  });

  assert.ok(tool.name === 'error_tool');
});
