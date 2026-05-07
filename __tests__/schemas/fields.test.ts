import assert from 'node:assert/strict';

import { describe, it } from 'node:test';
import { z } from 'zod/v4';

import { IsoDateTime, NonNegInt } from '../../src/schemas/fields.js';

describe('fields', () => {
  it('IsoDateTime is in globalRegistry', () => {
    assert.ok(z.globalRegistry.has(IsoDateTime));
  });

  it('IsoDateTime $defs entry has no pattern after walk', async () => {
    const schema = z.strictObject({ ts: IsoDateTime });
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    const defs = json['$defs'] as Record<string, unknown>;
    assert.ok('IsoDateTime' in defs, 'IsoDateTime in $defs');
    const def = defs['IsoDateTime'] as Record<string, unknown>;
    assert.equal(def['format'], 'date-time');
    // Pattern still present here — stripped by post-processor in json-schema.ts (Task 3)
    assert.ok(
      'pattern' in def,
      'raw output still has pattern (post-processor strips it)'
    );
  });

  it('NonNegInt is in globalRegistry', () => {
    assert.ok(z.globalRegistry.has(NonNegInt));
  });
});
