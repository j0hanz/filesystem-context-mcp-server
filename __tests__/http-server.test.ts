import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ALL_REGISTERED_TOOL_NAMES } from '../src/tools/index.js';
import { startHttpServer } from '../src/transport.js';
import { cleanupTestRoot, createTestRoot, firstTextBlock, writeTestFile } from './helpers.js';

describe('Real HTTP Server integration', () => {
  let tmpDir: string;
  let httpServer: Server;
  let base: URL;
  let port: number;

  beforeEach(async () => {
    tmpDir = await createTestRoot();
    process.env['API_KEY'] = 'x-test-key-0123456789';
    process.env['HTTP_HOST'] = '127.0.0.1';
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    port = (httpServer.address() as AddressInfo).port;
    base = new URL(`http://127.0.0.1:${port}/mcp`);
  });

  afterEach(async () => {
    delete process.env['API_KEY'];
    delete process.env['HTTP_HOST'];
    await new Promise<void>((resolve) => {
      httpServer.close(resolve);
    });
    await cleanupTestRoot(tmpDir);
  });

  it('1. /healthz is open and reports ok', async () => {
    const r = await fetch(new URL(`http://127.0.0.1:${port}/healthz`));
    assert.strictEqual(r.status, 200);
    const body = (await r.json()) as { status: string };
    assert.strictEqual(body.status, 'ok');
  });

  it('2. POST /mcp without Authorization -> 401', async () => {
    const r = await fetch(base, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(r.status, 401);
  });

  it('3. Full MCP handshake + tool call over real HTTP with bearer', async () => {
    const transport = new StreamableHTTPClientTransport(base, {
      fetch: (url, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', 'Bearer x-test-key-0123456789');
        return fetch(url, { ...init, headers });
      },
    });
    const client = new Client(
      { name: 'http-server-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      assert.strictEqual(tools.tools.length, ALL_REGISTERED_TOOL_NAMES.length);

      const file = await writeTestFile(tmpDir, 'real.txt', 'real-http-body');
      const res = await client.callTool({ name: 'read', arguments: { path: file } });
      assert.notStrictEqual(res.isError, true);
      const block = firstTextBlock(res);
      assert.ok(block.text?.includes('real-http-body'));
    } finally {
      await client.close();
    }
  });

  it('4. Era-branch routes a 2025-era initialize to the legacy sessionful stack', async () => {
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: 'Bearer x-test-key-0123456789',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'legacy-probe', version: '1.0.0' },
        },
      }),
    });
    assert.strictEqual(r.status, 200);
    assert.ok(r.headers.get('mcp-session-id'), 'legacy leg must return a session id');
  });
});
