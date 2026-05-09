import { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { describe, it } from 'node:test';

import { normalizePath, PathGuard } from '../../src/lib/path-guard.js';
import { createInMemoryResourceStore } from '../../src/lib/resource-store.js';
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
} from '../../src/prompts.js';
import { registerAllResources, serverInstructionsContent } from '../../src/resources.js';
import { LinkedTransport } from '../linked-transport.js';

function makeCompletionServer(withInstructions = false, pathGuard?: PathGuard): McpServer {
  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { completions: {} } },
  );
  const instructions = withInstructions ? serverInstructionsContent : '';
  registerGetHelpPrompt(server, instructions);
  if (pathGuard) {
    registerAnalyzePathPrompt(server, pathGuard);
    registerCompareFilesPrompt(server, pathGuard);
  }

  const resourceStore = createInMemoryResourceStore();

  registerAllResources(server, { resourceStore });
  return server;
}

async function connectPair(
  server: McpServer,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = LinkedTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

describe('completions', () => {
  it('does not reuse stale path suggestions for a different prefix inside the rate limit window', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`));
    await writeFile(join(tmpDir, 'alpha.txt'), 'alpha', 'utf8');
    await writeFile(join(tmpDir, 'beta.txt'), 'beta', 'utf8');
    const pathGuard = await PathGuard.fromAllowedDirectories([tmpDir]);

    const server = makeCompletionServer(false, pathGuard);
    const { client, cleanup } = await connectPair(server);

    try {
      const first = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: join(tmpDir, 'a') },
      });
      const second = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: join(tmpDir, 'b') },
      });

      assert.ok(
        first.completion.values.some((v) => v.endsWith('alpha.txt')),
        'first should include alpha.txt',
      );
      assert.ok(
        second.completion.values.some((v) => v.endsWith('beta.txt')),
        'second should include beta.txt',
      );
      assert.ok(
        !second.completion.values.some((v) => v.endsWith('alpha.txt')),
        'second should not include alpha.txt',
      );
    } finally {
      await cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not collide cache keys when context values contain delimiter characters', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`));
    const fooDir = join(tmpDir, 'foo');
    await mkdir(fooDir);
    await writeFile(join(fooDir, 'inside.txt'), 'inside', 'utf8');
    const pathGuard = await PathGuard.fromAllowedDirectories([tmpDir]);

    const server = makeCompletionServer(false, pathGuard);
    const { client, cleanup } = await connectPair(server);

    try {
      // context cwd=fooDir → resolves inside fooDir → finds inside.txt
      const fromContextDirectory = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: '' },
        context: { arguments: { cwd: fooDir } },
      });
      // context key looks like a combined value — resolves to rootDir
      const withoutContextDirectory = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: '' },
        context: { arguments: { [`cwd&inside=${fooDir}`]: '1' } },
      });

      assert.ok(
        fromContextDirectory.completion.values.some((v) => v.endsWith('inside.txt')),
        'context cwd should resolve to fooDir',
      );
      assert.deepEqual(
        withoutContextDirectory.completion.values.map(normalizePath),
        [normalizePath(tmpDir)],
        'mangled context key should fall back to root',
      );
    } finally {
      await cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('does not enumerate completion entries through a linked directory outside allowed roots', async () => {
    const tmpDir = await mkdtemp(join(tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`));
    const allowedDir = join(tmpDir, 'allowed');
    const outsideDir = join(tmpDir, 'outside');
    const linkedDir = join(allowedDir, 'linked');
    await mkdir(allowedDir);
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf8');
    await symlink(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    const pathGuard = await PathGuard.fromAllowedDirectories([allowedDir]);

    const server = makeCompletionServer(false, pathGuard);
    const { client, cleanup } = await connectPair(server);

    try {
      const direct = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: `${linkedDir}${sep}` },
      });
      const fromContext = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: '' },
        context: { arguments: { cwd: linkedDir } },
      });

      assert.ok(
        !direct.completion.values.some((v) => v.endsWith('secret.txt')),
        'symlink direct should not expose secret.txt',
      );
      assert.ok(
        !fromContext.completion.values.some((v) => v.endsWith('secret.txt')),
        'symlink via context should not expose secret.txt',
      );
    } finally {
      await cleanup();
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('completes topic sections for the get-help prompt', async () => {
    const server = makeCompletionServer(true);
    const { client, cleanup } = await connectPair(server);

    try {
      const all = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'topic', value: '' },
      });
      const filtered = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'topic', value: 'er' },
      });

      assert.ok(all.completion.values.length > 0, 'should return at least one topic');
      assert.ok(
        filtered.completion.values.every((v) => v.startsWith('er')),
        'filtered topics should all start with "er"',
      );
    } finally {
      await cleanup();
    }
  });

  it('returns empty completions for arg names not declared by the prompt', async () => {
    const server = makeCompletionServer();
    const { client, cleanup } = await connectPair(server);

    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: 'x' },
      });

      assert.deepEqual(
        result.completion.values,
        [],
        'get-help has no path arg — must return empty',
      );
    } finally {
      await cleanup();
    }
  });
});
