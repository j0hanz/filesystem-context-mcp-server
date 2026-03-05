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
