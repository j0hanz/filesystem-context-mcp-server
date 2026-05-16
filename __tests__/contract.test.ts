/**
 * Contract tests: verify that all filesystem tools are registered, named correctly,
 * carry the right annotations, and perform a basic smoke call.
 */
import { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertOk, createTestEnv, getStructured, type TestEnv } from './helpers.js';

// Names of all 12 tools as registered
const ALL_TOOLS = new Set([
  'create',
  'hash_file',
  'delete',
  'edit',
  'list',
  'move',
  'read',
  'replace_text',
  'list_roots',
  'search_text',
  'find_files',
  'stat',
]);

// Annotations by category
const READ_ONLY_TOOLS = new Set([
  'hash_file',
  'list',
  'read',
  'list_roots',
  'search_text',
  'find_files',
  'stat',
]);

const DESTRUCTIVE_TOOLS = new Set(['create', 'edit', 'delete', 'move', 'replace_text']);

describe('Tool contract', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('registers exactly 12 tools with correct names', async () => {
    const { tools } = await env.client.listTools();
    assert.equal(tools.length, ALL_TOOLS.size, 'Expected 12 tools');
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
        `Tool name "${tool.name}" contains invalid characters`,
      );
    }
  });

  it('all tools have openWorldHint: false', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      assert.equal(
        (tool.annotations as Record<string, unknown> | undefined)?.openWorldHint,
        false,
        `${tool.name}: expected openWorldHint=false`,
      );
    }
  });

  it('read-only tools have readOnlyHint:true and destructiveHint:false', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      if (!READ_ONLY_TOOLS.has(tool.name)) continue;
      const ann = tool.annotations as Record<string, unknown>;
      assert.equal(ann['readOnlyHint'], true, `${tool.name}: expected readOnlyHint=true`);
      assert.equal(ann['destructiveHint'], false, `${tool.name}: expected destructiveHint=false`);
    }
  });

  it('destructive tools have destructiveHint:true', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      if (!DESTRUCTIVE_TOOLS.has(tool.name)) continue;
      const ann = tool.annotations as Record<string, unknown>;
      assert.equal(ann['destructiveHint'], true, `${tool.name}: expected destructiveHint=true`);
    }
  });

  it('create has idempotentHint:false and destructiveHint:true', async () => {
    const { tools } = await env.client.listTools();
    const create = tools.find((t) => t.name === 'create');
    assert.ok(create, 'create tool must exist');
    const ann = create.annotations as Record<string, unknown>;
    assert.equal(ann['idempotentHint'], false, 'create: expected idempotentHint=false');
    assert.equal(ann['destructiveHint'], true, 'create: expected destructiveHint=true');
  });

  it('smoke: list_roots returns ok:true with the test tmpDir', async () => {
    const rawResult = await env.client.callTool({
      name: 'list_roots',
      arguments: {},
    });
    const result = rawResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.ok(Array.isArray(sc['roots']), 'Expected roots array');
    const roots = sc['roots'] as { uri: string }[];
    assert.ok(roots.length > 0, 'Expected at least one allowed root');
  });

  it('structuredContent matches outputSchema shape for read-only tools', async () => {
    // list: returns ok, entries[]
    const listResult = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir },
    });
    assertOk(listResult);
    const listSc = getStructured(listResult);
    assert.equal(listSc['ok'], true);
    assert.ok(Array.isArray(listSc['entries']), 'list: expected entries array');
    assert.equal(typeof listSc['totalEntries'], 'number');

    // stat: returns ok, results[0].value.type, results[0].value.size, etc.
    const statResult = await env.client.callTool({
      name: 'stat',
      arguments: { path: env.tmpDir },
    });
    assertOk(statResult);
    const statSc = getStructured(statResult);
    assert.equal(statSc['ok'], true);
    const statResults = statSc['results'] as Record<string, unknown>[];
    assert.ok(Array.isArray(statResults), 'stat: expected results array');
    assert.equal(statResults.length, 1, 'stat: expected one result');
    const value = statResults[0]?.['value'] as Record<string, unknown> | undefined;
    assert.ok(value, 'stat: expected value object');
    assert.equal(typeof value['type'], 'string');
    assert.equal(typeof value['size'], 'number');
  });

  it('task-capable tools expose execution.taskSupport in tools/list', async () => {
    const TASK_OPTIONAL_TOOLS = new Set<string>();

    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      const execution = (tool as Record<string, unknown>).execution as
        | Record<string, unknown>
        | undefined;
      if (TASK_OPTIONAL_TOOLS.has(tool.name)) {
        assert.equal(
          execution?.taskSupport,
          'optional',
          `${tool.name}: expected execution.taskSupport='optional'`,
        );
      } else {
        // forbidden tools should not have taskSupport or have it as 'forbidden'
        const taskSupport = execution?.taskSupport;
        assert.ok(
          taskSupport === undefined || taskSupport === 'forbidden',
          `${tool.name}: expected taskSupport undefined or 'forbidden', got '${String(taskSupport)}'`,
        );
      }
    }
  });

  it('all read-only tools return structuredContent with ok:true', async () => {
    // Create a test file so file-dependent tools have a target
    const testFile = join(env.tmpDir, 'contract-test.txt');
    await writeFile(testFile, 'hello world\nline two\n');

    const testCases: {
      name: string;
      arguments: Record<string, unknown>;
    }[] = [
      { name: 'list_roots', arguments: {} },
      { name: 'list', arguments: { path: env.tmpDir } },
      { name: 'find_files', arguments: { path: env.tmpDir, pattern: '**/*' } },
      { name: 'stat', arguments: { path: testFile } },
      { name: 'stat', arguments: { paths: [testFile] } },
      { name: 'read', arguments: { path: testFile } },
      { name: 'read', arguments: { paths: [testFile] } },
      { name: 'search_text', arguments: { path: env.tmpDir, searchPattern: 'hello' } },
      { name: 'hash_file', arguments: { path: testFile } },
    ];

    for (const tc of testCases) {
      const result = await env.client.callTool(tc);
      assertOk(result);
      const sc = getStructured(result);
      assert.equal(sc['ok'], true, `${tc.name}: expected structuredContent.ok === true`);
    }
  });

  it('all input schema properties have descriptions', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      const schema = tool.inputSchema as {
        properties?: Record<string, { description?: string; $ref?: string }>;
      };
      if (!schema.properties) continue;
      for (const [propName, prop] of Object.entries(schema.properties)) {
        // $ref properties are described at their definition site
        if (prop['$ref']) continue;
        assert.ok(
          prop.description && prop.description.length > 0,
          `${tool.name}.${propName}: missing description`,
        );
      }
    }
  });

  it('list.maxDepth default is 1 and description matches constant', async () => {
    const { tools } = await env.client.listTools();
    const list = tools.find((t) => t.name === 'list');
    assert.ok(list, 'list tool must exist');
    const schema = list.inputSchema as {
      properties?: Record<string, { default?: number; description?: string }>;
    };
    const maxDepthProp = schema.properties?.['maxDepth'];
    assert.ok(maxDepthProp, 'list must expose maxDepth property');
    assert.equal(maxDepthProp.default, 1, 'list.maxDepth default must be 1');
    assert.ok(
      maxDepthProp.description?.includes('1'),
      `list.maxDepth description must mention 1, got: "${String(maxDepthProp.description)}"`,
    );
  });

  it('no tool description references filePattern', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      assert.ok(
        !tool.description?.includes('filePattern'),
        `${tool.name}: description must not reference stale "filePattern" parameter name`,
      );
    }
  });
});

describe('Prompts contract', () => {
  it('ALL_PROMPTS matches the 4 expected prompts', async () => {
    const { ALL_PROMPTS } = await import('../src/prompts.js');
    const names = ALL_PROMPTS.map((p) => p.name).sort();
    assert.deepEqual(names, ['analyze-path', 'find-in-tree', 'get-help', 'summarize-directory']);
  });
});

describe('Completion contract', () => {
  // Verify that all prompts and resource templates that declare completable
  // args actually return completions — and that undeclared args return empty.
  // A regression here means someone added a prompt arg without completable().

  async function makeServer(): Promise<{
    server: McpServer;
    client: Client;
    tmpDir: string;
    teardown: () => Promise<void>;
  }> {
    const { registerAllPrompts } = await import('../src/prompts.js');
    const { registerAllResources } = await import('../src/resources.js');
    const { PathGuard } = await import('../src/core/path.js');
    const { createInMemoryResourceStore } = await import('../src/core/store.js');
    const { LinkedTransport } = await import('./linked-transport.js');

    const tmpDir = await mkdtemp(join(tmpdir(), `fsmcp-cc-${randomUUID().slice(0, 8)}-`));
    await writeFile(join(tmpDir, 'sample.txt'), 'sample');
    const pathGuard = await PathGuard.fromAllowedDirectories([tmpDir]);

    const server = new McpServer(
      { name: 'contract-completion-server', version: '0.0.0' },
      { capabilities: { completions: {} } },
    );

    // Set up ResourceStore for resource registration
    const resourceStore = createInMemoryResourceStore();

    registerAllPrompts(server, {
      pathGuard,
      instructions: 'test instructions',
      isInitialized: () => true,
    });
    registerAllResources(server, {
      resourceStore,
    });

    const client = new Client({ name: 'contract-client', version: '1.0.0' });
    const [ct, st] = LinkedTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    return {
      server,
      client,
      tmpDir,
      teardown: async () => {
        await client.close().catch(() => {});
        await server.close().catch(() => {});
        await rm(tmpDir, { recursive: true, force: true });
      },
    };
  }

  it('analyze-path: path arg returns path completions', async () => {
    const { client, tmpDir, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: tmpDir },
      });
      assert.ok(result.completion.values.length > 0, 'analyze-path.path must return completions');
    } finally {
      await teardown();
    }
  });

  it('get-help: topic arg returns section completions', async () => {
    const { client, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'topic', value: '' },
      });
      assert.ok(
        result.completion.values.length > 0,
        'get-help.topic must return at least one topic',
      );
    } finally {
      await teardown();
    }
  });

  it('get-help: undeclared arg returns empty', async () => {
    const { client, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: '/any' },
      });
      assert.deepEqual(
        result.completion.values,
        [],
        'get-help has no path arg — must return empty (strict SDK dispatch)',
      );
    } finally {
      await teardown();
    }
  });
});
