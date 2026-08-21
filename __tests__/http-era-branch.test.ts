// Era-branch guard: one HTTP server serves a 2025 (legacy) client and a
// 2026-07-28 (modern) client at the same time. The era-branch in transport.ts
// routes a POST by isLegacyRequest — a 2025 `initialize` (jsonrpc: '2.0') to the
// sessionful stack, a modern `server/discover` envelope to createMcpHandler
// (legacy: 'reject'). This test proves both legs answer and do not interfere.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { startHttpServer } from '../src/transport.js';

function getServerPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }
  return address.port;
}

async function closeServer(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

describe('HTTP era-branch (2025 legacy + 2026 modern)', () => {
  const servers: Server[] = [];
  const clients: Client[] = [];
  let tempDir: string | undefined;

  afterEach(async () => {
    while (clients.length > 0) {
      const client = clients.pop();
      if (!client) continue;
      await client.close().catch(() => {
        /* transport already gone */
      });
    }
    while (servers.length > 0) {
      const server = servers.pop();
      if (!server) continue;
      await closeServer(server);
    }
    if (tempDir) {
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }
    delete process.env['HTTP_HOST'];
    delete process.env['API_KEY'];
  });

  async function boot(): Promise<{ server: Server; port: number }> {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-era-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    return { server, port: getServerPort(server) };
  }

  it('routes a 2025 client to the legacy sessionful stack', async () => {
    const { port } = await boot();
    // Default versionNegotiation.mode is 'legacy': a plain 2025 `initialize`
    // with jsonrpc: '2.0'. isLegacyRequest classifies it legacy, so the
    // sessionful stack answers and creates a session.
    const client = new Client({ name: 'legacy-era-test', version: '1.0.0' });
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(port)}/mcp`),
    );
    await client.connect(transport);

    assert.equal(client.getProtocolEra(), 'legacy');
    // The legacy stack mints a session id; the modern leg never does.
    assert.ok(transport.sessionId, 'legacy connect should produce an mcp-session-id');

    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, 'legacy client should see registered tools');
  });

  it('routes a 2026 client to the modern per-request leg', async () => {
    const { port } = await boot();
    // mode: 'auto' probes with server/discover, which carries the 2026
    // envelope — isLegacyRequest classifies it modern, so createMcpHandler
    // (legacy: 'reject') answers and negotiates the modern revision.
    const client = new Client(
      { name: 'modern-era-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(port)}/mcp`),
    );
    await client.connect(transport);

    assert.equal(client.getProtocolEra(), 'modern');
    // The modern leg is sessionless — no mcp-session-id is minted.
    assert.equal(transport.sessionId, undefined, 'modern connect should not create a session');

    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, 'modern client should see registered tools');
  });

  it('serves both eras concurrently on one server', async () => {
    const { port } = await boot();

    const legacyClient = new Client({ name: 'concurrent-legacy', version: '1.0.0' });
    clients.push(legacyClient);
    const legacyTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(port)}/mcp`),
    );
    await legacyClient.connect(legacyTransport);

    const modernClient = new Client(
      { name: 'concurrent-modern', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    clients.push(modernClient);
    const modernTransport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(port)}/mcp`),
    );
    await modernClient.connect(modernTransport);

    // Both connected to the same server at once; both must answer.
    assert.equal(legacyClient.getProtocolEra(), 'legacy');
    assert.equal(modernClient.getProtocolEra(), 'modern');

    const [legacyTools, modernTools] = await Promise.all([
      legacyClient.listTools(),
      modernClient.listTools(),
    ]);
    assert.ok(legacyTools.tools.length > 0);
    assert.ok(modernTools.tools.length > 0);
    // Same tool roster on both legs — the shared createServer builder registers
    // the same tools regardless of era.
    assert.deepEqual(
      legacyTools.tools.map((t) => t.name).sort(),
      modernTools.tools.map((t) => t.name).sort(),
    );
  });
});
