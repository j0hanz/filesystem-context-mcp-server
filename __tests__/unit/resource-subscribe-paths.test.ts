import { ResourceNotFoundError, type ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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
    sendResourceUpdated: () => Promise<void>;
  };
}

function buildMockServer(): { server: MockServer; handlers: Map<string, RequestHandler> } {
  const handlers = new Map<string, RequestHandler>();
  const server: MockServer = {
    registerResource: () => {
      /* no-op: we only care about the subscribe request handler */
    },
    server: {
      setRequestHandler: (name, handler) => {
        handlers.set(name, handler);
      },
      sendResourceUpdated: async () => {
        /* no-op */
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
    const { rm } = await import('node:fs/promises');
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
