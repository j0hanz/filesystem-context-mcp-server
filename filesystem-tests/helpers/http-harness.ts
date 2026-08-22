import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { promisify } from 'node:util';

import type { ServerOptions } from '../../src/core/path.js';
import { startHttpServer } from '../../src/transport.js';
import { DisposableWorkspace } from './workspace.js';

export function getServerPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }
  return address.port;
}

export async function closeHttpServer(server: Server): Promise<void> {
  server.closeAllConnections?.();
  await promisify(server.close.bind(server))();
}

export interface HttpTestEnv {
  server: Server;
  port: number;
  workspace: DisposableWorkspace;
  client: Client;
  transport: StreamableHTTPClientTransport;
  cleanup: () => Promise<void>;
}

export async function createHttpTestEnv(options: ServerOptions = {}): Promise<HttpTestEnv> {
  const workspace = await DisposableWorkspace.create('fsmcp-http-');
  const server = await startHttpServer(0, {
    cliAllowedDirs: [workspace.root],
    ...options,
  });
  const port = getServerPort(server);

  const client = new Client({
    name: 'http-qa-test-client',
    version: '1.0.0',
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(port)}/mcp`),
  );
  await client.connect(transport);

  const cleanup = async (): Promise<void> => {
    try {
      await client.close();
    } catch {
      // ignore
    }
    await closeHttpServer(server);
    await workspace.cleanup();
  };

  return { server, port, workspace, client, transport, cleanup };
}

export async function rawHttpRequest(params: {
  port: number;
  method: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}> {
  const url = `http://127.0.0.1:${String(params.port)}${params.path ?? '/mcp'}`;
  const res = await fetch(url, {
    method: params.method,
    headers: params.headers,
    body: params.body,
  });
  return {
    statusCode: res.status,
    headers: Object.fromEntries(res.headers.entries()),
    body: await res.text(),
  };
}

export function parseSseJsonPayload(rawBody: string): unknown {
  const dataLines = rawBody
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  assert.ok(
    dataLines.length > 0,
    `Expected SSE response to include at least one data line, got ${JSON.stringify(rawBody)}`,
  );

  return JSON.parse(dataLines.join('\n')) as unknown;
}
