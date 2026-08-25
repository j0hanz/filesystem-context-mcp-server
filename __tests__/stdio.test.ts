import type { McpSubscription } from '@modelcontextprotocol/client';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.js';
import { ALL_REGISTERED_TOOL_NAMES } from '../src/tools/index.js';
import {
  cleanupTestRoot,
  createStdioClient,
  createTestRoot,
  firstTextBlock,
  waitFor,
  writeTestFile,
} from './helpers.js';

describe('Stdio Transport (real subprocess)', () => {
  let tmpDir: string;
  let harness: Awaited<ReturnType<typeof createStdioClient>>;
  const subscriptions: McpSubscription[] = [];

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createStdioClient(tmpDir);
  });

  after(async () => {
    for (const s of subscriptions) await s.close().catch(() => {});
    if (harness) await harness.close();
    if (tmpDir) await cleanupTestRoot(tmpDir);
  });

  it('STDIO-001: lists all tools over a real stdio subprocess', async () => {
    const tools = await harness.client.listTools();
    assert.strictEqual(tools.tools.length, ALL_REGISTERED_TOOL_NAMES.length);
  });

  it('STDIO-002: reads a file over a real stdio subprocess', async () => {
    const filePath = await writeTestFile(tmpDir, 'stdio.txt', 'stdio content');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });
    assert.notStrictEqual(result.isError, true);
    assert.ok(firstTextBlock(result).text?.includes('stdio content'));
  });

  it('STDIO-003: subscriptions/listen delivers resource updates over stdio', async () => {
    // The SDK acknowledges the listen and routes outbound change notifications,
    // but attaches no watcher — the entry taps the wire for the inbound filter
    // so one gets attached. Without that tap this never fires.
    const filePath = await writeTestFile(tmpDir, 'listen.txt', 'initial');
    const uri = buildFileResourceUri(filePath);
    let received: string | undefined;

    harness.client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });

    subscriptions.push(await harness.client.listen({ resourceSubscriptions: [uri] }));
    await writeFile(filePath, 'changed');

    await waitFor(() => received !== undefined, 5000);
    assert.strictEqual(received, uri, 'the listen stream must receive the file-change update');
  });

  it('STDIO-004: re-listening on one URI registers one watcher callback, not one per listen', async () => {
    // Two open listen streams both match this URI, so the SDK router delivers
    // two notifications per change — that fan-out is expected. What must NOT
    // scale is the registry side: the notify sink is one closure per
    // connection, so the second listen re-registers the same callback and the
    // registry de-duplicates it by identity. A sink built per listen would
    // stack a second callback, each sending its own update through the same
    // two streams — 4 notifications, and an activeCallbacks set that grows
    // with every re-listen (MAX_WATCHERS caps watchers, not callbacks).
    const filePath = await writeTestFile(tmpDir, 'relisten.txt', 'initial');
    const uri = buildFileResourceUri(filePath);
    const streams = 2;
    let count = 0;

    harness.client.setNotificationHandler('notifications/resources/updated', (n) => {
      if ((n.params as { uri: string }).uri === uri) count += 1;
    });

    for (let i = 0; i < streams; i += 1) {
      subscriptions.push(await harness.client.listen({ resourceSubscriptions: [uri] }));
    }

    await writeFile(filePath, 'changed');
    await waitFor(() => count >= streams, 5000);
    // Settle past the registry's 50ms debounce so a stacked second callback
    // would have landed by now.
    await waitFor(() => count > streams, 500);

    assert.strictEqual(
      count,
      streams,
      'one change must yield one update per listen stream; more means a stacked notify callback',
    );
  });

  it('STDIO-005: rejects a missing filesystem resource before acknowledging the listen', async () => {
    const uri = buildFileResourceUri(join(tmpDir, 'missing-listen.txt'));

    await assert.rejects(
      harness.client.listen({ resourceSubscriptions: [uri] }),
      (err: unknown) => {
        assert.equal((err as { code?: unknown }).code, ProtocolErrorCode.InvalidParams);
        return true;
      },
    );
  });
});
