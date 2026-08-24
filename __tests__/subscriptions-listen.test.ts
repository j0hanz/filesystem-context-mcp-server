import {
  Client,
  type McpSubscription,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { buildFileResourceUri } from '../src/core/file-uri.js';
import { startHttpServer } from '../src/transport.js';
import { cleanupTestRoot, createTestRoot, writeTestFile } from './helpers.js';

// Per-connection subscription gating (verify-first). Two HTTP clients over one
// real HTTP server (one shared bus/registry): A opens a subscriptions/listen
// for a file URI, B does not. On mutation, A must receive
// notifications/resources/updated and B must NOT. If B receives, the shared bus
// cross-talks across connections (the audit's Should-Fix) and step 8 installs
// per-connection filtering. Uses the real Express server so attachListenWatchers
// wires the file watcher (the handler.fetch harness bypasses it).

const API_KEY = 'x-test-key-0123456789';
const STATE_KEY = 'a'.repeat(32);

describe('HTTP per-connection subscription gating (cross-talk)', () => {
  let tmpDir: string;
  let httpServer: Server;
  let base: URL;
  let clientA: Client;
  let clientB: Client;
  let subscription: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeTestFile(tmpDir, 'watch.txt', 'initial');
    process.env['API_KEY'] = API_KEY;
    process.env['HTTP_HOST'] = '127.0.0.1';
    process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = STATE_KEY;
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    const port = (httpServer.address() as AddressInfo).port;
    base = new URL(`http://127.0.0.1:${port}/mcp`);
    clientA = await makeClient(base);
    clientB = await makeClient(base);
  });

  after(async () => {
    try {
      await subscription?.close();
    } catch {
      /* subscription may already be torn down */
    }
    await clientA.close();
    await clientB.close();
    await new Promise<void>((resolve) => httpServer.close(resolve));
    delete process.env['API_KEY'];
    delete process.env['HTTP_HOST'];
    delete process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'];
    await cleanupTestRoot(tmpDir);
  });

  async function makeClient(url: URL): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: (u, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${API_KEY}`);
        return fetch(u, { ...init, headers });
      },
    });
    const client = new Client(
      { name: 'http-cross-talk', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    return client;
  }

  it('subscriber receives the update; non-subscriber does not (no cross-talk)', async () => {
    const filePath = join(tmpDir, 'watch.txt');
    const uri = buildFileResourceUri(filePath);
    let receivedA: string | undefined;
    let receivedB: string | undefined;

    clientA.setNotificationHandler('notifications/resources/updated', (n) => {
      receivedA = (n.params as { uri: string }).uri;
    });
    clientB.setNotificationHandler('notifications/resources/updated', (n) => {
      receivedB = (n.params as { uri: string }).uri;
    });

    // Only A listens for the URI (2026-07-28 subscriptions/listen).
    subscription = await clientA.listen({ resourceSubscriptions: [uri] });

    await writeFile(filePath, 'changed');

    // Poll for the debounced notification on A (50ms debounce).
    const deadline = Date.now() + 3000;
    while (!receivedA && Date.now() < deadline) {
      await setTimeout(20);
    }
    assert.strictEqual(receivedA, uri, 'subscriber A must receive the update');

    // Give B a short window to prove it stays silent — it never subscribed.
    const silentDeadline = Date.now() + 400;
    while (!receivedB && Date.now() < silentDeadline) {
      await setTimeout(20);
    }
    assert.strictEqual(
      receivedB,
      undefined,
      'non-subscriber B must NOT receive the update (per-connection gating)',
    );
  });
});
