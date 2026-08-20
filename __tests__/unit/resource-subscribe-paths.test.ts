import { ResourceNotFoundError, type ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PathGuard } from '../../src/core/path.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';
import { resourcesRegistrar } from '../../src/resources.js';

type RequestHandler = (
  req: { params: Record<string, string> },
  ctx: ServerContext,
) => Promise<unknown>;

interface MockServer {
  registerResource: (...args: unknown[]) => void;
  server: {
    setRequestHandler: (name: string, handler: RequestHandler) => void;
    sendResourceUpdated: (params: { uri: string }) => Promise<void>;
  };
}

function buildMockServer(updates?: string[]): {
  server: MockServer;
  handlers: Map<string, RequestHandler>;
} {
  const handlers = new Map<string, RequestHandler>();
  const server: MockServer = {
    registerResource: () => {
      /* no-op: we only care about the subscribe request handler */
    },
    server: {
      setRequestHandler: (name, handler) => {
        handlers.set(name, handler);
      },
      sendResourceUpdated: async (params: { uri: string }) => {
        if (updates) updates.push(params.uri);
      },
    },
  };
  return { server, handlers };
}

function fileUri(absolutePath: string): string {
  // filesystem-mcp://file/{+path} — encode the path so extractPath round-trips.
  const posix = absolutePath.replace(/\\/g, '/');
  return `filesystem-mcp://file/${encodeURIComponent(posix).replace(/%2F/gi, '/')}`;
}

// node:fs.watch is platform-dependent and may take a moment to deliver a change
// event (and occasionally coalesce rapid ones). Append to the file and poll
// until the counter reaches the expected value or we time out.
async function waitForUpdates(
  updates: string[],
  expected: number,
  timeoutMs = 4000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline && updates.length < expected) {
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function triggerChange(filePath: string): Promise<void> {
  await appendFile(filePath, '\n');
}

describe('resources/subscribe — ResourceNotFoundError paths', () => {
  let tmpDir: string;
  let pathGuard: PathGuard;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fsmcp-sub-'));
    pathGuard = new PathGuard();
    await pathGuard.setRoots([tmpDir]);
    await writeFile(join(tmpDir, 'real.txt'), 'hello');
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('throws ResourceNotFoundError for an unknown URI scheme (no matching contract)', async () => {
    const { server, handlers } = buildMockServer();
    resourcesRegistrar.register({
      server: server as never,
      pathGuard,
      resourceStore: createInMemoryResourceStore(),
      isInitialized: () => true,
    });

    const handler = handlers.get('resources/subscribe');
    assert.ok(handler, 'subscribe handler must be registered');

    const ctx = { sessionId: 's1' } as unknown as ServerContext;
    await assert.rejects(
      () => handler({ params: { uri: 'http://example.com/nope' } }, ctx),
      (err: unknown) => err instanceof ResourceNotFoundError,
    );
  });

  it('throws ResourceNotFoundError when subscribing to a non-existent file', async () => {
    const { server, handlers } = buildMockServer();
    resourcesRegistrar.register({
      server: server as never,
      pathGuard,
      resourceStore: createInMemoryResourceStore(),
      isInitialized: () => true,
    });

    const handler = handlers.get('resources/subscribe');
    assert.ok(handler, 'subscribe handler must be registered');

    const ctx = { sessionId: 's2' } as unknown as ServerContext;
    const uri = fileUri(join(tmpDir, 'does-not-exist.txt'));
    await assert.rejects(
      () => handler({ params: { uri } }, ctx),
      (err: unknown) => err instanceof ResourceNotFoundError,
    );
  });

  it('succeeds when subscribing to an existing file', async () => {
    const { server, handlers } = buildMockServer();
    resourcesRegistrar.register({
      server: server as never,
      pathGuard,
      resourceStore: createInMemoryResourceStore(),
      isInitialized: () => true,
    });

    const handler = handlers.get('resources/subscribe');
    assert.ok(handler, 'subscribe handler must be registered');

    const ctx = { sessionId: 's3' } as unknown as ServerContext;
    const uri = fileUri(join(tmpDir, 'real.txt'));
    // Should not throw; returns {} on success.
    const result = await handler({ params: { uri } }, ctx);
    assert.deepEqual(result, {});
  });
});

describe('resources/subscribe — dedupe and leak', () => {
  let tmpDir: string;
  let pathGuard: PathGuard;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fsmcp-dedupe-'));
    pathGuard = new PathGuard();
    await pathGuard.setRoots([tmpDir]);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('fires exactly one update when the same file is subscribed twice then changed', async () => {
    const filePath = join(tmpDir, 'dedupe.txt');
    await writeFile(filePath, 'initial\n');
    const updates: string[] = [];
    const { server, handlers } = buildMockServer(updates);
    resourcesRegistrar.register({
      server: server as never,
      pathGuard,
      resourceStore: createInMemoryResourceStore(),
      isInitialized: () => true,
    });

    const handler = handlers.get('resources/subscribe');
    assert.ok(handler);
    const ctx = { sessionId: 'd1' } as unknown as ServerContext;
    const uri = fileUri(filePath);

    await handler({ params: { uri } }, ctx);
    // Second subscribe to the same uri: with single-callback dedupe this
    // overwrites (not appends to) the stored callback, so one change fires one
    // update, not two.
    await handler({ params: { uri } }, ctx);

    await triggerChange(filePath);
    await waitForUpdates(updates, 1);
    assert.equal(updates.length, 1, 'expected exactly one update for a deduped subscription');

    const unsubscribe = handlers.get('resources/unsubscribe');
    await unsubscribe?.({ params: { uri } }, ctx);
  });

  it('a failed subscribe leaves no callback that fires later', async () => {
    const failedPath = join(tmpDir, 'absent.txt');
    const okPath = join(tmpDir, 'present.txt');
    await writeFile(okPath, 'initial\n');
    const updates: string[] = [];
    const { server, handlers } = buildMockServer(updates);
    resourcesRegistrar.register({
      server: server as never,
      pathGuard,
      resourceStore: createInMemoryResourceStore(),
      isInitialized: () => true,
    });

    const handler = handlers.get('resources/subscribe');
    assert.ok(handler);
    const ctx = { sessionId: 'd2' } as unknown as ServerContext;

    // Failed subscribe: file does not exist yet → ResourceNotFoundError, and
    // must register no callback.
    await assert.rejects(
      () => handler({ params: { uri: fileUri(failedPath) } }, ctx),
      (err: unknown) => err instanceof ResourceNotFoundError,
    );

    // Successful subscribe to a different file.
    const okUri = fileUri(okPath);
    await handler({ params: { uri: okUri } }, ctx);

    // Changing the subscribed file fires exactly one update.
    await triggerChange(okPath);
    await waitForUpdates(updates, 1);
    assert.equal(updates.length, 1);

    // Creating and then changing the previously-absent file must not produce an
    // update — the failed subscribe attached no watcher and left no callback.
    await writeFile(failedPath, 'late\n');
    await triggerChange(failedPath);
    await waitForUpdates(updates, 2, 800);
    assert.equal(updates.length, 1, 'failed subscribe leaked a callback that fired later');

    const unsubscribe = handlers.get('resources/unsubscribe');
    await unsubscribe?.({ params: { uri: okUri } }, ctx);
  });
});
