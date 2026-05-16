import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileType } from '../../src/core/fs.js';
import { FILE_TYPES, FileType as FileTypeSchema } from '../../src/schema.js';

test('FILE_TYPES contains the four members and FileType infers from it', () => {
  assert.deepEqual([...FILE_TYPES], ['file', 'directory', 'symlink', 'other']);
  const ok: FileType = 'symlink';
  assert.equal(FileTypeSchema.parse(ok), 'symlink');
  assert.throws(() => FileTypeSchema.parse('block-device'));
});

test('core/fs.ts FileType matches the Zod-derived inference', () => {
  // Type-level assertion — must compile with no errors.
  const _check: FileType = 'file';
  assert.equal(_check, 'file');
});
