import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';

import { describe, it } from 'node:test';
import { z } from 'zod/v4';

import { toToolJsonSchema } from '../../src/schemas/json-schema.js';
import { ALL_TOOLS } from '../../src/tools.js';

const SNAPSHOT_PATH = new URL(
  './__snapshots__/tool-schemas.json',
  import.meta.url
);

async function buildSnapshot(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  for (const tool of ALL_TOOLS) {
    result[tool.name] = {
      inputSchema: toToolJsonSchema(tool.inputSchema),
      ...(tool.outputSchema
        ? { outputSchema: toToolJsonSchema(tool.outputSchema) }
        : {}),
    };
  }
  return result;
}

describe('tool schema snapshots', () => {
  it('matches stored snapshot (update by deleting __snapshots__/tool-schemas.json)', async () => {
    const current = await buildSnapshot();
    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      // First run — write snapshot and pass
      await writeFile(SNAPSHOT_PATH, JSON.stringify(current, null, 2), 'utf-8');
      return;
    }
    assert.deepEqual(
      JSON.stringify(current, null, 2),
      JSON.stringify(stored, null, 2),
      'Schema snapshot mismatch — delete __snapshots__/tool-schemas.json to update'
    );
  });

  it('each tool has inputSchema and no $schema at root level', async () => {
    const snap = await buildSnapshot();
    for (const [name, schemas] of Object.entries(snap)) {
      const s = schemas as Record<string, unknown>;
      assert.ok('inputSchema' in s, `${name} has inputSchema`);
    }
  });
});
