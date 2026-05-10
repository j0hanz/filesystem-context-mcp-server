import assert from 'node:assert';
import test from 'node:test';

import { z } from 'zod';

import { toMcpSchema } from '../src/schema.js';

test('toMcpSchema generates valid standard schema', () => {
  const schema = z.strictObject({ foo: z.string() }).meta({ id: 'TestSchema' });
  const { standard, jsonSchema } = toMcpSchema(schema);
  // ~standard.jsonSchema.input() is what the MCP SDK calls to get the wire schema
  const stdSchema = (
    standard as unknown as { '~standard': { jsonSchema: { input: () => Record<string, unknown> } } }
  )['~standard'].jsonSchema;
  assert.ok(typeof stdSchema.input === 'function');
  const json = stdSchema.input();
  assert.equal(json.type, 'object');
  assert.ok(json.properties);
  // Also verify the extracted jsonSchema matches
  assert.deepEqual(json, jsonSchema);
});
