import {
  Client,
  type McpSubscription,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.js';
import { startHttpServer } from '../src/transport.js';
import { cleanupTestRoot, createTestRoot, waitFor, writeTestFile } from './helpers.js';

// The modern HTTP leg builds a fresh McpServer per request. With a per-instance
// PathGuard, an accepted access grant died with the request that accepted it
// (re-prompting on every later call), and the listen-watcher path validated
// against a second, boot-time guard that never saw a grant at all. Both are
// fixed by one guard per endpoint; these two cases fail if that regresses.

const API_KEY = 'x-test-key-0123456789';
const STATE_KEY = 'a'.repeat(32);

describe('HTTP shared PathGuard (grant persistence + watcher visibility)', () => {
  let rootDir: string;
  let outDir: string;
  let outFile: string;
  let httpServer: Server;
  let client: Client;
  let subscription: McpSubscription | undefined;
  let savedBoundary: string | undefined;
  let elicitCount = 0;

  before(async () => {
    rootDir = await createTestRoot();
    outDir = await mkdtemp(join(tmpdir(), 'fsmcp-shared-guard-'));
    outFile = await writeTestFile(outDir, 'granted.txt', 'initial');

    savedBoundary = process.env['ROOT_BOUNDARY'];
    // Without a boundary an applied grant is filtered back out on recompute
    // (see TC-PG-005), so the grant must be inside one to actually stick.
    process.env['ROOT_BOUNDARY'] = tmpdir();
    process.env['API_KEY'] = API_KEY;
    process.env['HTTP_HOST'] = '127.0.0.1';
    process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = STATE_KEY;

    httpServer = await startHttpServer(0, { cliAllowedDirs: [rootDir] });
    const port = (httpServer.address() as AddressInfo).port;
    const base = new URL(`http://127.0.0.1:${port}/mcp`);

    const transport = new StreamableHTTPClientTransport(base, {
      fetch: (u, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${API_KEY}`);
        return fetch(u, { ...init, headers });
      },
    });
    client = new Client(
      { name: 'http-shared-guard', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler('elicitation/create', () => {
      elicitCount += 1;
      return { action: 'accept' as const, content: { confirm: true } };
    });
    await client.connect(transport);
  });

  after(async () => {
    await subscription?.close().catch(() => {});
    await client.close();
    await new Promise<void>((resolve) => httpServer.close(resolve));
    if (savedBoundary === undefined) delete process.env['ROOT_BOUNDARY'];
    else process.env['ROOT_BOUNDARY'] = savedBoundary;
    delete process.env['API_KEY'];
    delete process.env['HTTP_HOST'];
    delete process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'];
    await cleanupTestRoot(outDir);
    await cleanupTestRoot(rootDir);
  });

  it('an accepted grant survives the request that accepted it (one prompt, not two)', async () => {
    const first = await client.callTool({ name: 'read', arguments: { path: outFile } });
    assert.notStrictEqual(first.isError, true, 'granted read must succeed');
    assert.strictEqual(elicitCount, 1, 'the first call must prompt for the grant exactly once');

    const second = await client.callTool({ name: 'read', arguments: { path: outFile } });
    assert.notStrictEqual(second.isError, true, 'second read must succeed without a new grant');
    assert.strictEqual(
      elicitCount,
      1,
      'the grant must persist across requests — a second prompt means the guard was rebuilt',
    );
  });

  it('the listen-watcher path sees the grant applied by an earlier request', async () => {
    const uri = buildFileResourceUri(outFile);
    let received: string | undefined;
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });

    subscription = await client.listen({ resourceSubscriptions: [uri] });
    await writeFile(outFile, 'changed');

    await waitFor(() => received !== undefined);
    assert.strictEqual(
      received,
      uri,
      'no update means attachListenWatchers validated against a guard without the grant',
    );
  });
});
