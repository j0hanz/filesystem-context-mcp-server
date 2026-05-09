import { Client, StdioClientTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';

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

    assert.equal(result.messages.length, 1);
    const [message] = result.messages;
    assert.ok(message);
    assert.equal(message.content.type, 'text');
    assert.match(message.content.text, /Analyze the path:/u);
    assert.match(message.content.text, /sample\.txt/u);
  });
});
