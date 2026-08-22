import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { assertOk, assertStructured } from './helpers/assertions.js';
import type { TestEnv } from './helpers/env.js';
import { createTestEnv } from './helpers/env.js';

describe('Smoke QA Tests', () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv();
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it('[SMOKE-001] Critical discovery path — list_roots -> list -> stat -> read', async () => {
    const helloPath = await env.workspace.file('hello.txt', 'hello world');

    // 1. Call list_roots
    const rootsRes = await env.client.callTool({
      name: 'list_roots',
      arguments: {},
    });
    assertOk(rootsRes);
    const rootsData = assertStructured(rootsRes) as unknown as { ok: boolean; roots: string[] };
    assert.ok(
      rootsData.roots.some((r) => r.toLowerCase() === env.workspace.normalizedRoot.toLowerCase()),
      'roots must include normalized workspace root',
    );

    // 2. Call list
    const listRes = await env.client.callTool({
      name: 'list',
      arguments: { path: env.workspace.root, maxDepth: 1 },
    });
    assertOk(listRes);
    const listData = assertStructured(listRes) as unknown as {
      entries: { name: string; type: string }[];
      markdown?: string;
    };
    assert.ok(
      listData.entries.some((e) => e.name === 'hello.txt' && e.type === 'file'),
      'entries must include hello.txt',
    );
    assert.ok(typeof listData.markdown === 'string', 'markdown representation must be present');

    // 3. Call stat
    const statRes = await env.client.callTool({
      name: 'stat',
      arguments: { path: helloPath },
    });
    assertOk(statRes);
    const statData = assertStructured(statRes) as unknown as {
      results: { path: string; value: { size: number; type: string; tokenEstimate?: number } }[];
    };
    assert.equal(statData.results[0]?.value.type, 'file');
    assert.equal(statData.results[0]?.value.size, 11);
    assert.equal(statData.results[0]?.value.tokenEstimate, 3);

    // 4. Call read
    const readRes = await env.client.callTool({
      name: 'read',
      arguments: { path: helloPath },
    });
    assertOk(readRes);
    const readData = assertStructured(readRes) as unknown as {
      results: { path: string; value: { content: string; mimeType: string } }[];
    };
    assert.equal(readData.results[0]?.value.content, 'hello world');
    assert.equal(readData.results[0]?.value.mimeType, 'text/plain');
  });

  it('[SMOKE-002] Create -> read -> edit -> read -> delete lifecycle', async () => {
    const targetPath = env.workspace.path('lifecycle.txt');

    // 1. Create file
    const createRes = await env.client.callTool({
      name: 'create',
      arguments: {
        files: [{ path: targetPath, content: 'alpha\n' }],
      },
    });
    assertOk(createRes);
    const createData = assertStructured(createRes) as unknown as {
      files: { path: string; size: number; resourceUri?: string }[];
    };
    assert.equal(createData.files.length, 1);
    assert.equal(createData.files[0]?.size, 6);
    assert.ok(createData.files[0]?.resourceUri, 'resourceUri should be returned on create');

    // 2. Read back initial content
    const read1 = await env.client.callTool({
      name: 'read',
      arguments: { path: targetPath },
    });
    assertOk(read1);
    const read1Data = assertStructured(read1) as unknown as {
      results: { path: string; value: { content: string } }[];
    };
    assert.equal(read1Data.results[0]?.value.content, 'alpha\n');

    // 3. Edit content
    const editRes = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: targetPath,
        edits: [{ oldText: 'alpha', newText: 'beta' }],
      },
    });
    assertOk(editRes);
    const editData = assertStructured(editRes) as unknown as {
      summary: { failed: number };
      results: { path: string; value?: { appliedEdits: number } }[];
    };
    assert.equal(editData.summary.failed, 0);
    assert.equal(editData.results[0]?.value?.appliedEdits, 1);

    // 4. Read modified content
    const read2 = await env.client.callTool({
      name: 'read',
      arguments: { path: targetPath },
    });
    assertOk(read2);
    const read2Data = assertStructured(read2) as unknown as {
      results: { path: string; value: { content: string } }[];
    };
    assert.equal(read2Data.results[0]?.value.content, 'beta\n');

    // 5. Delete file
    const deleteRes = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [targetPath] },
    });
    assertOk(deleteRes);
    const deleteData = assertStructured(deleteRes) as unknown as {
      ok: boolean;
      path?: string;
    };
    assert.equal(deleteData.ok, true);

    // 6. Read deleted file -> NOT_FOUND in results[0].error
    const read3 = await env.client.callTool({
      name: 'read',
      arguments: { path: targetPath },
    });
    assertOk(read3);
    const read3Data = assertStructured(read3) as unknown as {
      summary: { failed: number; succeeded: number };
      results: { path: string; error?: { code: string } }[];
    };
    assert.equal(read3Data.summary.failed, 1);
    assert.equal(read3Data.results[0]?.error?.code, 'NOT_FOUND');
  });
});
