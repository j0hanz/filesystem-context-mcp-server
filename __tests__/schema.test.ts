import assert from 'node:assert';
import test from 'node:test';

import { z } from 'zod';

import { batchResult, paginated, toMcpSchema } from '../src/schema.js';

test('toMcpSchema generates valid standard schema', () => {
  const schema = z.strictObject({ foo: z.string() }).meta({ id: 'TestSchema' });
  const mcp = toMcpSchema(schema);
  assert.ok(mcp.jsonSchema.input);
  const json = mcp.jsonSchema.input() as Record<string, unknown>;
  assert.equal(json.type, 'object');
  assert.ok(json.$defs);
});

test('batchResult creates correct discriminated union', () => {
  const schema = batchResult(z.string());
  assert.equal(schema.def.discriminator, 'ok');
});

test('paginated creates correct discriminated union', () => {
  const schema = paginated(z.string());
  assert.equal(schema.def.discriminator, 'hasMore');
});
