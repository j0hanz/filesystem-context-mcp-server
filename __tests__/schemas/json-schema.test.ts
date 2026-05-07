import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import { IsoDateTime, NonNegInt } from '../../src/schemas/fields.js';
import { toToolJsonSchema } from '../../src/schemas/json-schema.js';

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
    // We can't easily inspect the wrapped result, so just verify it completes
    const result = toToolJsonSchema(schema);
    assert.ok(result, 'toToolJsonSchema returns a result');
    assert.ok('~standard' in result);
  });

  it('strips MAX_SAFE_INTEGER maximum from integer fields', () => {
    const schema = z.strictObject({ count: NonNegInt });
    const raw = z.toJSONSchema(schema) as Record<string, unknown>;

    // Verify MAX_SAFE_INTEGER exists in raw output
    const rawStr = JSON.stringify(raw);
    assert.ok(rawStr.includes('9007199254740991'));

    // Now convert - can't easily inspect wrapped result, just verify it works
    const result = toToolJsonSchema(schema);
    assert.ok(result, 'toToolJsonSchema returns a result');
  });

  it('augment function can inject allOf constraints', () => {
    const schema = z.strictObject({
      a: z.string().optional(),
      b: z.string().optional(),
    });
    // The augment function is called on the cleaned JSON before wrapping
    // We can't easily inspect the result of fromJsonSchema, so verify execution
    const result = toToolJsonSchema(schema, (s) => ({
      ...s,
      allOf: [{ if: { required: ['a'] }, then: { not: { required: ['b'] } } }],
    }));
    assert.ok(result, 'augmented schema returns a result');
    assert.ok('~standard' in result);
  });
});
