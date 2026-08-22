import { Client } from '@modelcontextprotocol/client';
import type { ElicitResult } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import type { ServerOptions } from '../../src/core/path.js';
import type { FilesystemServerContext } from '../../src/server.js';
import { createServer } from '../../src/server.js';
import { DisposableWorkspace } from './workspace.js';

export interface TestEnv {
  client: Client;
  serverContext: FilesystemServerContext;
  workspace: DisposableWorkspace;
  cleanup: () => Promise<void>;
}

export interface CreateTestEnvOptions {
  serverOptions?: ServerOptions;
  clientCapabilities?: Record<string, unknown>;
  initialTree?: Record<string, string | Buffer>;
}

export type ElicitationHandler = (params: {
  mode: string;
  message: string;
  requestedSchema: unknown;
}) => Promise<ElicitResult>;

/**
 * Creates an in-process MCP test environment using InMemoryTransport.
 * Spawns a dedicated DisposableWorkspace root, initializes full server registrars,
 * and pairs the client and server directly.
 */
export async function createTestEnv(options: CreateTestEnvOptions = {}): Promise<TestEnv> {
  const workspace = await DisposableWorkspace.create();

  if (options.initialTree) {
    await workspace.populate(options.initialTree);
  }

  const serverContext = await createServer({
    allowedDirectories: [workspace.root],
    ...options.serverOptions,
  });

  serverContext.synchronizer.registerHandlers(serverContext.mcp);

  const client = new Client(
    { name: 'filesystem-test-client', version: '1.0.0' },
    {
      capabilities: {
        roots: { listChanged: true },
        ...options.clientCapabilities,
      },
    },
  );

  const rootUri = `file:///${workspace.normalizedRoot.replace(/^\/+/u, '')}`;
  client.setRequestHandler('roots/list', () => ({
    roots: [{ uri: rootUri, name: 'workspace' }],
  }));

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([serverContext.mcp.connect(serverTransport), client.connect(clientTransport)]);

  // Await async roots negotiation to populate allowedDirectories
  let attempts = 100;
  while (serverContext.pathGuard.getAllowedDirectories().length === 0 && attempts > 0) {
    await new Promise((resolve) => setTimeout(resolve, 5));
    attempts--;
  }

  if (serverContext.pathGuard.getAllowedDirectories().length === 0) {
    await serverContext.pathGuard.setRoots([workspace.root]);
  }

  const cleanup = async (): Promise<void> => {
    await Promise.allSettled([
      client.close().catch(() => {}),
      serverContext.close().catch(() => {}),
      workspace.cleanup(),
    ]);
  };

  return { client, serverContext, workspace, cleanup };
}

/**
 * Creates a test environment where the MCP client advertises elicitation capability
 * and routes server-initiated elicitation/create requests to the specified handler.
 */
export async function createElicitationTestEnv(
  handler: ElicitationHandler,
  options: CreateTestEnvOptions = {},
): Promise<TestEnv> {
  const env = await createTestEnv({
    ...options,
    clientCapabilities: {
      elicitation: {},
      ...options.clientCapabilities,
    },
  });

  env.client.setRequestHandler('elicitation/create', (request) =>
    handler(
      request.params as {
        mode: string;
        message: string;
        requestedSchema: unknown;
      },
    ),
  );

  return env;
}
