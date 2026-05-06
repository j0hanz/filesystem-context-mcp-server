import { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { access, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, it } from 'node:test';
import { pathToFileURL } from 'node:url';

import { LinkedTransport } from './linked-transport.js';

interface DistToolsModule {
  registerAllTools: (
    server: McpServer,
    options: {
      resourceStore: unknown;
      isInitialized: () => boolean;
    }
  ) => void;
}

interface DistPathsModule {
  setAllowedDirectoriesResolved: (dirs: string[]) => Promise<void>;
}

interface DistResourceStoreModule {
  createInMemoryResourceStore: () => unknown;
}

interface DistEnv {
  client: Client;
  tmpDir: string;
  cleanup: () => Promise<void>;
}

function getStructured(result: unknown): Record<string, unknown> {
  const structured = (result as { structuredContent?: unknown })
    .structuredContent;
  assert.ok(
    structured !== undefined && structured !== null,
    'structuredContent must be present'
  );
  return structured as Record<string, unknown>;
}

async function createDistEnv(): Promise<DistEnv> {
  const distToolsUrl = pathToFileURL(resolve('dist/tools.js')).href;
  const distPathsUrl = pathToFileURL(resolve('dist/lib/paths.js')).href;
  const distResourceStoreUrl = pathToFileURL(
    resolve('dist/lib/resource-store.js')
  ).href;

  const [toolsModule, pathsModule, resourceStoreModule] = await Promise.all([
    import(distToolsUrl) as Promise<DistToolsModule>,
    import(distPathsUrl) as Promise<DistPathsModule>,
    import(distResourceStoreUrl) as Promise<DistResourceStoreModule>,
  ]);

  const tmpDir = await mkdtemp(join(tmpdir(), 'fsmcp-dist-'));
  await pathsModule.setAllowedDirectoriesResolved([tmpDir]);

  const server = new McpServer(
    { name: 'dist-test-server', version: '0.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
        completions: {},
      },
    }
  );

  toolsModule.registerAllTools(server, {
    resourceStore: resourceStoreModule.createInMemoryResourceStore(),
    isInitialized: () => true,
  });

  const client = new Client({ name: 'dist-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = LinkedTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    tmpDir,
    cleanup: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await rm(tmpDir, { recursive: true, force: true });
      await pathsModule.setAllowedDirectoriesResolved([]).catch(() => {});
    },
  };
}

describe('dist runtime regressions', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (!cleanup) continue;
      await cleanup();
    }
  });

  it('grep from dist can search files in an allowed root', async (t) => {
    try {
      await access(resolve('dist/tools.js'));
      await access(resolve('dist/lib/paths.js'));
    } catch {
      t.skip('dist runtime not present');
      return;
    }

    const env = await createDistEnv();
    cleanups.push(env.cleanup);

    const filePath = join(env.tmpDir, 'sample.txt');
    await writeFile(filePath, 'alpha\nneedle value\nomega\n', 'utf8');

    const findResult = await env.client.callTool({
      name: 'find',
      arguments: {
        path: env.tmpDir,
        pattern: '*.txt',
      },
    });
    const findStructured = getStructured(findResult);
    assert.equal(findStructured['ok'], true);
    assert.equal(findStructured['totalMatches'], 1);

    const grepResult = await env.client.callTool({
      name: 'grep',
      arguments: {
        path: env.tmpDir,
        pattern: 'needle value',
        filePattern: '*.txt',
      },
    });
    const grepStructured = getStructured(grepResult);
    assert.equal(grepStructured['ok'], true);
    assert.equal(
      grepStructured['totalMatches'],
      1,
      `Expected one grep match, got ${JSON.stringify(grepStructured)}`
    );
    assert.equal(
      grepStructured['skippedInaccessible'] ?? 0,
      0,
      `Expected no inaccessible files, got ${JSON.stringify(grepStructured)}`
    );
  });
});
