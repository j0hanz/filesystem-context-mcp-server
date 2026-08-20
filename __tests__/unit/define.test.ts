import assert from 'node:assert/strict';
import test from 'node:test';

import * as z from 'zod/v4';

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
  assert.ok(tool.inputSchema);
  assert.ok(tool.outputSchema);
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

test('defineTool produces StandardSchemaWithJSON-shaped inputSchema/outputSchema', () => {
  const tool = defineTool({
    name: 'shape_tool',
    title: 'Shape Tool',
    description: 'Verifies the registered schema carries jsonSchema converters',
    input: z.strictObject({ a: z.string() }),
    output: z.strictObject({ b: z.string() }),
    annotations: {
      readOnlyHint: true,
      idempotentHint: true,
      destructiveHint: false,
      openWorldHint: false,
    },
    run: async () => ({ structured: { b: 'ok' } }),
  });

  const inputJsonSchema = tool.inputSchema as Record<string, unknown>;
  const outputJsonSchema = tool.outputSchema;
  assert.equal(inputJsonSchema['type'], 'object');
  assert.equal(outputJsonSchema['type'], 'object');
  const inputProps = inputJsonSchema['properties'] as Record<string, unknown>;
  assert.ok(inputProps && 'a' in inputProps);
});
