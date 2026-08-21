import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  LATEST_PROTOCOL_VERSION,
  ProtocolErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { Logger } from '../src/core/observability.js';
import { startHttpServer } from '../src/transport.js';

// A supported protocol version other than the latest, for negotiation tests.
const OLDER_SUPPORTED_PROTOCOL_VERSION =
  SUPPORTED_PROTOCOL_VERSIONS.find((v) => v !== LATEST_PROTOCOL_VERSION) ?? LATEST_PROTOCOL_VERSION;

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
    `Expected SSE response to include at least one data line, got ${JSON.stringify(rawBody)}`,
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
          chunks.push(chunk);
        });
        res.on('error', reject);
        res.on('end', () => {
          const totalLength = chunks.reduce((acc, chunk) => acc + chunk.length, 0);
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks, totalLength).toString('utf8'),
          });
        });
      },
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
    new URL(`http://127.0.0.1:${String(port)}/mcp`),
  );
  await client.connect(transport);
  return { client, transport };
}

function mcpPost(port: number, body: unknown, sessionId?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${String(port)}/mcp`, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
      ...(sessionId ? { 'mcp-session-id': sessionId } : {}),
    },
    body: JSON.stringify(body),
  });
}

function initializeRequest(clientName: string): Record<string, unknown> {
  return {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: LATEST_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: '1.0.0' },
    },
  };
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

    delete process.env['HTTP_HOST'];
    delete process.env['API_KEY'];
    delete process.env['FS_INIT_HANDSHAKE_TIMEOUT_MS'];
    delete process.env['FILESYSTEM_MCP_SESSION_IDLE_TIMEOUT_MS'];
    delete process.env['FILESYSTEM_MCP_PUBLIC_URL'];
    delete process.env['FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS'];
    delete process.env['FILESYSTEM_MCP_ALLOWED_HOSTS'];
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
          protocolVersion: OLDER_SUPPORTED_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Expected initialize response to include Mcp-Session-Id');
    const initPayload = parseSseJsonPayload(await initResponse.text()) as {
      result?: {
        protocolVersion?: string;
        serverInfo?: { name?: string; version?: string };
        instructions?: string;
        capabilities?: Record<string, unknown>;
      };
    };
    assert.equal(initPayload.result?.protocolVersion, OLDER_SUPPORTED_PROTOCOL_VERSION);
    assert.equal(initPayload.result?.serverInfo?.name, 'filesystem-mcp');
    assert.ok(initPayload.result?.serverInfo?.version);
    assert.match(initPayload.result?.instructions ?? '', /Start with:/u);
    assert.ok(initPayload.result?.capabilities?.['tools']);
    assert.ok(initPayload.result?.capabilities?.['resources']);
    assert.ok(initPayload.result?.capabilities?.['prompts']);
    assert.ok(initPayload.result?.capabilities?.['completions']);
    // `logging` is deliberately not advertised — see createServer().
    assert.equal(initPayload.result?.capabilities?.['logging'], undefined);

    const initializedResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': OLDER_SUPPORTED_PROTOCOL_VERSION,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    assert.equal(initializedResponse.status, 202);
  });

  it('returns health status on GET /healthz without authentication', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    process.env['API_KEY'] = '1234567890abcdef123456';
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const response = await fetch(`http://127.0.0.1:${String(port)}/healthz`);
    assert.equal(response.status, 200);
    const data = (await response.json()) as { status: string; uptime: number; sessions: number };
    assert.equal(data.status, 'ok');
    assert.equal(typeof data.uptime, 'number');
    assert.equal(data.sessions, 0);
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
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Expected initialize response to include Mcp-Session-Id');

    const initializedResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

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
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Expected initialize response to include Mcp-Session-Id');

    // SDK v2 transport accepts requests without MCP-Protocol-Version header,
    // defaulting to the version negotiated at initialization.
    const missingHeaderResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
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
    });

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
    assert.ok(sessionId, 'Expected initialize response to include Mcp-Session-Id');

    const initPayload = parseSseJsonPayload(await initResponse.text()) as {
      result?: { protocolVersion?: string };
    };
    assert.equal(
      initPayload.result?.protocolVersion,
      LATEST_PROTOCOL_VERSION,
      `Expected the server to negotiate to its latest supported protocol version, got ${JSON.stringify(initPayload)}`,
    );

    const initializedResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

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
    assert.ok(sessionId, 'Expected initialize response to include Mcp-Session-Id');

    // SDK v2 transport accepts any supported protocol version on subsequent
    // requests, not just the one negotiated at initialization.
    const otherSupportedVersionResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': OLDER_SUPPORTED_PROTOCOL_VERSION,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

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
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(response.status, 403);
    const body = (await response.json()) as { error?: { code?: number; message?: string } };
    assert.equal(body.error?.code, -32000);
    assert.match(body.error?.message ?? '', /Invalid Origin/u);
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
          protocolVersion: LATEST_PROTOCOL_VERSION,
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

    const text = await response.text();
    assert.equal(text, '');
  });

  it('refuses non-loopback HTTP binding without an API key', async () => {
    // Smoke-only: full policy matrix is unit-tested in
    // `__tests__/unit/http-auth-guard.test.ts`.
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const dir = tempDir;
    process.env['HTTP_HOST'] = '0.0.0.0';

    await assert.rejects(
      () => startHttpServer(0, { cliAllowedDirs: [dir] }),
      /Refusing to bind HTTP server to non-loopback host/,
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

      assert.equal(tools.length, 12);
      assert.equal(resources.length, 1);
      assert.equal(resources[0]?.uri, 'internal://instructions');
      assert.deepEqual(resourceTemplates.map((template) => template.uriTemplate).sort(), [
        'filesystem-mcp://file/{+path}',
        'filesystem-mcp://result/{id}',
      ]);
      assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), [
        'analyze-path',
        'find-in-tree',
        'get-help',
        'summarize-directory',
      ]);
    } finally {
      await transport.terminateSession().catch(() => {});
      await client.close().catch(() => {});
    }
  });

  it('evicts stale uninitialized sessions through the full cleanup path', async () => {
    // Confirms the sweep timer is wired into startHttpServer's lifecycle, on
    // the handshake clock. The idle clock is covered by the case below.
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
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });

    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Expected initialize response to include Mcp-Session-Id');

    await new Promise((resolve) => setTimeout(resolve, 2200));

    const followUpResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
        'mcp-session-id': sessionId,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        method: 'notifications/initialized',
      }),
    });

    assert.equal(followUpResponse.status, 404);
    assert.match(await followUpResponse.text(), /Session not found/u);
  });

  it('evicts an initialized session that goes idle', async () => {
    // A session that completes the handshake and is then abandoned holds its
    // server and session slot forever without this clock — streamable HTTP has
    // no connection whose loss would reveal the client is gone.
    process.env['FS_INIT_HANDSHAKE_TIMEOUT_MS'] = '1000'; // sweep runs every 2s
    process.env['FILESYSTEM_MCP_SESSION_IDLE_TIMEOUT_MS'] = '1000';
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const initResponse = await mcpPost(port, initializeRequest('http-idle-test'));
    assert.equal(initResponse.status, 200);
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Expected initialize response to include Mcp-Session-Id');
    await initResponse.text(); // drain, so the response closes and stops counting as in flight

    // Completing the handshake takes this session off the handshake clock — an
    // eviction from here on can only be the idle clock.
    const initializedResponse = await mcpPost(
      port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
    );
    assert.equal(initializedResponse.status, 202);
    await initializedResponse.text();

    await new Promise((resolve) => setTimeout(resolve, 2500));

    const afterIdle = await mcpPost(
      port,
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      sessionId,
    );
    assert.equal(afterIdle.status, 404);
    assert.match(await afterIdle.text(), /Session not found/u);
  });

  it('keeps a session whose client is parked on an open GET stream', async () => {
    // The counterweight to idle eviction: a subscriber holding a long-lived SSE
    // stream sends nothing for hours and must not be mistaken for abandoned.
    process.env['FS_INIT_HANDSHAKE_TIMEOUT_MS'] = '1000'; // sweep runs every 2s
    process.env['FILESYSTEM_MCP_SESSION_IDLE_TIMEOUT_MS'] = '1000';
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const initResponse = await mcpPost(port, initializeRequest('http-parked-test'));
    const sessionId = initResponse.headers.get('mcp-session-id');
    assert.ok(sessionId, 'Expected initialize response to include Mcp-Session-Id');
    await initResponse.text();

    const initializedResponse = await mcpPost(
      port,
      { jsonrpc: '2.0', method: 'notifications/initialized' },
      sessionId,
    );
    assert.equal(initializedResponse.status, 202);
    await initializedResponse.text();

    // Open the standalone SSE stream and leave it open — never drained.
    const streamAbort = new AbortController();
    const streamResponse = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
      method: 'GET',
      headers: { accept: 'text/event-stream', 'mcp-session-id': sessionId },
      signal: streamAbort.signal,
    });
    assert.equal(streamResponse.status, 200);

    try {
      // Well past the idle timeout and two sweeps, with no request traffic.
      await new Promise((resolve) => setTimeout(resolve, 2500));

      const stillAlive = await mcpPost(
        port,
        { jsonrpc: '2.0', id: 2, method: 'tools/list' },
        sessionId,
      );
      assert.equal(stillAlive.status, 200);
      await stillAlive.text();
    } finally {
      streamAbort.abort();
    }
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
    assert.equal(
      s.requestTimeout,
      DEFAULT_REQUEST_TIMEOUT_MSEC,
      'requestTimeout must be DEFAULT_REQUEST_TIMEOUT_MSEC',
    );
    assert.equal(s.keepAliveTimeout, 5_000, 'keepAliveTimeout must be 5s');
  });

  it('does not crash on post-startup HTTP server errors', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const listenerCount = server.listenerCount('error');
    assert.ok(
      listenerCount >= 1,
      `Expected at least one persistent error listener, got ${listenerCount}`,
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
    assert.match(String(response.headers['access-control-allow-methods'] ?? ''), /OPTIONS/iu);
  });

  it('accepts an IPv6 loopback origin in CORS preflight', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    // http://[::1]:<port> is the same loopback as http://localhost:<port>;
    // isLoopbackHttpHost has always accepted it as a bind host.
    const response = await rawHttpRequest({
      port,
      method: 'OPTIONS',
      path: '/mcp',
      headers: { origin: 'http://[::1]:3000' },
    });

    assert.equal(response.statusCode, 204);
    assert.equal(response.headers['access-control-allow-origin'], 'http://[::1]:3000');
  });

  it('does not reflect disallowed origins in CORS preflight OPTIONS requests', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    const response = await rawHttpRequest({
      port,
      method: 'OPTIONS',
      path: '/mcp',
      headers: { origin: 'https://evil.com' },
    });

    assert.equal(response.statusCode, 403);
    assert.equal(response.headers['access-control-allow-origin'], undefined);
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

  it('rejects a stray JSON-RPC response posted without a session id', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    const res = await rawHttpRequest({
      port,
      method: 'POST',
      path: '/mcp',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    });

    assert.equal(res.statusCode, 400, 'response messages without a session must be rejected');
    const body = JSON.parse(res.body) as { error?: { code?: number; message?: string } };
    assert.equal(body.error?.code, ProtocolErrorCode.InvalidRequest);
    assert.match(body.error?.message ?? '', /response|notification/iu);
  });

  it('emits a debug breadcrumb when a client sends notifications/initialized over HTTP', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    // Capture Logger.debug calls
    const debugLogs: { message: string; data: unknown }[] = [];
    const originalDebug = Object.getOwnPropertyDescriptor(Logger, 'debug')?.value as
      ((message: string, data: unknown) => void) | undefined;
    Object.defineProperty(Logger, 'debug', {
      value: (message: string, data: unknown): void => {
        debugLogs.push({ message, data });
        if (originalDebug) originalDebug.call(Logger, message, data);
      },
      configurable: true,
    });

    try {
      // First, open a session via initialize request using fetch
      const initRes = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
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
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'test', version: '0' },
          },
        }),
      });
      assert.equal(initRes.status, 200, 'initialize should return 200');

      // Extract session ID from response header
      const sessionId = initRes.headers.get('mcp-session-id');
      assert.ok(typeof sessionId === 'string', 'Expected mcp-session-id header');

      debugLogs.length = 0; // Clear init logs

      // Now send notifications/initialized with the session ID
      const notifRes = await fetch(`http://127.0.0.1:${String(port)}/mcp`, {
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          'mcp-session-id': sessionId,
        },
        body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
      });
      assert.equal(notifRes.status, 202, 'initialized notification should return 202');

      // Verify the breadcrumb was logged
      const breadcrumb = debugLogs.find(
        (log) =>
          log.message === '[HTTP] initialized notification received' &&
          typeof log.data === 'object' &&
          log.data !== null &&
          'sessionId' in log.data &&
          (log.data as Record<string, unknown>).sessionId === sessionId,
      );
      assert.ok(breadcrumb, 'Expected initialized-notification breadcrumb in HTTP debug log');
    } finally {
      // Restore Logger.debug
      if (originalDebug) {
        Object.defineProperty(Logger, 'debug', {
          value: originalDebug,
          configurable: true,
        });
      }
    }
  });

  it('accepts allowed hosts when FILESYSTEM_MCP_ALLOWED_HOSTS is set', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    process.env['HTTP_HOST'] = '127.0.0.1';
    process.env['FILESYSTEM_MCP_ALLOWED_HOSTS'] = '127.0.0.1, localhost, custom-host.local';
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    // Should accept 127.0.0.1
    const res1 = await rawHttpRequest({
      port,
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: '127.0.0.1',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(res1.statusCode, 200);

    // Should accept custom-host.local
    const res2 = await rawHttpRequest({
      port,
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'custom-host.local',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(res2.statusCode, 200);

    // Should reject disallowed-host.local
    const res3 = await rawHttpRequest({
      port,
      method: 'POST',
      headers: {
        accept: 'application/json, text/event-stream',
        'content-type': 'application/json',
        host: 'disallowed-host.local',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 3,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      }),
    });
    assert.equal(res3.statusCode, 403);
  });

  it('accepts every loopback spelling of Host on a default bind', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    // Regression: a bare ['127.0.0.1'] allowed-host list 403s the URL users
    // actually type (http://localhost:<port>/mcp).
    for (const host of ['127.0.0.1', 'localhost', '[::1]']) {
      const response = await rawHttpRequest({
        port,
        method: 'POST',
        headers: {
          accept: 'application/json, text/event-stream',
          'content-type': 'application/json',
          host,
        },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'initialize',
          params: {
            protocolVersion: LATEST_PROTOCOL_VERSION,
            capabilities: {},
            clientInfo: { name: 'http-test', version: '1.0.0' },
          },
        }),
      });
      assert.equal(response.statusCode, 200, `Host: ${host} must be accepted`);
    }
  });

  describe('bearer auth', () => {
    const API_KEY = 'test-api-key-at-least-16-chars';

    async function startAuthedServer(): Promise<number> {
      tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-auth-'));
      process.env['API_KEY'] = API_KEY;
      const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
      servers.push(server);
      return getServerPort(server);
    }

    function initializeBody(): string {
      return JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'http-test', version: '1.0.0' },
        },
      });
    }

    const jsonHeaders = {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
    };

    it('rejects an unauthenticated request with 401 and a Bearer challenge', async () => {
      const port = await startAuthedServer();

      const response = await rawHttpRequest({
        port,
        method: 'POST',
        headers: jsonHeaders,
        body: initializeBody(),
      });

      assert.equal(response.statusCode, 401);
      const challenge = response.headers['www-authenticate'];
      assert.ok(typeof challenge === 'string' && challenge.startsWith('Bearer '));
      assert.match(challenge, /resource_metadata="[^"]+"/u);
      // RFC 6750 §3.1: no credentials presented means no error code.
      assert.doesNotMatch(challenge, /error=/u);
      const parsed = JSON.parse(response.body) as { error?: { message?: string } };
      assert.equal(parsed.error?.message, 'Unauthorized');
    });

    it('rejects a wrong bearer token with 401 and error="invalid_token"', async () => {
      const port = await startAuthedServer();

      const response = await rawHttpRequest({
        port,
        method: 'POST',
        headers: { ...jsonHeaders, authorization: 'Bearer not-the-right-key-1234' },
        body: initializeBody(),
      });

      assert.equal(response.statusCode, 401);
      const challenge = response.headers['www-authenticate'];
      // A presented-but-wrong token is a different situation from none at all.
      assert.ok(typeof challenge === 'string' && challenge.includes('error="invalid_token"'));
    });

    it('points the challenge at a protected-resource document the client can fetch', async () => {
      const port = await startAuthedServer();

      const unauthorized = await rawHttpRequest({
        port,
        method: 'POST',
        headers: jsonHeaders,
        body: initializeBody(),
      });
      const challenge = unauthorized.headers['www-authenticate'];
      assert.ok(typeof challenge === 'string');
      const metadataUrl = /resource_metadata="([^"]+)"/u.exec(challenge)?.[1];
      assert.ok(metadataUrl, 'Expected a resource_metadata parameter in the challenge');

      // Follow it exactly as a client would — unauthenticated, since the point
      // of reading it is not having a credential yet.
      const metadataResponse = await rawHttpRequest({
        port,
        method: 'GET',
        path: new URL(metadataUrl).pathname,
      });

      assert.equal(metadataResponse.statusCode, 200);
      // Public by design, so browser clients on any origin can read it — the
      // /mcp routes keep their reflected-allowlist policy.
      assert.equal(metadataResponse.headers['access-control-allow-origin'], '*');
      const doc = JSON.parse(metadataResponse.body) as {
        resource?: string;
        bearer_methods_supported?: string[];
        authorization_servers?: unknown;
      };
      assert.match(doc.resource ?? '', /^http:\/\/127\.0\.0\.1:\d+\/mcp$/u);
      assert.deepEqual(doc.bearer_methods_supported, ['header']);
      // No AS exists — advertising one would send clients into a flow that
      // cannot complete against a static operator-issued key.
      assert.equal(doc.authorization_servers, undefined);
    });

    it('reflects FILESYSTEM_MCP_PUBLIC_URL when the server sits behind a proxy', async () => {
      process.env['FILESYSTEM_MCP_PUBLIC_URL'] = 'https://mcp.example.com/mcp';
      const port = await startAuthedServer();

      const response = await rawHttpRequest({
        port,
        method: 'GET',
        path: '/.well-known/oauth-protected-resource/mcp',
      });

      assert.equal(response.statusCode, 200);
      const doc = JSON.parse(response.body) as { resource?: string };
      assert.equal(doc.resource, 'https://mcp.example.com/mcp');
    });

    it('accepts the matching bearer token', async () => {
      const port = await startAuthedServer();

      const response = await rawHttpRequest({
        port,
        method: 'POST',
        headers: { ...jsonHeaders, authorization: `Bearer ${API_KEY}` },
        body: initializeBody(),
      });

      assert.equal(response.statusCode, 200);
    });

    it('advertises no protected resource when the endpoint is unauthenticated', async () => {
      // No API_KEY: the endpoint is open, so claiming a bearer token is
      // required would be false. Discovery must be absent, not empty.
      tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-noauth-'));
      const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
      servers.push(server);

      const response = await rawHttpRequest({
        port: getServerPort(server),
        method: 'GET',
        path: '/.well-known/oauth-protected-resource/mcp',
      });

      assert.equal(response.statusCode, 404);
    });

    it('still answers 401, not 500, when the Host header is not a usable URL host', async () => {
      // A space and a `%` are forbidden WHATWG host code points, so building the
      // resource identifier from this Host throws. The only configuration that
      // lets such a Host reach the auth middleware is a wildcard bind with host
      // validation opted out — the SDK mounts its Host validator only when the
      // allowlist is non-empty. Binds on an ephemeral port, dialed via loopback.
      tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-badhost-'));
      process.env['API_KEY'] = API_KEY;
      process.env['HTTP_HOST'] = '0.0.0.0';
      process.env['FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS'] = '1';
      const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
      servers.push(server);
      const port = getServerPort(server);

      for (const host of ['a b', '%']) {
        const response = await rawHttpRequest({
          port,
          method: 'POST',
          headers: { ...jsonHeaders, host },
          body: initializeBody(),
        });

        assert.equal(response.statusCode, 401, `Host: ${host} must still challenge`);
        // The challenge stays well-formed; it just cannot name a resource it
        // was unable to derive.
        assert.equal(response.headers['www-authenticate'], 'Bearer');
      }
    });

    it('reports 400 rather than 500 when the metadata route gets an unusable Host', async () => {
      tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-badhost-'));
      process.env['API_KEY'] = API_KEY;
      process.env['HTTP_HOST'] = '0.0.0.0';
      process.env['FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS'] = '1';
      const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
      servers.push(server);

      const response = await rawHttpRequest({
        port: getServerPort(server),
        method: 'GET',
        path: '/.well-known/oauth-protected-resource/mcp',
        headers: { host: 'a b' },
      });

      assert.equal(response.statusCode, 400);
    });

    it('guards GET and DELETE, not just POST', async () => {
      const port = await startAuthedServer();

      for (const method of ['GET', 'DELETE']) {
        const response = await rawHttpRequest({
          port,
          method,
          headers: { accept: 'text/event-stream' },
        });
        assert.equal(response.statusCode, 401, `${method} must require auth`);
      }
    });
  });
});
