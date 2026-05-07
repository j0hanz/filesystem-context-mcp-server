import { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createServer } from '../src/server.js';
import { LinkedTransport } from './linked-transport.js';

interface PromptEnv {
  client: Client;
  tempDir: string;
  cleanup: () => Promise<void>;
}

async function createPromptEnv(): Promise<PromptEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-prompts-'));
  const { server } = await createServer({
    cliAllowedDirs: [tempDir],
  });
  const client = new Client({ name: 'prompt-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = LinkedTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    tempDir,
    cleanup: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe('prompts', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (!cleanup) continue;
      await cleanup();
    }
  });

  it('lists the expected prompt names', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);

    const result = await env.client.listPrompts();
    const names = result.prompts.map((prompt) => prompt.name).sort();

    assert.deepEqual(names, ['analyze-path', 'compare-files', 'get-help']);
  });

  it('returns analyze-path with required args', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);

    const filePath = join(env.tempDir, 'sample.txt');
    await writeFile(filePath, 'hello\n', 'utf8');

    const result = await env.client.getPrompt({
      name: 'analyze-path',
      arguments: { path: filePath },
    });

    assert.equal(
      result.description,
      'Generate a workflow for analyzing a file or directory using stat, read, and tree.'
    );
    assert.equal(result.messages.length, 1);
    const [message] = result.messages;
    assert.ok(message);
    assert.equal(message.content.type, 'text');
    assert.match(message.content.text, /Analyze the path:/u);
    assert.match(message.content.text, /sample\.txt/u);
  });

  it('returns compare-files with required args', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);

    const original = join(env.tempDir, 'original.txt');
    const modified = join(env.tempDir, 'modified.txt');
    await writeFile(original, 'before\n', 'utf8');
    await writeFile(modified, 'after\n', 'utf8');

    const result = await env.client.getPrompt({
      name: 'compare-files',
      arguments: { original, modified },
    });

    assert.equal(result.messages.length, 1);
    const [message] = result.messages;
    assert.ok(message);
    assert.equal(message.content.type, 'text');
    assert.match(message.content.text, /Call `diff_files`/u);
    assert.match(message.content.text, /original\.txt/u);
    assert.match(message.content.text, /modified\.txt/u);
  });
});
