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
import { setTimeout } from 'node:timers/promises';

import { buildFileResourceUri } from '../src/core/file-uri.js';
import { MAX_WATCHERS } from '../src/core/watcher-registry.js';
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

// resourcesListChanged listen filter: an accepted access grant calls
// notifier.resourcesChanged() -> bus.publish resources_list_changed, and the
// SDK listen router narrows that notification to subscriptions that opted into
// `resourcesListChanged`. Modeled on http-shared-guard: HTTP server,
// elicitation-capable client, ROOT_BOUNDARY=tmpdir() so a grant sticks.
describe('HTTP resourcesListChanged listen filter', () => {
  let rootDir: string;
  let outDir: string;
  let outFile: string;
  let httpServer: Server;
  let client: Client;
  let sub: McpSubscription | undefined;
  let savedBoundary: string | undefined;

  before(async () => {
    rootDir = await createTestRoot();
    outDir = await mkdtemp(join(tmpdir(), 'fsmcp-listchanged-'));
    outFile = await writeTestFile(outDir, 'granted.txt', 'initial');

    savedBoundary = process.env['ROOT_BOUNDARY'];
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
      { name: 'http-list-changed', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' }, capabilities: { elicitation: { form: {} } } },
    );
    client.setRequestHandler('elicitation/create', () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));
    await client.connect(transport);
  });

  after(async () => {
    await sub?.close().catch(() => {});
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

  it('a resourcesListChanged listen receives notifications/resources/list_changed on grant', async () => {
    let received = false;
    client.setNotificationHandler('notifications/resources/list_changed', () => {
      received = true;
    });
    sub = await client.listen({ resourcesListChanged: true });
    try {
      // Trigger a grant: read an out-of-root file; the elicitation handler
      // accepts, applyGrant runs notifier.resourcesChanged() -> bus.publish
      // resources_list_changed -> the listen router delivers the notification.
      const r = await client.callTool({ name: 'read', arguments: { path: outFile } });
      assert.notStrictEqual(r.isError, true, 'granted read must succeed');
      await waitFor(() => received);
      assert.strictEqual(received, true, 'list-changed listener must be notified on grant');
    } finally {
      await sub.close().catch(() => {});
      sub = undefined;
    }
  });
});

// Capacity pre-check overcount (Plan 002): the pre-check used to count every
// requested URI as needing a new slot, including URIs already watched.
// MAX_WATCHERS is a module-level constant read at import time, so it cannot
// be clamped per-test via env var — instead this drives the real default cap
// to its boundary: one URI is already watched, then a single batch mixes
// that URI with just enough new (fake, unvalidatable) URIs to exactly fill
// the remaining slots. The old code counted the already-watched URI too and
// rejected the batch with 400; the fix excludes it and must accept.
describe('HTTP duplicate listen does not consume capacity', () => {
  let tmpDir: string;
  let httpServer: Server;
  let base: URL;
  let client: Client;
  let sub: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeTestFile(tmpDir, 'duplisten.txt', 'initial');
    process.env['API_KEY'] = API_KEY;
    process.env['HTTP_HOST'] = '127.0.0.1';
    process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = STATE_KEY;
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    const port = (httpServer.address() as AddressInfo).port;
    base = new URL(`http://127.0.0.1:${port}/mcp`);
    const transport = new StreamableHTTPClientTransport(base, {
      fetch: (u, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${API_KEY}`);
        return fetch(u, { ...init, headers });
      },
    });
    client = new Client(
      { name: 'http-dup-listen', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
  });

  after(async () => {
    try {
      await sub?.close();
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

  it('a batch mixing an already-watched URI with capacity-filling new URIs is accepted', async () => {
    const filePath = join(tmpDir, 'duplisten.txt');
    const uri = buildFileResourceUri(filePath);
    let received: string | undefined;
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });

    // Establish the watcher for `uri` first, and prove — via a real
    // delivered notification, not a fixed wait — that it is actually live in
    // the registry (attachListenWatchers runs async after the SSE response
    // is already sent, so `.listen()` resolving does not itself guarantee
    // the watcher has attached yet).
    sub = await client.listen({ resourceSubscriptions: [uri] });
    await writeFile(filePath, 'first-change');
    await waitFor(() => received !== undefined);
    assert.strictEqual(received, uri, 'the real watcher must be live before the batch check');

    // `uri` now occupies exactly one slot. Fill every remaining slot with
    // new, non-existent URIs and include `uri` again in the same batch. A
    // second `.listen()` on the same (already-initialized) client reuses its
    // session/protocol-version handshake, unlike a bare fetch, so the only
    // thing under test is the capacity pre-check.
    const fakeUris = Array.from({ length: MAX_WATCHERS - 1 }, (_, i) => `file:///fake-dup-${i}`);
    const sub2 = await client.listen({ resourceSubscriptions: [uri, ...fakeUris] });
    await sub2.close();
  });
});

// Regression: `remove(uri)`'s final-teardown branch used to permanently set
// desiredState to 'unsubscribed' on the watched URI. A later
// subscriptions/listen for the same URI never called startSubscribe (the
// modern attach path), so isStale(uri) stayed true forever and the watcher
// silently never attached again. The fix clears the entry on settled
// teardown instead of poisoning it.
describe('HTTP re-listen after full release', () => {
  let tmpDir: string;
  let httpServer: Server;
  let base: URL;
  let client: Client;
  let sub: McpSubscription | undefined;

  before(async () => {
    tmpDir = await createTestRoot();
    await writeTestFile(tmpDir, 'relisten.txt', 'initial');
    process.env['API_KEY'] = API_KEY;
    process.env['HTTP_HOST'] = '127.0.0.1';
    process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'] = STATE_KEY;
    httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });
    const port = (httpServer.address() as AddressInfo).port;
    base = new URL(`http://127.0.0.1:${port}/mcp`);
    const transport = new StreamableHTTPClientTransport(base, {
      fetch: (u, init) => {
        const headers = new Headers(init?.headers);
        headers.set('Authorization', `Bearer ${API_KEY}`);
        return fetch(u, { ...init, headers });
      },
    });
    client = new Client(
      { name: 'http-relisten', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    await client.connect(transport);
  });

  after(async () => {
    try {
      await sub?.close();
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

  it('a URI whose last listener left can be listened to again', async () => {
    const filePath = join(tmpDir, 'relisten.txt');
    const uri = buildFileResourceUri(filePath);

    const first = await client.listen({ resourceSubscriptions: [uri] });
    await first.close();
    await setTimeout(100);

    let received: string | undefined;
    client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });
    sub = await client.listen({ resourceSubscriptions: [uri] });
    await writeFile(filePath, 'changed-after-relisten');
    await waitFor(() => received !== undefined);
    assert.strictEqual(received, uri, 're-listen after release must receive updates');
  });
});
