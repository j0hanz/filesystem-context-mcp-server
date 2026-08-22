import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { setTimeout } from 'node:timers/promises';

import { buildFileResourceUri } from '../src/core/file-uri.js';
import { cleanupTestRoot, createTestClientPair, createTestRoot, writeTestFile } from './helpers.js';

describe('Resource subscriptions round-trip', () => {
  let tmpDir: string;
  let pair: Awaited<ReturnType<typeof createTestClientPair>>;

  before(async () => {
    tmpDir = await createTestRoot();
    pair = await createTestClientPair([tmpDir]);
    await writeTestFile(tmpDir, 'watch.txt', 'initial');
  });

  after(async () => {
    await pair.close();
    await cleanupTestRoot(tmpDir);
  });

  it('subscribe -> file modification -> notification -> unsubscribe', async () => {
    const filePath = join(tmpDir, 'watch.txt');
    const uri = buildFileResourceUri(filePath);
    let received: string | undefined;

    pair.client.setNotificationHandler('notifications/resources/updated', (n) => {
      received = (n.params as { uri: string }).uri;
    });

    await pair.client.subscribeResource({ uri });

    // Trigger file modification
    await writeFile(filePath, 'changed');

    // Poll for the debounced notification (50ms debounce)
    const deadline = Date.now() + 2000;
    while (!received && Date.now() < deadline) {
      await setTimeout(20);
    }

    assert.strictEqual(received, uri, 'Expected notification with matching uri before 2s deadline');

    // Reset and unsubscribe
    received = undefined;
    await pair.client.unsubscribeResource({ uri });

    // Trigger second modification
    await writeFile(filePath, 'changed-again');

    // Short poll to confirm no notification arrives after unsubscribe
    const unsubscribeDeadline = Date.now() + 300;
    while (!received && Date.now() < unsubscribeDeadline) {
      await setTimeout(20);
    }

    assert.strictEqual(received, undefined, 'Should not receive notification after unsubscribe');
  });
});
