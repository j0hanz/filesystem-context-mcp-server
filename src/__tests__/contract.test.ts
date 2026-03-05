/**
 * Contract tests: verify that all 18 tools are registered, named correctly,
 * carry the right annotations, and perform a basic smoke call.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  createTestEnv,
  getStructured,
  type TestEnv,
} from './helpers.js';

// Names of all 18 tools as registered
const ALL_TOOLS = new Set([
  'apply_patch',
  'calculate_hash',
  'mkdir',
  'rm',
  'diff_files',
  'edit',
  'ls',
  'mv',
  'read_many',
  'read',
  'search_and_replace',
  'roots',
  'grep',
  'find',
  'stat_many',
  'stat',
  'tree',
  'write',
]);

// Annotations by category
const READ_ONLY_TOOLS = new Set([
  'calculate_hash',
  'diff_files',
  'ls',
  'read_many',
  'read',
  'roots',
  'grep',
  'find',
  'stat_many',
  'stat',
  'tree',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'apply_patch',
  'edit',
  'rm',
  'mv',
  'search_and_replace',
  'write',
]);

describe('Tool contract', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('registers exactly 18 tools with correct names', async () => {
    const { tools } = await env.client.listTools();
    assert.equal(tools.length, ALL_TOOLS.size, 'Expected 18 tools');
    for (const tool of tools) {
      assert.ok(ALL_TOOLS.has(tool.name), `Unexpected tool name: ${tool.name}`);
    }
  });

  it('all tool names match the safe character pattern', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      assert.match(
        tool.name,
        /^[A-Za-z0-9_.-]+$/,
        `Tool name "${tool.name}" contains invalid characters`
      );
    }
  });

  it('all tools have openWorldHint: false', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      assert.equal(
        (tool.annotations as Record<string, unknown> | undefined)
          ?.openWorldHint,
        false,
        `${tool.name}: expected openWorldHint=false`
      );
    }
  });

  it('read-only tools have readOnlyHint:true and destructiveHint:false', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      if (!READ_ONLY_TOOLS.has(tool.name)) continue;
      const ann = tool.annotations as Record<string, unknown>;
      assert.equal(
        ann['readOnlyHint'],
        true,
        `${tool.name}: expected readOnlyHint=true`
      );
      assert.equal(
        ann['destructiveHint'],
        false,
        `${tool.name}: expected destructiveHint=false`
      );
    }
  });

  it('destructive tools have destructiveHint:true', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      if (!DESTRUCTIVE_TOOLS.has(tool.name)) continue;
      const ann = tool.annotations as Record<string, unknown>;
      assert.equal(
        ann['destructiveHint'],
        true,
        `${tool.name}: expected destructiveHint=true`
      );
    }
  });

  it('mkdir has idempotentHint:true and destructiveHint:false', async () => {
    const { tools } = await env.client.listTools();
    const mkdir = tools.find((t) => t.name === 'mkdir');
    assert.ok(mkdir, 'mkdir tool must exist');
    const ann = mkdir.annotations as Record<string, unknown>;
    assert.equal(
      ann['idempotentHint'],
      true,
      'mkdir: expected idempotentHint=true'
    );
    assert.equal(
      ann['destructiveHint'],
      false,
      'mkdir: expected destructiveHint=false'
    );
  });

  it('smoke: roots returns ok:true with the test tmpDir', async () => {
    const rawResult = await env.client.callTool({
      name: 'roots',
      arguments: {},
    });
    const result = rawResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.ok(Array.isArray(sc['directories']), 'Expected directories array');
    const dirs = sc['directories'] as string[];
    assert.ok(dirs.length > 0, 'Expected at least one allowed directory');
  });

  it('structuredContent matches outputSchema shape for read-only tools', async () => {
    // ls: returns ok, entries[]
    const lsResult = await env.client.callTool({
      name: 'ls',
      arguments: { path: env.tmpDir },
    });
    assertOk(lsResult);
    const lsSc = getStructured(lsResult);
    assert.equal(lsSc['ok'], true);
    assert.ok(Array.isArray(lsSc['entries']), 'ls: expected entries array');
    assert.equal(typeof lsSc['totalEntries'], 'number');

    // stat: returns ok, info.type, info.size, etc.
    const statResult = await env.client.callTool({
      name: 'stat',
      arguments: { path: env.tmpDir },
    });
    assertOk(statResult);
    const statSc = getStructured(statResult);
    assert.equal(statSc['ok'], true);
    const info = statSc['info'] as Record<string, unknown>;
    assert.ok(info, 'stat: expected info object');
    assert.equal(typeof info['type'], 'string');
    assert.equal(typeof info['size'], 'number');

    // tree: returns ok, ascii string, root
    const treeResult = await env.client.callTool({
      name: 'tree',
      arguments: { path: env.tmpDir },
    });
    assertOk(treeResult);
    const treeSc = getStructured(treeResult);
    assert.equal(treeSc['ok'], true);
    assert.equal(typeof treeSc['ascii'], 'string');
    assert.equal(typeof treeSc['totalEntries'], 'number');
  });
});
