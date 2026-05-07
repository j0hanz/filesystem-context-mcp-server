import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

import { createTestEnv } from '../helpers.js';

const SNAPSHOT_PATH = new URL(
  './__snapshots__/tool-schemas.json',
  import.meta.url
);

async function buildSnapshot(): Promise<Record<string, unknown>> {
  const env = await createTestEnv();
  try {
    const { tools } = await env.client.listTools();
    const result: Record<string, unknown> = {};
    for (const tool of tools
      .slice()
      .sort((a, b) => a.name.localeCompare(b.name))) {
      result[tool.name] = {
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
      };
    }
    return result;
  } finally {
    await env.cleanup();
  }
}

const UPDATE_SNAPSHOT = process.env['FS_UPDATE_SCHEMA_SNAPSHOT'] === '1';

describe('tool schema snapshots', () => {
  it('matches stored snapshot (set FS_UPDATE_SCHEMA_SNAPSHOT=1 to update)', async () => {
    const current = await buildSnapshot();
    if (UPDATE_SNAPSHOT) {
      await writeFile(SNAPSHOT_PATH, JSON.stringify(current, null, 2), 'utf-8');
      return;
    }
    let stored: Record<string, unknown>;
    try {
      stored = JSON.parse(await readFile(SNAPSHOT_PATH, 'utf-8')) as Record<
        string,
        unknown
      >;
    } catch {
      throw new Error(
        'No stored schema baseline found. Run with FS_UPDATE_SCHEMA_SNAPSHOT=1 to create it.'
      );
    }
    assert.deepEqual(
      JSON.stringify(current, null, 2),
      JSON.stringify(stored, null, 2),
      'Schema snapshot mismatch — set FS_UPDATE_SCHEMA_SNAPSHOT=1 to update'
    );
  });

  it('each tool has inputSchema and no $schema at root level', async () => {
    const snap = await buildSnapshot();
    for (const [name, schemas] of Object.entries(snap)) {
      const s = schemas as Record<string, unknown>;
      assert.ok('inputSchema' in s, `${name} has inputSchema`);
      const input = s['inputSchema'] as Record<string, unknown>;
      assert.ok(
        !('$schema' in input),
        `${name} inputSchema must not have $schema at root`
      );
      if ('outputSchema' in s) {
        const output = s['outputSchema'] as Record<string, unknown>;
        assert.ok(
          !('$schema' in output),
          `${name} outputSchema must not have $schema at root`
        );
      }
    }
  });
});
