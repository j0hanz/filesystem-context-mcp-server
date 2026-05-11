/**
 * Integration tests for the unified edit tool: single, paths[], files[].
 */
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createTestEnv, type TestEnv } from '../helpers.js';

describe('edit tool — input validation', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('rejects when none of path/paths/files is provided', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: { edits: [{ oldText: 'a', newText: 'b' }] },
    });
    assert.equal(res.isError, true);
  });

  it('rejects when both path and paths are provided', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: join(env.tmpDir, 'x.txt'),
        paths: [join(env.tmpDir, 'y.txt')],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });

  it('rejects when both path and files are provided', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: join(env.tmpDir, 'x.txt'),
        files: [{ path: join(env.tmpDir, 'y.txt'), edits: [{ oldText: 'a', newText: 'b' }] }],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });

  it('rejects paths[] with more than 5 entries', async () => {
    const paths = Array.from({ length: 6 }, (_, i) => join(env.tmpDir, `f${i}.txt`));
    const res = await env.client.callTool({
      name: 'edit',
      arguments: { paths, edits: [{ oldText: 'a', newText: 'b' }] },
    });
    assert.equal(res.isError, true);
  });

  it('rejects files[] with more than 5 entries', async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: join(env.tmpDir, `f${i}.txt`),
      edits: [{ oldText: 'a', newText: 'b' }],
    }));
    const res = await env.client.callTool({ name: 'edit', arguments: { files } });
    assert.equal(res.isError, true);
  });

  it('rejects paths[] without edits', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: { paths: [join(env.tmpDir, 'x.txt')] },
    });
    assert.equal(res.isError, true);
  });

  it('rejects files[] with top-level edits', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        files: [{ path: join(env.tmpDir, 'x.txt'), edits: [{ oldText: 'a', newText: 'b' }] }],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });

  it('rejects when both paths and files are provided', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        paths: [join(env.tmpDir, 'x.txt')],
        files: [{ path: join(env.tmpDir, 'y.txt'), edits: [{ oldText: 'a', newText: 'b' }] }],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });
});
