import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { startHttpServer } from '../src/server/bootstrap.js';

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

async function rawHttpRequest(params: {
  port: number;
  method: string;
  path?: string;
  headers?: Record<string, string>;
  body?: string;
}): Promise<{
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: params.port,
        method: params.method,
        path: params.path ?? '/mcp',
        headers: params.headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.from(chunk));
        });
        res.on('error', reject);
        res.on('end', () => {
          const totalLength = chunks.reduce(
            (acc, chunk) => acc + chunk.length,
            0
          );
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks, totalLength).toString('utf8'),
          });
        });
      }
    );
    req.on('error', reject);
    if (params.body) {
      req.write(params.body);
    }
    req.end();
  });
}

async function createHttpClient(port: number): Promise<{
  client: Client;
  transport: StreamableHTTPClientTransport;
}> {
  const client = new Client({
    name: 'http-transport-test',
    version: '1.0.0',
  });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(port)}/mcp`)
  );
  await client.connect(transport);
  return { client, transport };
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
      await rm(tempDir, { recursive: true, force: true });
      tempDir = undefined;
    }

    delete process.env['FILESYSTEM_MCP_HTTP_HOST'];
    delete process.env['FILESYSTEM_MCP_API_KEY'];
    delete process.env['FS_INIT_HANDSHAKE_TIMEOUT_MS'];
  });

  it('accepts negotiated supported protocol versions after initialize', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
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
    const initPayload = parseSseJsonPayload(await initResponse.text()) as {
      result?: {
        protocolVersion?: string;
        serverInfo?: { name?: string; version?: string };
        instructions?: string;
        capabilities?: Record<string, unknown>;
      };
    };
    assert.equal(initPayload.result?.protocolVersion, '2025-06-18');
    assert.equal(initPayload.result?.serverInfo?.name, 'filesystem-mcp');
    assert.ok(initPayload.result?.serverInfo?.version);
    assert.match(initPayload.result?.instructions ?? '', /Start with:/u);
    assert.ok(initPayload.result?.capabilities?.['tools']);
    assert.ok(initPayload.result?.capabilities?.['resources']);
    assert.ok(initPayload.result?.capabilities?.['prompts']);
    assert.ok(initPayload.result?.capabilities?.['completions']);
    assert.ok(initPayload.result?.capabilities?.['tasks']);
    assert.ok(initPayload.result?.capabilities?.['logging']);

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
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
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

  it('accepts post-initialize HTTP requests without mcp-protocol-version header', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
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

    // SDK v2 transport accepts requests without MCP-Protocol-Version header,
    // defaulting to the version negotiated at initialization.
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

    assert.equal(missingHeaderResponse.status, 202);
  });

  it('accepts the negotiated server protocol version after fallback', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
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

  it('accepts post-initialize requests with any supported protocol version', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
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

    // SDK v2 transport accepts any supported protocol version on subsequent
    // requests, not just the one negotiated at initialization.
    const otherSupportedVersionResponse = await fetch(
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

    assert.equal(otherSupportedVersionResponse.status, 202);
  });

  it('rejects browser origins outside localhost', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        origin: 'https://example.com',
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

    assert.equal(response.status, 403);
    assert.match(await response.text(), /Forbidden: disallowed origin/u);
  });

  it('rejects loopback requests with a disallowed Host header', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const response = await rawHttpRequest({
      port,
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'evil.test',
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

    assert.equal(response.statusCode, 403);
    assert.match(response.body, /Invalid Host/u);
  });

  it('returns 405 for unsupported HTTP methods on /mcp', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const response = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'PUT',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    assert.equal(response.status, 405);
    assert.equal(response.headers.get('allow'), 'GET, POST, DELETE, OPTIONS');

    const payload = JSON.parse(await response.text()) as {
      error?: { message?: string };
    };
    assert.equal(payload.error?.message, 'Method Not Allowed');
  });

  it('refuses non-loopback HTTP binding without an API key', async () => {
    // Smoke-only: full policy matrix is unit-tested in
    // `__tests__/unit/http-auth-guard.test.ts`.
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const dir = tempDir;
    process.env['FILESYSTEM_MCP_HTTP_HOST'] = '0.0.0.0';

    await assert.rejects(
      () => startHttpServer(0, { cliAllowedDirs: [dir] }),
      /Refusing to bind HTTP server to non-loopback host/
    );
  });

  it('supports discovery and session termination through the real v2 HTTP client transport', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const { client, transport } = await createHttpClient(port);

    try {
      const instructions = client.getInstructions();
      assert.ok(instructions);
      assert.match(instructions, /internal:\/\/instructions/u);

      const { tools } = await client.listTools();
      const { resources } = await client.listResources();
      const { resourceTemplates } = await client.listResourceTemplates();
      const { prompts } = await client.listPrompts();

      assert.equal(tools.length, 18);
      assert.equal(resources.length, 1);
      assert.equal(resources[0]?.uri, 'internal://instructions');
      assert.deepEqual(
        resourceTemplates.map((template) => template.uriTemplate).sort(),
        ['filesystem-mcp://file/{+path}', 'filesystem-mcp://result/{id}']
      );
      assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), [
        'analyze-path',
        'compare-files',
        'get-help',
      ]);
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
  });

  it('evicts stale uninitialized sessions through the full cleanup path', async () => {
    // Smoke-only: full sweep semantics tested in
    // `__tests__/unit/http-session-registry.test.ts`. This case exists to
    // confirm the timer is wired into startHttpServer's lifecycle.
    process.env['FS_INIT_HANDSHAKE_TIMEOUT_MS'] = '1000';
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
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

    await new Promise((resolve) => setTimeout(resolve, 2200));

    const followUpResponse = await fetch(
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

    assert.equal(followUpResponse.status, 404);
    assert.match(await followUpResponse.text(), /Session not found/u);
  });

  it('sets headersTimeout, requestTimeout, and keepAliveTimeout for Slowloris protection', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const s = server as import('node:http').Server & {
      headersTimeout: number;
      requestTimeout: number;
      keepAliveTimeout: number;
    };
    assert.equal(s.headersTimeout, 10_000, 'headersTimeout must be 10s');
    assert.equal(s.requestTimeout, 30_000, 'requestTimeout must be 30s');
    assert.equal(s.keepAliveTimeout, 5_000, 'keepAliveTimeout must be 5s');
  });

  it('does not crash on post-startup HTTP server errors', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const listenerCount = server.listenerCount('error');
    assert.ok(
      listenerCount >= 1,
      `Expected at least one persistent error listener, got ${listenerCount}`
    );
  });

  it('returns 413 for request bodies exceeding the size limit', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    const bigBody = 'x'.repeat(5 * 1024 * 1024);
    const response = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: bigBody,
    });

    assert.equal(response.statusCode, 413);
    const parsed = JSON.parse(response.body) as {
      error?: { message?: string };
    };
    assert.match(parsed.error?.message ?? '', /too large/iu);
  });

  it('returns 204 No Content for OPTIONS preflight requests on /mcp', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    const response = await rawHttpRequest({
      port,
      method: 'OPTIONS',
      path: '/mcp',
      headers: { origin: 'http://localhost:3000' },
    });

    assert.equal(response.statusCode, 204);
    assert.match(
      String(response.headers['access-control-allow-methods'] ?? ''),
      /OPTIONS/iu
    );
  });

  it('returns 400 for non-object/array JSON primitives when strict parser is used', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    const response = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: '"just a string"',
    });

    assert.equal(response.statusCode, 400);
    const parsed = JSON.parse(response.body) as {
      error?: { message?: string };
    };
    assert.match(parsed.error?.message ?? '', /Invalid JSON/iu);
  });
});
