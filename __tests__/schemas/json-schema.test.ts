import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { Validator } from '@cfworker/json-schema';
import { z } from 'zod/v4';

import { IsoDateTime, NonNegInt, toMcpSchema as toToolJsonSchema } from '../../src/schema.js';
import { createTestEnv } from '../helpers.js';

describe('toToolJsonSchema', () => {
  it('strips datetime pattern from $defs', () => {
    const schema = z.strictObject({ ts: IsoDateTime });
    // Get the raw JSON first to inspect
    const raw = z.toJSONSchema(schema) as Record<string, unknown>;

    // Verify pattern exists in raw Zod output
    const rawDefs = raw['$defs'] as Record<string, unknown>;
    assert.ok('IsoDateTime' in rawDefs);
    assert.ok('pattern' in (rawDefs['IsoDateTime'] as Record<string, unknown>));

    // Now convert via toToolJsonSchema (which calls walk and fromJsonSchema)
    const result = toToolJsonSchema(schema);
    assert.ok(result, 'toToolJsonSchema returns a result');
    assert.ok('standard' in result);
    assert.ok('jsonSchema' in result);
  });

  it('strips MAX_SAFE_INTEGER maximum from integer fields', () => {
    const schema = z.strictObject({ count: NonNegInt });
    const raw = z.toJSONSchema(schema) as Record<string, unknown>;

    // Verify MAX_SAFE_INTEGER exists in raw output
    const rawStr = JSON.stringify(raw);
    assert.ok(rawStr.includes('9007199254740991'));

    // Now convert - verify it returns McpSchemaPair
    const result = toToolJsonSchema(schema);
    assert.ok(result, 'toToolJsonSchema returns a result');
  });

  it('augment function can inject allOf constraints', () => {
    const schema = z.strictObject({
      a: z.string().optional(),
      b: z.string().optional(),
    });
    // The augment function is called on the cleaned JSON before wrapping
    const result = toToolJsonSchema(schema, (s) => ({
      ...s,
      allOf: [{ if: { required: ['a'] }, then: { not: { required: ['b'] } } }],
    }));
    assert.ok(result, 'augmented schema returns a result');
    assert.ok('standard' in result);
    assert.ok('jsonSchema' in result);
  });
});

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
  it('read: rejects head + tail together', async () => {
    const schema = await getInputSchema('read');
    const v = new Validator(schema, '2020-12', false);
    const result = v.validate({ path: '/tmp/f.txt', head: 10, tail: 5 });
    assert.ok(!result.valid, 'head+tail should be rejected by advertised schema');
  });

  it('read: rejects head + startLine together', async () => {
    const schema = await getInputSchema('read');
    const v = new Validator(schema, '2020-12', false);
    const result = v.validate({
      path: '/tmp/f.txt',
      head: 10,
      startLine: 1,
    });
    assert.ok(!result.valid, 'head+startLine should be rejected by advertised schema');
  });

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
