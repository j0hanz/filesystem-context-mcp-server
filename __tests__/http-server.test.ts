import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { MAX_WATCHERS } from '../src/core/watcher-registry.js';
import { ALL_REGISTERED_TOOL_NAMES } from '../src/tools/index.js';
import { startHttpServer } from '../src/transport.js';
import {
  bootHttpTest,
  cleanupTestRoot,
  createTestRoot,
  firstTextBlock,
  type HttpTestContext,
  TEST_API_KEY,
  writeTestFile,
} from './helpers.js';

describe('Real HTTP Server integration', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let base: URL;
  let port: number;

  beforeEach(async () => {
    tmpDir = await createTestRoot();
    http = await bootHttpTest([tmpDir]);
    ({ base, port } = http);
  });

  afterEach(async () => {
    await http.close();
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
    const client = await http.makeClient('http-server-test');
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

  it('externalized tool result is readable back over HTTP', async () => {
    const client = await http.makeClient('result-roundtrip');
    try {
      const file = await writeTestFile(tmpDir, 'hashed.txt', 'body');
      const res = (await client.callTool({ name: 'hash_file', arguments: { path: file } })) as {
        structuredContent?: { resourceUri?: string };
      };
      const uri = res.structuredContent?.resourceUri;
      assert.ok(uri, 'hash_file must externalize a result uri');
      const read = await client.readResource({ uri });
      assert.ok(read.contents.length > 0, 'the externalized result must be readable');
    } finally {
      await client.close();
    }
  });

  it('4. Legacy 2025 initialize request is rejected under pure modern v2', async () => {
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
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
    assert.strictEqual(r.status, 400);
    const body = (await r.json()) as { error?: { code?: number } };
    assert.ok(body.error, 'response must contain a JSON-RPC error object');
    assert.strictEqual(typeof body.error.code, 'number', 'error must include a numeric code');
  });

  it('5. POST /mcp with an oversized body -> 413', async () => {
    const tooBig = 'x'.repeat(5 * 1024 * 1024); // > default 4 MiB FS_CONTEXT_MAX_REQUEST_BYTES
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: tooBig,
    });
    assert.strictEqual(r.status, 413);
    const body = (await r.json()) as { error?: { code?: number } };
    assert.ok(body.error, '413 must carry a JSON-RPC error object');
  });

  it('6. POST /mcp with malformed JSON -> 400 ParseError', async () => {
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
      },
      body: '{not json',
    });
    assert.strictEqual(r.status, 400);
    const body = (await r.json()) as { error?: { code?: number } };
    assert.ok(body.error, '400 must carry a JSON-RPC error object');
  });

  it('GET and DELETE /mcp preserve the SDK JSON-RPC 405 response', async () => {
    for (const method of ['GET', 'DELETE']) {
      const r = await fetch(base, {
        method,
        headers: { Authorization: ['Bearer', TEST_API_KEY].join(' ') },
      });
      assert.strictEqual(r.status, 405);
      assert.match(r.headers.get('content-type') ?? '', /^application\/json/u);
      assert.strictEqual(r.headers.get('allow'), 'POST, OPTIONS', 'RFC 9110 §15.5.6');
      const body = (await r.json()) as { error?: { code?: number; message?: string } };
      assert.strictEqual(body.error?.code, -32000);
      assert.strictEqual(body.error?.message, 'Method not allowed.');
    }
  });

  it('7. subscriptions/listen over remaining watcher capacity -> 400 InvalidParams pre-ack', async () => {
    const resourceSubscriptions = Array.from(
      { length: MAX_WATCHERS + 1 },
      (_, i) => `file:///fake-${i}`,
    );
    const r = await fetch(base, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        Authorization: `Bearer ${TEST_API_KEY}`,
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'subscriptions/listen',
        params: { notifications: { resourceSubscriptions } },
      }),
    });
    assert.strictEqual(r.status, 400);
    const body = (await r.json()) as { error?: { code?: number; message?: string } };
    assert.strictEqual(body.error?.code, ProtocolErrorCode.InvalidParams);
    assert.ok(body.error?.message?.includes('watcher slots'));
  });
});

// The bearer credential reaches the server as `RuntimeConfig.apiKey`, never
// through `process.env`. These two prove the option is what the bind policy and
// the auth middleware actually read: with API_KEY deleted from the environment
// the option alone still demands a bearer, and with the option omitted an
// exported API_KEY no longer turns auth on.
describe('the api key travels as config, not env', () => {
  let tmpDir: string;
  let httpServer: Server;
  let savedApiKey: string | undefined;
  let savedStateKey: string | undefined;

  beforeEach(async () => {
    tmpDir = await createTestRoot();
    savedApiKey = process.env['API_KEY'];
    savedStateKey = process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'];
    Reflect.deleteProperty(process.env, 'API_KEY');
    process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = 'a'.repeat(32);
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => httpServer.close(resolve));
    if (savedApiKey === undefined) Reflect.deleteProperty(process.env, 'API_KEY');
    else process.env['API_KEY'] = savedApiKey;
    if (savedStateKey === undefined) {
      Reflect.deleteProperty(process.env, 'FILESYSTEM_MCP_REQUEST_STATE_KEY');
    } else process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = savedStateKey;
    await cleanupTestRoot(tmpDir);
  });

  it('the apiKey option demands a bearer with API_KEY absent from the environment', async () => {
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] }, { apiKey: TEST_API_KEY });
    const port = (httpServer.address() as AddressInfo).port;
    const url = new URL(`http://127.0.0.1:${port}/mcp`);

    const anon = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.strictEqual(anon.status, 401, 'the option alone must switch auth on');
    assert.match(
      anon.headers.get('www-authenticate') ?? '',
      /^Bearer /,
      'the 401 must carry an RFC 6750 challenge',
    );
  });

  it('an exported API_KEY does not switch auth on when the option is omitted', async () => {
    process.env['API_KEY'] = TEST_API_KEY;
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    const port = (httpServer.address() as AddressInfo).port;

    const anon = await fetch(new URL(`http://127.0.0.1:${port}/mcp`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    assert.notStrictEqual(anon.status, 401, 'env is read at the CLI boundary, not here');
  });
});

describe('rate limiting', () => {
  let tmpDir: string;
  let http: HttpTestContext;
  let base: URL;

  beforeEach(async () => {
    tmpDir = await createTestRoot();
    http = await bootHttpTest([tmpDir], { FILESYSTEM_MCP_RATE_LIMIT_RPM: '2' });
    ({ base } = http);
  });

  afterEach(async () => {
    await http.close();
    await cleanupTestRoot(tmpDir);
  });

  it('third authenticated POST within the window is rejected with 429', async () => {
    const headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${TEST_API_KEY}`,
    };
    // Lightweight bodies that the handler resolves quickly (legacy initialize
    // returns 400) so the limiter — which runs before the handler — counts
    // them before any handler work. The third is rate-limited pre-handler.
    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-11-25',
        capabilities: {},
        clientInfo: { name: 'rl', version: '1' },
      },
    });
    const r1 = await fetch(base, { method: 'POST', headers, body });
    const r2 = await fetch(base, { method: 'POST', headers, body });
    const r3 = await fetch(base, { method: 'POST', headers, body });
    assert.ok(r1.status < 500 && r2.status < 500);
    assert.strictEqual(r3.status, 429);
    const r3body = (await r3.json()) as { error?: { code?: number } };
    assert.ok(r3body.error, '429 must carry a JSON-RPC error object');
  });
});
