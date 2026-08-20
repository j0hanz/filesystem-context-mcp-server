import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.js';
import { normalizePath } from '../src/core/path.js';

interface PromptStdIoEnv {
  client: Client;
  tempDir: string;
  cleanup: () => Promise<void>;
}

async function createPromptStdIoEnv(
  setup?: (tempDir: string) => Promise<void>,
): Promise<PromptStdIoEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-prompts-stdio-'));
  if (setup) {
    await setup(tempDir);
  }
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [resolve('dist/index.js'), tempDir],
    cwd: resolve('.'),
    stderr: 'pipe',
  });
  const client = new Client({
    name: 'prompt-stdio-test-client',
    version: '1.0.0',
  });

  await client.connect(transport);

  return {
    client,
    tempDir,
    cleanup: async () => {
      await client.close().catch(() => {});
      await transport.close().catch(() => {});
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe('prompts over stdio transport', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (!cleanup) continue;
      await cleanup();
    }
  });

  it('returns analyze-path with required args over stdio transport', async (t) => {
    try {
      await access(resolve('dist/index.js'));
    } catch {
      t.skip('dist runtime not present');
      return;
    }

    const env = await createPromptStdIoEnv(async (tempDir) => {
      await writeFile(join(tempDir, 'sample.txt'), 'hello\n', 'utf8');
    });
    cleanups.push(env.cleanup);

    const filePath = join(env.tempDir, 'sample.txt');

    const result = await env.client.getPrompt({
      name: 'analyze-path',
      arguments: { path: filePath },
    });

    assert.equal(result.messages.length, 3);
    const [m0, m1, m2] = result.messages;
    assert.ok(m0 && m1 && m2);
    assert.equal(m0.content.type, 'text');
    assert.match(m0.content.text, /Analyze this file:/u);
    assert.match(m0.content.text, /sample\.txt/u);
    assert.equal(m1.content.type, 'resource_link');
    assert.strictEqual(m1.content.uri, buildFileResourceUri(normalizePath(filePath)));
    assert.equal(m2.content.type, 'resource_link');
    assert.equal(m2.content.uri, 'internal://instructions');
  });

  it('returns find-in-tree with required args over stdio transport', async (t) => {
    try {
      await access(resolve('dist/index.js'));
    } catch {
      t.skip('dist runtime not present');
      return;
    }
    const env = await createPromptStdIoEnv();
    cleanups.push(env.cleanup);

    const result = await env.client.getPrompt({
      name: 'find-in-tree',
      arguments: { query: 'needle' },
    });
    assert.equal(result.messages.length, 2);
    const [m0, m1] = result.messages;
    assert.ok(m0 && m1);
    assert.equal(m0.content.type, 'text');
    assert.match(m0.content.text, /Call `find_files`/u);
    assert.equal(m1.content.type, 'resource_link');
    assert.equal(m1.content.uri, 'internal://instructions');
  });
});
