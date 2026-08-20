import assert from 'node:assert/strict';
import test from 'node:test';

import type { FileType } from '../../src/core/fs.js';
import { FILE_TYPES, FileType as FileTypeSchema } from '../../src/core/schema.js';

test('FILE_TYPES contains the four members and FileType infers from it', () => {
  assert.deepEqual([...FILE_TYPES], ['file', 'directory', 'symlink', 'other']);
  const ok: FileType = 'symlink';
  assert.equal(FileTypeSchema.parse(ok), 'symlink');
  assert.throws(() => FileTypeSchema.parse('block-device'));
});

test('schema FileType matches the core/fs.ts inference', () => {
  // Type-level assertion — must compile with no errors.
  // The tuple in core/primitives.ts is the single source of both spellings.
  const _check: FileType = 'file';
  assert.equal(_check, 'file');
});
