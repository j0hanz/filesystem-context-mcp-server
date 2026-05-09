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
    isInitialized: () => true,
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

function expectText(message: { content: { type: string } }): asserts message is {
  content: { type: 'text'; text: string };
} {
  assert.equal(message.content.type, 'text');
}

function expectLink(message: { content: { type: string } }): asserts message is {
  content: { type: 'resource_link'; uri: string };
} {
  assert.equal(message.content.type, 'resource_link');
}

describe('prompts', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('lists all 5 prompts', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.listPrompts();
    const names = result.prompts.map((p) => p.name).sort();
    assert.deepEqual(names, [
      'analyze-path',
      'compare-files',
      'find-in-tree',
      'get-help',
      'summarize-directory',
    ]);
  });

  it('get-help returns full instructions when no topic', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({ name: 'get-help', arguments: {} });
    assert.equal(result.messages.length, 1);
    const [message] = result.messages;
    assert.ok(message);
    expectText(message);
    assert.match(message.content.text, /Guidelines:/u);
    assert.match(message.content.text, /Constraints:/u);
  });

  it('get-help filters to a known topic', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'get-help',
      arguments: { topic: 'constraints' },
    });
    const [message] = result.messages;
    assert.ok(message);
    expectText(message);
    assert.match(message.content.text, /Constraints:/u);
    assert.doesNotMatch(message.content.text, /Error Recovery:/u);
  });

  it('analyze-path on a file returns text + path link + instructions link', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const filePath = join(env.tempDir, 'sample.txt');
    await writeFile(filePath, 'hello\n', 'utf8');
    const result = await env.client.getPrompt({
      name: 'analyze-path',
      arguments: { path: filePath },
    });
    assert.equal(result.messages.length, 3);
    const [m0, m1, m2] = result.messages;
    assert.ok(m0 && m1 && m2);
    expectText(m0);
    assert.match(m0.content.text, /Analyze this file:/u);
    expectLink(m1);
    assert.equal(m1.content.uri.toLowerCase(), `file://${filePath}`.toLowerCase());
    expectLink(m2);
    assert.equal(m2.content.uri, 'internal://instructions');
  });

  it('analyze-path on a directory adapts the task statement', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'analyze-path',
      arguments: { path: env.tempDir },
    });
    const [m0] = result.messages;
    assert.ok(m0);
    expectText(m0);
    assert.match(m0.content.text, /Analyze this directory:/u);
  });

  it('compare-files returns text + 2 path links', async () => {
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
    assert.equal(result.messages.length, 3);
    const [m0, m1, m2] = result.messages;
    assert.ok(m0 && m1 && m2);
    expectText(m0);
    assert.match(m0.content.text, /Call `diff_files`/u);
    assert.match(m0.content.text, /- original: /u);
    assert.match(m0.content.text, /- modified: /u);
    expectLink(m1);
    assert.equal(m1.content.uri.toLowerCase(), `file://${original}`.toLowerCase());
    expectLink(m2);
    assert.equal(m2.content.uri.toLowerCase(), `file://${modified}`.toLowerCase());
  });

  it('find-in-tree defaults root to first allowed dir and includes both modes', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'find-in-tree',
      arguments: { query: 'foo' },
    });
    assert.equal(result.messages.length, 2);
    const [m0, m1] = result.messages;
    assert.ok(m0 && m1);
    expectText(m0);
    assert.match(m0.content.text, /Call `find`/u);
    assert.match(m0.content.text, /Call `grep`/u);
    expectLink(m1);
    assert.equal(m1.content.uri, 'internal://instructions');
  });

  it('find-in-tree mode=name omits grep', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'find-in-tree',
      arguments: { query: 'foo', mode: 'name' },
    });
    const [m0] = result.messages;
    assert.ok(m0);
    expectText(m0);
    assert.match(m0.content.text, /Call `find`/u);
    assert.doesNotMatch(m0.content.text, /Call `grep`/u);
  });

  it('summarize-directory returns text + path link', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'summarize-directory',
      arguments: { path: env.tempDir },
    });
    assert.equal(result.messages.length, 2);
    const [m0, m1] = result.messages;
    assert.ok(m0 && m1);
    expectText(m0);
    assert.match(m0.content.text, /Summarize this project/u);
    assert.match(m0.content.text, /maxDepth=3/u);
    expectLink(m1);
    assert.equal(m1.content.uri.toLowerCase(), `file://${env.tempDir}`.toLowerCase());
  });

  it('summarize-directory honors custom depth', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'summarize-directory',
      arguments: { path: env.tempDir, depth: '5' },
    });
    const [m0] = result.messages;
    assert.ok(m0);
    expectText(m0);
    assert.match(m0.content.text, /maxDepth=5/u);
  });

  it('analyze-path rejects a path outside allowed roots', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    await assert.rejects(
      env.client.getPrompt({
        name: 'analyze-path',
        arguments: { path: '/definitely/not/allowed' },
      }),
    );
  });
});
