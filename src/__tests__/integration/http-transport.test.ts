import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { REQUIRED_MCP_PROTOCOL_VERSION } from '../../lib/constants.js';
import { startHttpServer } from '../../server.js';

function makeInitBody(): string {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: REQUIRED_MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: 'http-transport-test', version: '1.0.0' },
    },
  });
}

function initHeaders(): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
    'MCP-Protocol-Version': REQUIRED_MCP_PROTOCOL_VERSION,
  };
}

await it('HTTP server starts on ephemeral port and closes cleanly', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-http-'));
  const server = await startHttpServer(0, {
    allowCwd: false,
    cliAllowedDirs: [tmpRoot],
  });

  try {
    const address = server.address();
    assert.ok(
      address && typeof address !== 'string',
      'Expected address object'
    );
    assert.ok(address.port > 0, 'Expected non-zero port');

    const endpoint = `http://127.0.0.1:${String(address.port)}/mcp`;
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: initHeaders(),
      body: makeInitBody(),
    });
    assert.strictEqual(res.status, 200);
    assert.ok(
      res.headers.get('mcp-session-id'),
      'Expected mcp-session-id header on initialize'
    );
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

await it('returns 503 when session limit is reached', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-session-'));
  const prevLimit = process.env['FILESYSTEM_MCP_MAX_HTTP_SESSIONS'];
  process.env['FILESYSTEM_MCP_MAX_HTTP_SESSIONS'] = '1';

  const server = await startHttpServer(0, {
    allowCwd: false,
    cliAllowedDirs: [tmpRoot],
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${String(address.port)}/mcp`;

    // First initialize — should succeed and fill the single slot.
    const firstRes = await fetch(endpoint, {
      method: 'POST',
      headers: initHeaders(),
      body: makeInitBody(),
    });
    assert.strictEqual(firstRes.status, 200);
    // Drain body to free connection.
    await firstRes.body?.cancel();

    // Second initialize — should be rejected with 503.
    const secondRes = await fetch(endpoint, {
      method: 'POST',
      headers: initHeaders(),
      body: makeInitBody(),
    });
    assert.strictEqual(secondRes.status, 503);
    const payload = (await secondRes.json()) as {
      error?: { message?: string };
    };
    assert.match(payload.error?.message ?? '', /Too many sessions/i);
  } finally {
    if (prevLimit === undefined) {
      delete process.env['FILESYSTEM_MCP_MAX_HTTP_SESSIONS'];
    } else {
      process.env['FILESYSTEM_MCP_MAX_HTTP_SESSIONS'] = prevLimit;
    }
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});

await it('returns 403 when request origin is not a localhost origin', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-origin-'));
  const server = await startHttpServer(0, {
    allowCwd: false,
    cliAllowedDirs: [tmpRoot],
  });

  try {
    const address = server.address();
    assert.ok(address && typeof address !== 'string');
    const endpoint = `http://127.0.0.1:${String(address.port)}/mcp`;

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        ...initHeaders(),
        Origin: 'https://evil.example.com',
      },
      body: makeInitBody(),
    });
    assert.strictEqual(res.status, 403);
    const payload = (await res.json()) as { error?: { message?: string } };
    assert.match(payload.error?.message ?? '', /Forbidden/i);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
