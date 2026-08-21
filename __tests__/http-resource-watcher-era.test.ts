// Modern (2026-07-28) file-watch notifications. A modern client opens a
// `subscriptions/listen` stream filtered by `resourceSubscriptions: [uri]`; the
// server has no SDK hook to read that filter (the listen router is SDK-owned),
// so transport.ts attaches an idempotent FS watcher per requested URI at the
// era-branch and publishes `resource_updated` onto the shared bus. The router
// narrows per stream. This test proves the end-to-end path: listen -> modify ->
// `notifications/resources/updated` arrives with the matching URI.
//
// The prior (deleted) attempt used `client.subscribeResource`, which the client
// SDK blocks on a modern connection (`METHOD_NOT_SUPPORTED_BY_PROTOCOL_VERSION`).
// `client.listen` is the modern API a client actually sends, so this is the
// faithful guard.
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.js';
import { startHttpServer } from '../src/transport.js';

function getServerPort(server: Server): number {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected HTTP server to listen on a TCP port');
  }
  return address.port;
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

describe('HTTP resource watcher (2026 modern leg)', () => {
  const servers: Server[] = [];
  const clients: Client[] = [];
  let tempDir: string | undefined;

  afterEach(async () => {
    while (clients.length > 0) {
      const client = clients.pop();
      if (!client) continue;
      await client.close().catch(() => {
        /* transport already gone */
      });
    }
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
  });

  it('delivers notifications/resources/updated for a subscribed file change', async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-watch-'));
    const watchedFile = join(tempDir, 'watched.txt');
    await writeFile(watchedFile, 'v1\n', 'utf8');

    const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
    servers.push(server);
    const port = getServerPort(server);

    // Modern client: versionNegotiation mode 'auto' probes with server/discover
    // and lands on the modern revision. The shared watcher registry + bus are
    // scoped to this server's modern leg.
    const client = new Client(
      { name: 'modern-watch-test', version: '1.0.0' },
      { versionNegotiation: { mode: 'auto' } },
    );
    clients.push(client);
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(port)}/mcp`),
    );
    await client.connect(transport);
    assert.equal(client.getProtocolEra(), 'modern');

    // The filesystem resource is a template (list: undefined), so a client
    // derives the concrete URI from the template + a known path. buildFileResourceUri
    // produces the exact `filesystem-mcp://file/{+path}` form the server validates.
    const fileUri = buildFileResourceUri(watchedFile);

    let receivedUri: string | undefined;
    client.setNotificationHandler('notifications/resources/updated', (notification) => {
      receivedUri = notification.params.uri;
    });

    // Opening the listen stream is what carries resourceSubscriptions to the
    // server; transport.ts reads it off the parsed body and attaches the watcher.
    await client.listen({ resourceSubscriptions: [fileUri] });

    // Give the watcher a moment to settle, then mutate the file. The registry
    // debounces notify callbacks by 50ms before publishing to the bus.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await writeFile(watchedFile, 'v2\n', 'utf8');

    // Poll for the notification (debounce + SSE delivery), with a hard ceiling.
    const deadline = Date.now() + 3000;
    while (receivedUri === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    assert.equal(
      receivedUri,
      fileUri,
      'modern listen stream should receive notifications/resources/updated for the changed file',
    );
  });
});
