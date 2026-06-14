import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import {
  DEFAULT_REQUEST_TIMEOUT_MSEC,
  LATEST_PROTOCOL_VERSION,
  ProtocolErrorCode,
  SUPPORTED_PROTOCOL_VERSIONS,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
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
    assert.ok(initPayload.result?.capabilities?.['logging']);

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

  it('emits one http_request_complete event for initialize requests', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-log-'));
    const logChannel = channel('filesystem-mcp:log');
    const messages: string[] = [];
    const subscription = (msg: unknown): void => {
      const event = msg as { message?: string };
      if (typeof event.message === 'string') {
        messages.push(event.message);
      }
    };
    logChannel.subscribe(subscription);

    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);

    const port = getServerPort(server);
    const response = await rawHttpRequest({
      port,
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

    assert.equal(response.statusCode, 200);

    const completion = messages.find((event) => event.includes('event=http_request_complete'));

    assert.ok(completion, 'expected http_request_complete event');
    assert.ok(completion?.includes('transport=http'));
    assert.ok(completion?.includes('method=POST'));
    assert.ok(completion?.includes('jsonrpc_method=initialize'));
    assert.ok(completion?.includes('http_status=200'));
    assert.ok(completion?.includes('outcome=success'));
    assert.ok(completion?.includes('duration_ms='));

    logChannel.unsubscribe(subscription);
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
    process.env['FILESYSTEM_MCP_HTTP_HOST'] = '0.0.0.0';

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

  it('logs structured context for runtime HTTP server errors', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-log-'));
    const logChannel = channel('filesystem-mcp:log');
    const messages: string[] = [];
    const subscription = (msg: unknown): void => {
      const event = msg as { message?: string };
      if (typeof event.message === 'string') {
        messages.push(event.message);
      }
    };
    logChannel.subscribe(subscription);

    try {
      const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
      servers.push(server);

      server.emit('error', new Error('runtime boom'));

      const logged = messages.find((message) => message.includes('[HTTP] runtime server error'));
      assert.ok(logged, 'expected explicit runtime server error log entry');
    } finally {
      logChannel.unsubscribe(subscription);
    }
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
      | ((message: string, data: unknown) => void)
      | undefined;
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
});
