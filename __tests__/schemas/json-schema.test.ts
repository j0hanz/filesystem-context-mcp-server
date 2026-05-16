import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Validator } from '@cfworker/json-schema';

import { createTestEnv } from '../helpers.js';

// Helper: get the inputSchema JSON for a named tool from tools/list.
async function getInputSchema(name: string): Promise<Record<string, unknown>> {
  const env = await createTestEnv();
  try {
    const { tools } = await env.client.listTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) throw new Error(`Tool ${name} not found in tools/list`);
    return tool.inputSchema;
  } finally {
    await env.cleanup();
  }
}

describe('advertised schema constraints', () => {
  it('search_text: rejects absolute path in pattern', async () => {
    const schema = await getInputSchema('search_text');
    const v = new Validator(schema, '2020-12', false);
    const result = v.validate({
      searchPattern: 'hello',
      pattern: '/etc/passwd',
    });
    assert.ok(!result.valid, 'absolute glob should be rejected by advertised schema');
  });

  it('search_text: rejects traversal pattern', async () => {
    const schema = await getInputSchema('search_text');
    const v = new Validator(schema, '2020-12', false);
    const result = v.validate({ searchPattern: 'hello', pattern: '../*.ts' });
    assert.ok(!result.valid, 'traversal glob should be rejected by advertised schema');
  });

  it('replace_text: rejects absolute path in pattern', async () => {
    const schema = await getInputSchema('replace_text');
    const v = new Validator(schema, '2020-12', false);
    const result = v.validate({
      searchPattern: 'old',
      replacement: 'new',
      pattern: '/abs/path/*.ts',
    });
    assert.ok(!result.valid, 'absolute glob should be rejected by advertised schema');
  });
});
