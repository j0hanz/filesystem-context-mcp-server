import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { ErrorCode, McpError } from '../../src/lib/errors.js';
import { createInMemoryResourceStore } from '../../src/lib/resource-store.js';

test('putBlob stores and getBlob retrieves binary data correctly', () => {
  const store = createInMemoryResourceStore();
  const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]); // PNG header
  const entry = store.putBlob({
    name: 'test.png',
    mimeType: 'image/png',
    data: binaryData,
  });

  assert.strictEqual(entry.uri.startsWith('filesystem-mcp://result/'), true);
  assert.strictEqual(entry.name, 'test.png');
  assert.strictEqual(entry.mimeType, 'image/png');
  assert.deepStrictEqual(entry.data, binaryData);
  assert.strictEqual(entry.size, binaryData.length);

  const retrieved = store.getBlob(entry.uri);
  assert.strictEqual(retrieved.uri, entry.uri);
  assert.deepStrictEqual(retrieved.data, binaryData);
});

test('putBlob deduplicates identical content', () => {
  const store = createInMemoryResourceStore();
  const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

  const entry1 = store.putBlob({
    name: 'image1.png',
    mimeType: 'image/png',
    data: binaryData,
  });

  const entry2 = store.putBlob({
    name: 'image2.png',
    mimeType: 'image/png',
    data: binaryData,
  });

  // Identical content should return the same URI (deduplication)
  assert.strictEqual(entry1.uri, entry2.uri);
  assert.strictEqual(entry1.hash, entry2.hash);
});

test('getBlob throws when called on a text URI', () => {
  const store = createInMemoryResourceStore();
  const textEntry = store.putText({
    name: 'test.txt',
    mimeType: 'text/plain',
    text: 'Hello, World!',
  });

  assert.throws(
    () => {
      store.getBlob(textEntry.uri);
    },
    (err) => {
      assert(err instanceof McpError);
      assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
      return true;
    },
  );
});

test('getText throws when called on a blob URI', () => {
  const store = createInMemoryResourceStore();
  const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const blobEntry = store.putBlob({
    name: 'test.png',
    mimeType: 'image/png',
    data: binaryData,
  });

  assert.throws(
    () => {
      store.getText(blobEntry.uri);
    },
    (err) => {
      assert(err instanceof McpError);
      assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
      return true;
    },
  );
});

test('Default TTL is 60 seconds', () => {
  const store = createInMemoryResourceStore();
  const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const entry = store.putBlob({
    name: 'test.png',
    mimeType: 'image/png',
    data: binaryData,
  });

  const storedAt = new Date(entry.storedAt).getTime();
  const expiresAt = new Date(entry.expiresAt).getTime();
  const ttlMs = expiresAt - storedAt;

  // Allow a 100ms tolerance for execution time
  assert.strictEqual(ttlMs >= 59900 && ttlMs <= 60100, true);
});

test('putText with same data still stores as text kind', () => {
  const store = createInMemoryResourceStore();
  const textEntry = store.putText({
    name: 'test.txt',
    mimeType: 'text/plain',
    text: 'Hello, World!',
  });

  // Should be retrievable as text
  const retrieved = store.getText(textEntry.uri);
  assert.strictEqual(retrieved.text, 'Hello, World!');

  // Should throw when accessed as blob
  assert.throws(() => store.getBlob(textEntry.uri), McpError);
});

test('putBlob rejects data larger than maxEntryBytes', () => {
  const store = createInMemoryResourceStore({
    maxEntryBytes: 100,
  });

  const largeBinaryData = Buffer.alloc(200);

  assert.throws(
    () => {
      store.putBlob({
        name: 'large.bin',
        mimeType: 'application/octet-stream',
        data: largeBinaryData,
      });
    },
    (err) => {
      assert(err instanceof McpError);
      assert.strictEqual(err.code, ErrorCode.TOO_LARGE);
      return true;
    },
  );
});

test('getBlob expires after TTL', () => {
  const store = createInMemoryResourceStore({
    entryTtlMs: 100, // 100ms TTL for testing
  });

  const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const entry = store.putBlob({
    name: 'test.png',
    mimeType: 'image/png',
    data: binaryData,
  });

  // Entry should be retrievable immediately
  const retrieved = store.getBlob(entry.uri);
  assert.strictEqual(retrieved.uri, entry.uri);

  // Use a timeout to check the error was thrown
  return new Promise<void>((resolve) => {
    setTimeout(() => {
      try {
        store.getBlob(entry.uri);
        assert.fail('Should have thrown expired error');
      } catch (err) {
        assert(err instanceof McpError);
        assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
        resolve();
      }
    }, 150);
  });
});
