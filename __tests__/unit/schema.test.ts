import assert from 'node:assert/strict';
import test from 'node:test';

import * as z from 'zod/v4';

import {
  createReadRangeFields,
  defaultFalseBoolean,
  FILE_KINDS,
  FileKind,
} from '../../src/core/schema.js';

test('FILE_KINDS contains the five expected members', () => {
  assert.deepEqual([...FILE_KINDS], ['text', 'binary', 'image', 'audio', 'pdf']);
});

test('FileKind parses valid kinds and rejects invalid ones', () => {
  assert.equal(FileKind.parse('text'), 'text');
  assert.equal(FileKind.parse('binary'), 'binary');
  assert.equal(FileKind.parse('image'), 'image');
  assert.equal(FileKind.parse('audio'), 'audio');
  assert.equal(FileKind.parse('pdf'), 'pdf');
  assert.throws(() => FileKind.parse('invalid-kind'));
});

test('defaultFalseBoolean parses boolean correctly', () => {
  const schema = defaultFalseBoolean('test description');
  assert.equal(schema.parse(undefined), false);
  assert.equal(schema.parse(true), true);
  assert.equal(schema.parse(false), false);
  assert.throws(() => schema.parse('true'));
  assert.throws(() => schema.parse(null));
});

test('createReadRangeFields startLine/endLine validation limits', () => {
  const fields = createReadRangeFields({
    head: 'head',
    tail: 'tail',
    startLine: 'startLine',
    endLine: 'endLine',
  });

  const rangeSchema = z.strictObject({
    startLine: fields.startLine,
    endLine: fields.endLine,
  });

  // Valid values (up to 100,000) should parse successfully
  const valid = rangeSchema.parse({ startLine: 100000, endLine: 100000 });
  assert.equal(valid.startLine, 100000);
  assert.equal(valid.endLine, 100000);

  // Values exceeding 100,000 should throw validation errors
  assert.throws(() => rangeSchema.parse({ startLine: 100001 }));
  assert.throws(() => rangeSchema.parse({ endLine: 100001 }));

  // Values below 1 should throw validation errors
  assert.throws(() => rangeSchema.parse({ startLine: 0 }));
  assert.throws(() => rangeSchema.parse({ endLine: 0 }));
});
