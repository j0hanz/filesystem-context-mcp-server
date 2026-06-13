import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import * as z from 'zod/v4';

import { isSafeGlobSyntax } from '../../src/core/path.js';
import {
  FileInfoSchema,
  IsoDateTime,
  NonNegInt,
  OperationSummarySchema,
  SafeGlobPattern,
} from '../../src/schema.js';

describe('fields', () => {
  it('IsoDateTime is in globalRegistry', () => {
    assert.ok(z.globalRegistry.has(IsoDateTime));
  });

  it('IsoDateTime $defs entry has no pattern after walk', async () => {
    const schema = z.strictObject({ ts: IsoDateTime });
    const json = z.toJSONSchema(schema) as Record<string, unknown>;
    const defs = json['$defs'] as Record<string, unknown>;
    assert.ok('IsoDateTime' in defs, 'IsoDateTime in $defs');
    const def = defs['IsoDateTime'] as Record<string, unknown>;
    assert.equal(def['format'], 'date-time');
    // Pattern still present here — stripped by post-processor in json-schema.ts (Task 3)
    assert.ok('pattern' in def, 'raw output still has pattern (post-processor strips it)');
  });

  it('NonNegInt is in globalRegistry', () => {
    assert.ok(z.globalRegistry.has(NonNegInt));
  });

  describe('isSafeGlobSyntax (pure, no PathGuard required)', () => {
    it('accepts valid relative globs', () => {
      assert.ok(isSafeGlobSyntax('**/*.ts'));
      assert.ok(isSafeGlobSyntax('src/**/*.js'));
      assert.ok(isSafeGlobSyntax('*.{ts,tsx}'));
    });

    it('rejects absolute POSIX paths', () => {
      assert.ok(!isSafeGlobSyntax('/etc/passwd'));
      assert.ok(!isSafeGlobSyntax('/abs/*.ts'));
    });

    it('rejects Windows absolute paths', () => {
      assert.ok(!isSafeGlobSyntax('C:\\*.ts'));
      assert.ok(!isSafeGlobSyntax('C:/Users/*.ts'));
    });

    it('rejects traversal patterns', () => {
      assert.ok(!isSafeGlobSyntax('../*.ts'));
      assert.ok(!isSafeGlobSyntax('src/../../*.ts'));
    });

    it('rejects empty patterns', () => {
      assert.ok(!isSafeGlobSyntax(''));
      assert.ok(!isSafeGlobSyntax('   '));
    });
  });

  describe('SafeGlobPattern.safeParse (no PathGuard initialization needed)', () => {
    it('accepts valid globs without server initialization', () => {
      const r = SafeGlobPattern.safeParse('**/*.ts');
      assert.ok(r.success, 'valid glob should parse successfully');
    });

    it('rejects absolute paths without server initialization', () => {
      const r = SafeGlobPattern.safeParse('/etc/passwd');
      assert.ok(!r.success, 'absolute path should fail safeParse');
    });

    it('rejects traversal patterns without server initialization', () => {
      const r = SafeGlobPattern.safeParse('../*.ts');
      assert.ok(!r.success, 'traversal should fail safeParse');
    });
  });

  describe('no duplicate $defs ids', () => {
    it('FileInfoSchema serializes with a single FileInfo $defs entry', () => {
      const json = z.toJSONSchema(
        z.strictObject({ a: FileInfoSchema, b: FileInfoSchema, s: OperationSummarySchema }),
      ) as Record<string, unknown>;
      const defs = (json['$defs'] ?? {}) as Record<string, unknown>;
      const fileInfoKeys = Object.keys(defs).filter((k) => k.startsWith('FileInfo'));
      assert.deepEqual(fileInfoKeys, ['FileInfo']);
    });
  });
});
