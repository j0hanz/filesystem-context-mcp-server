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
import { listenSubscriptionUris, startHttpServer } from '../src/transport.js';
import { cleanupTestRoot, createTestRoot, waitFor, writeTestFile } from './helpers.js';

describe('listenSubscriptionUris', () => {
  it('de-duplicates repeated URIs so attach and release stay balanced', () => {
    const body = {
      method: 'subscriptions/listen',
      params: { notifications: { resourceSubscriptions: ['a://1', 'a://2', 'a://1'] } },
    };
    assert.deepStrictEqual(listenSubscriptionUris(body), ['a://1', 'a://2']);
  });
});

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
    await waitFor(() => receivedA !== undefined);
    assert.strictEqual(receivedA, uri, 'subscriber A must receive the update');

    // Give B a short window to prove it stays silent — it never subscribed.
    await waitFor(() => receivedB !== undefined, 400);
    assert.strictEqual(
      receivedB,
      undefined,
      'non-subscriber B must NOT receive the update (per-connection gating)',
    );
  });
});

// Fan-out (#13): two clients subscribe to the SAME file URI. Pre-fix, the
// registry's `addCallback` did `set(uri, notify)`, so the second subscriber
// overwrote the first's callback — only one client received the update. The
// Set-based registry must notify every subscriber.
describe('HTTP watcher fan-out (multi-subscriber)', () => {
  let tmpDir: string;
  let httpServer: Server;
  let base: URL;
  let clientA: Client;
  let clientB: Client;
  let subA: McpSubscription | undefined;
  let subB: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeTestFile(tmpDir, 'fanout.txt', 'initial');
    process.env['API_KEY'] = API_KEY;
    process.env['HTTP_HOST'] = '127.0.0.1';
    process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = STATE_KEY;
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    const port = (httpServer.address() as AddressInfo).port;
    base = new URL(`http://127.0.0.1:${port}/mcp`);
    clientA = await makeFanoutClient(base);
    clientB = await makeFanoutClient(base);
  });

  after(async () => {
    try {
      await subA?.close();
    } catch {
      /* teardown */
    }
    try {
      await subB?.close();
    } catch {
      /* teardown */
    }
    await clientA.close();
    await clientB.close();
    await new Promise<void>((resolve) => httpServer.close(resolve));
    delete process.env['API_KEY'];
    delete process.env['HTTP_HOST'];
    delete process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'];
    await cleanupTestRoot(tmpDir);
  });

  async function makeFanoutClient(url: URL): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: (u, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${API_KEY}`);
        return fetch(u, { ...init, headers });
      },
    });
    const client = new Client(
      { name: 'http-fanout', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    return client;
  }

  it('both subscribers receive the update for one file URI', async () => {
    const filePath = join(tmpDir, 'fanout.txt');
    const uri = buildFileResourceUri(filePath);
    let receivedA: string | undefined;
    let receivedB: string | undefined;

    clientA.setNotificationHandler('notifications/resources/updated', (n) => {
      receivedA = (n.params as { uri: string }).uri;
    });
    clientB.setNotificationHandler('notifications/resources/updated', (n) => {
      receivedB = (n.params as { uri: string }).uri;
    });

    subA = await clientA.listen({ resourceSubscriptions: [uri] });
    subB = await clientB.listen({ resourceSubscriptions: [uri] });

    await writeFile(filePath, 'changed');

    await waitFor(() => receivedA !== undefined && receivedB !== undefined);
    assert.strictEqual(receivedA, uri, 'subscriber A must receive the update');
    assert.strictEqual(receivedB, uri, 'subscriber B must receive the update');
  });

  it('remaining subscriber still receives updates after one unsubscribes', async () => {
    // Regression: `remove(uri)` used to tear down the shared watcher, so a
    // second subscriber silently stopped receiving updates when the first
    // unsubscribed. Ref-counting keeps the watcher live until the last leaves.
    const filePath = join(tmpDir, 'fanout.txt');
    const uri = buildFileResourceUri(filePath);
    let receivedB: string | undefined;

    subA = await clientA.listen({ resourceSubscriptions: [uri] });
    subB = await clientB.listen({ resourceSubscriptions: [uri] });

    // Drain any initial notifications by waiting briefly, then reset B's flag.
    await setTimeout(60);
    clientB.setNotificationHandler('notifications/resources/updated', (n) => {
      receivedB = (n.params as { uri: string }).uri;
    });

    await subA.close();
    subA = undefined;
    await writeFile(filePath, 'after-unsub');

    await waitFor(() => receivedB !== undefined);
    assert.strictEqual(
      receivedB,
      uri,
      'subscriber B must still receive updates after A unsubscribes',
    );
  });
});

// Recursive directory watch (#13): one client subscribes to a DIRECTORY URI.
// Pre-fix, `attach` called `watch(path, cb)` with no options, so child changes
// were not reported. With `{ recursive: true }` for directories, creating a
// child file must notify the subscriber. Note: this creates a DIRECT child,
// which a non-recursive directory watch also catches; nested-grandchild
// coverage depends on platform recursive support (macOS/Windows only — see the
// `attach` ponytail comment), so it is not asserted here to stay green on Linux.
describe('HTTP recursive directory watch', () => {
  let tmpDir: string;
  let httpServer: Server;
  let base: URL;
  let client: Client;
  let subscription: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    process.env['API_KEY'] = API_KEY;
    process.env['HTTP_HOST'] = '127.0.0.1';
    process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = STATE_KEY;
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    const port = (httpServer.address() as AddressInfo).port;
    base = new URL(`http://127.0.0.1:${port}/mcp`);
    client = await makeRecursiveClient(base);
  });

  after(async () => {
    try {
      await subscription?.close();
    } catch {
      /* teardown */
    }
    await client.close();
    await new Promise<void>((resolve) => httpServer.close(resolve));
    delete process.env['API_KEY'];
    delete process.env['HTTP_HOST'];
    delete process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'];
    await cleanupTestRoot(tmpDir);
  });

  async function makeRecursiveClient(url: URL): Promise<Client> {
    const transport = new StreamableHTTPClientTransport(url, {
      fetch: (u, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${API_KEY}`);
        return fetch(u, { ...init, headers });
      },
    });
    const client = new Client(
      { name: 'http-recursive', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
    return client;
  }

  it('subscriber is notified when a child file is created under the directory', async () => {
    const dirUri = buildFileResourceUri(tmpDir);
    let received: string | undefined;

    client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });

    subscription = await client.listen({ resourceSubscriptions: [dirUri] });

    const childPath = join(tmpDir, 'child.txt');
    await writeFile(childPath, 'new child');

    await waitFor(() => received !== undefined);
    assert.strictEqual(received, dirUri, 'directory subscriber must be notified of a child change');
  });
});
