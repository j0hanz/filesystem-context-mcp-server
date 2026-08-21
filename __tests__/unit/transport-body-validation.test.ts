// __tests__/unit/transport-body-validation.test.ts
import {
  LATEST_PROTOCOL_VERSION,
  parseJSONRPCMessage,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { startHttpServer } from '../../src/transport.js';

describe('JSON-RPC message validation', () => {
  describe('parseJSONRPCMessage function availability', () => {
    it('parseJSONRPCMessage is exported from SDK', () => {
      assert.ok(
        typeof parseJSONRPCMessage === 'function',
        'parseJSONRPCMessage should be a function',
      );
    });
  });

  describe('parseJSONRPCMessage behavior', () => {
    it('accepts valid JSON-RPC 2.0 request', () => {
      const validRequest = {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {},
      };
      const result = parseJSONRPCMessage(validRequest);
      assert.deepStrictEqual(result, validRequest);
    });

    it('throws on missing jsonrpc field', () => {
      const invalid = {
        id: 1,
        method: 'initialize',
        params: {},
      };
      assert.throws(() => {
        parseJSONRPCMessage(invalid);
      }, 'Should throw on missing jsonrpc field');
    });

    it('throws on invalid jsonrpc version', () => {
      const invalid = {
        jsonrpc: '1.0',
        id: 1,
        method: 'initialize',
        params: {},
      };
      assert.throws(() => {
        parseJSONRPCMessage(invalid);
      }, 'Should throw on invalid jsonrpc version');
    });

    it('throws on null input', () => {
      assert.throws(() => {
        parseJSONRPCMessage(null);
      }, 'Should throw on null input');
    });

    it('throws on string input', () => {
      assert.throws(() => {
        parseJSONRPCMessage('not an object');
      }, 'Should throw on string input');
    });

    it('throws on array input', () => {
      assert.throws(() => {
        parseJSONRPCMessage([]);
      }, 'Should throw on array input');
    });

    it('throws on plain object without jsonrpc', () => {
      assert.throws(() => {
        parseJSONRPCMessage({ foo: 'bar' });
      }, 'Should throw on plain object without jsonrpc');
    });
  });
});

describe('HTTP transport JSON-RPC validation (integration)', () => {
  let tmpDir: string;
  let server: Awaited<ReturnType<typeof startHttpServer>> | null = null;
  let port: number;

  afterEach(async () => {
    if (server !== null) {
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
      server = null;
    }
    if (tmpDir) {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  async function rawHttpRequest(params: {
    method: string;
    path?: string;
    headers?: Record<string, string>;
    body?: string;
  }): Promise<{
    statusCode: number;
    body: string;
  }> {
    const { request: httpRequest } = await import('node:http');
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          host: '127.0.0.1',
          port,
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

  it('returns -32600 error for malformed JSON-RPC (missing jsonrpc field)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filesystem-mcp-test-'));
    server = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    port = (server.address() as { port: number }).port;

    const malformedBody = JSON.stringify({
      id: 1,
      method: 'initialize',
      params: {},
      // missing jsonrpc: '2.0'
    });

    const response = await rawHttpRequest({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: malformedBody,
    });

    assert.equal(response.statusCode, 400, 'Should return 400 for invalid request');

    const body = JSON.parse(response.body) as {
      jsonrpc: string;
      error?: { code: number; message: string };
      id?: unknown;
    };
    assert.equal(body.jsonrpc, '2.0', 'Response should be valid JSON-RPC 2.0');
    assert.ok(body.error, 'Response should contain error object');
    assert.equal(
      body.error.code,
      ProtocolErrorCode.InvalidRequest,
      `Should return InvalidRequest error code (${ProtocolErrorCode.InvalidRequest})`,
    );
    // A POST missing `jsonrpc: '2.0'` carries no 2025 envelope, so the
    // era-branch (isLegacyRequest) routes it to the modern leg, which owns the
    // -32600 rejection for an unparseable body. The code is the same; the
    // modern leg's message differs from the legacy stack's 'Invalid Request'.
    assert.equal(
      body.error.message,
      'Bad Request: the request body is not a valid JSON-RPC message',
    );
    // The modern leg correlates the error to the id it read from the body
    // (1 here) rather than nulling it — unlike the legacy stack, which could
    // not parse the message and returned id: null.
    assert.equal(body.id, 1, 'Error response echoes the request id from the body');
  });

  it('returns -32700 error for non-object body (Express rejects non-object JSON)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filesystem-mcp-test-'));
    server = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    port = (server.address() as { port: number }).port;

    const response = await rawHttpRequest({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify('not an object'),
    });

    assert.equal(response.statusCode, 400, 'Should return 400 for invalid JSON');

    const body = JSON.parse(response.body) as {
      jsonrpc: string;
      error?: { code: number; message: string };
    };
    // Express.json() rejects non-object JSON with ParseError
    assert.equal(
      body.error?.code,
      ProtocolErrorCode.ParseError,
      `Should return ParseError error code when Express rejects non-object JSON`,
    );
  });

  it('returns -32700 error for null body (Express rejects null)', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filesystem-mcp-test-'));
    server = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    port = (server.address() as { port: number }).port;

    const response = await rawHttpRequest({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(null),
    });

    assert.equal(response.statusCode, 400, 'Should return 400 for invalid JSON');

    const body = JSON.parse(response.body) as {
      jsonrpc: string;
      error?: { code: number };
    };
    // Express.json() rejects bare null with ParseError
    assert.equal(
      body.error?.code,
      ProtocolErrorCode.ParseError,
      `Should return ParseError when Express rejects bare null`,
    );
  });

  it('allows valid JSON-RPC initialize request', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'filesystem-mcp-test-'));
    server = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    port = (server.address() as { port: number }).port;

    const validRequest = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: LATEST_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: 'test-client',
          version: '1.0.0',
        },
      },
    });

    const response = await rawHttpRequest({
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: validRequest,
    });

    // Valid initialize request should get a streaming response (200 or 206)
    // or an error response if server refuses, but NOT -32600 Invalid Request
    assert.notEqual(response.statusCode, 400, 'Valid JSON-RPC request should not return 400');

    const body = JSON.parse(response.body) as {
      error?: { code: number };
    };
    // Should not be InvalidRequest error
    if (body.error) {
      assert.notEqual(
        body.error.code,
        ProtocolErrorCode.InvalidRequest,
        'Valid JSON-RPC should not result in InvalidRequest error',
      );
    }
  });
});
