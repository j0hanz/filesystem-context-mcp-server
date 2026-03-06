import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import { startHttpServer } from '../server/bootstrap.js';

function getServerPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }
  return address.port;
}

function parseSseJsonPayload(rawBody: string): unknown {
  const dataLines = rawBody
    .split(/\r?\n/u)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart());

  assert.ok(
    dataLines.length > 0,
    `Expected SSE response to include at least one data line, got ${JSON.stringify(rawBody)}`
  );

  return JSON.parse(dataLines.join('\n')) as unknown;
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

describe('HTTP transport', () => {
  const servers: Server[] = [];
  let tempDir: string | undefined;

  afterEach(async () => {
    while (servers.length > 0) {
      const server = servers.pop();
      if (!server) continue;
      await closeServer(server);
    }

    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }

    delete process.env['FILESYSTEM_MCP_HTTP_HOST'];
    delete process.env['FILESYSTEM_MCP_API_KEY'];
  });

  it('accepts negotiated supported protocol versions after initialize', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const initResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-06-18',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(
      sessionId,
      'Expected initialize response to include Mcp-Session-Id'
    );

    const initializedResponse = await fetch(
      `http://127.0.0.1:${String(port)}/mcp`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-06-18',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      }
    );

    assert.equal(initializedResponse.status, 202);
  });

  it('accepts the current protocol version (2025-11-25)', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const initResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(
      sessionId,
      'Expected initialize response to include Mcp-Session-Id'
    );

    const initializedResponse = await fetch(
      `http://127.0.0.1:${String(port)}/mcp`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      }
    );

    assert.equal(initializedResponse.status, 202);
  });

  it('rejects post-initialize HTTP requests without mcp-protocol-version', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const initResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(
      sessionId,
      'Expected initialize response to include Mcp-Session-Id'
    );

    const missingHeaderResponse = await fetch(
      `http://127.0.0.1:${String(port)}/mcp`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      }
    );

    assert.equal(missingHeaderResponse.status, 400);
    assert.match(
      await missingHeaderResponse.text(),
      /Missing MCP-Protocol-Version header/
    );
  });

  it('accepts the negotiated server protocol version after fallback', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const initResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 'DRAFT-2026-v1',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(
      sessionId,
      'Expected initialize response to include Mcp-Session-Id'
    );

    const initPayload = parseSseJsonPayload(await initResponse.text()) as {
      result?: { protocolVersion?: string };
    };
    assert.equal(
      initPayload.result?.protocolVersion,
      '2025-11-25',
      `Expected the server to negotiate to its latest supported protocol version, got ${JSON.stringify(initPayload)}`
    );

    const initializedResponse = await fetch(
      `http://127.0.0.1:${String(port)}/mcp`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-11-25',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      }
    );

    assert.equal(initializedResponse.status, 202);
  });

  it('rejects post-initialize requests with a mismatched negotiated protocol version', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const initResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: 'DRAFT-2026-v1',
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(
      sessionId,
      'Expected initialize response to include Mcp-Session-Id'
    );

    const mismatchedHeaderResponse = await fetch(
      `http://127.0.0.1:${String(port)}/mcp`,
      {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-protocol-version': '2025-06-18',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          method: 'notifications/initialized',
        }),
      }
    );

    assert.equal(mismatchedHeaderResponse.status, 400);
    assert.match(
      await mismatchedHeaderResponse.text(),
      /must match negotiated version 2025-11-25/
    );
  });

  it('refuses non-loopback HTTP binding without an API key', async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fsmcp-http-'));
    const dir = tempDir;
    process.env['FILESYSTEM_MCP_HTTP_HOST'] = '0.0.0.0';

    await assert.rejects(
      () => startHttpServer(0, { cliAllowedDirs: [dir] }),
      /Refusing to bind HTTP server to non-loopback host/
    );
  });
});
