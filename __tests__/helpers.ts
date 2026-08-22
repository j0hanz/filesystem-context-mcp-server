import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, InMemoryServerEventBus } from '@modelcontextprotocol/server';

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { createWatcherRegistry } from '../src/resources.js';
import { createServer } from '../src/server.js';
import type { FilesystemServerContext } from '../src/server.js';

/** Create an isolated temp directory for a test. */
export async function createTestRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'fsmcp-test-'));
}

/** Remove a test root directory. */
export async function cleanupTestRoot(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

/** Create an MCP server context pointed at the given allowed dirs. */
export async function createTestServer(
  allowedDirs: string[],
  options: { readOnly?: boolean } = {},
): Promise<FilesystemServerContext> {
  return createServer({
    cliAllowedDirs: allowedDirs,
    ...(options.readOnly ? { readOnly: true } : {}),
  });
}

export interface TestClientContext {
  client: Client;
  serverCtx: FilesystemServerContext;
  close: () => Promise<void>;
}

/** Create an in-memory client-server linked pair (zero-mocking direct pairing). */
export async function createTestClientPair(
  allowedDirs: string[],
  options: { readOnly?: boolean } = {},
): Promise<TestClientContext> {
  const serverCtx = await createTestServer(allowedDirs, options);
  serverCtx.synchronizer.registerHandlers(serverCtx.mcp);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  const client = new Client(
    { name: 'test-harness', version: '1.0.0' },
    { capabilities: { roots: { listChanged: true } } },
  );

  await Promise.all([client.connect(clientTransport), serverCtx.mcp.connect(serverTransport)]);

  return {
    client,
    serverCtx,
    close: async () => {
      await client.close();
      await serverCtx.close();
    },
  };
}

export interface TestHttpContext {
  client: Client;
  handler: ReturnType<typeof createMcpHandler>;
  close: () => Promise<void>;
}

/** Create an in-process HTTP client/handler harness via createMcpHandler's handler.fetch. */
export async function createTestHttpHarness(
  allowedDirs: string[],
  options: { readOnly?: boolean } = {},
): Promise<TestHttpContext> {
  const bus = new InMemoryServerEventBus();
  const sharedRegistry = createWatcherRegistry();

  const handler = createMcpHandler(
    async () => {
      const serverCtx = await createServer(
        {
          cliAllowedDirs: allowedDirs,
          ...(options.readOnly ? { readOnly: true } : {}),
        },
        {
          watcherRegistry: sharedRegistry,
          notifyResourceUpdated: (uri) => bus.publish({ kind: 'resource_updated', uri }),
        },
      );
      serverCtx.synchronizer.markInitialized();
      return serverCtx.mcp;
    },
    { bus },
  );

  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });

  const client = new Client(
    { name: 'http-test-harness', version: '1.0.0' },
    { versionNegotiation: { mode: 'auto' } },
  );

  await client.connect(transport);

  return {
    client,
    handler,
    close: async () => {
      await client.close();
      await handler.close();
      sharedRegistry.destroy();
    },
  };
}

/** Write a text file into the test root. */
export async function writeTestFile(
  root: string,
  relativePath: string,
  content: string,
): Promise<string> {
  const fullPath = join(root, relativePath);
  await mkdir(dirname(fullPath), { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
  return fullPath;
}

/** Generate a file with N lines. */
export async function writeNLineFile(
  root: string,
  name: string,
  lineCount: number,
): Promise<string> {
  const lines = Array.from({ length: lineCount }, (_, i) => `Line ${i + 1}`);
  return writeTestFile(root, name, lines.join('\n') + '\n');
}
