import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

// Define the schema locally for testing (matches src/server.ts)
const RootSchema = z.strictObject({
  uri: z.string().startsWith('file://', { message: "Root.uri must start with 'file://'" }),
  name: z.string().optional(),
});

const RootsResponseSchema = z.strictObject({
  roots: z.array(RootSchema).optional(),
});

describe('RootSchema validation', () => {
  describe('valid file:// URIs', () => {
    it('accepts file:// with absolute path', () => {
      const result = RootSchema.safeParse({ uri: 'file:///path/to/dir' });
      assert.ok(result.success, 'Should accept file:///path/to/dir');
      assert.deepStrictEqual(result.data, { uri: 'file:///path/to/dir' });
    });

    it('accepts file:// with relative path components', () => {
      const result = RootSchema.safeParse({ uri: 'file://localhost/path' });
      assert.ok(result.success, 'Should accept file://localhost/path');
      assert.deepStrictEqual(result.data, { uri: 'file://localhost/path' });
    });

    it('accepts file:// URI with name', () => {
      const result = RootSchema.safeParse({ uri: 'file:///home/user/project', name: 'My Project' });
      assert.ok(result.success, 'Should accept file:// URI with name');
      assert.deepStrictEqual(result.data, {
        uri: 'file:///home/user/project',
        name: 'My Project',
      });
    });

    it('accepts file:// URI with Windows-style path', () => {
      const result = RootSchema.safeParse({ uri: 'file:///C:/Users/user/project' });
      assert.ok(result.success, 'Should accept Windows-style file URI');
      assert.deepStrictEqual(result.data, { uri: 'file:///C:/Users/user/project' });
    });

    it('accepts file:// URI with special characters in path', () => {
      const result = RootSchema.safeParse({ uri: 'file:///path/to/dir%20with%20spaces' });
      assert.ok(result.success, 'Should accept file:// URI with encoded special chars');
      assert.deepStrictEqual(result.data, { uri: 'file:///path/to/dir%20with%20spaces' });
    });
  });

  describe('invalid non-file:// URIs', () => {
    it('rejects URI without prefix', () => {
      const result = RootSchema.safeParse({ uri: '/path/to/dir' });
      assert.ok(!result.success, 'Should reject URI without file:// prefix');
      assert.ok(result.error?.issues.length > 0, 'Should have validation errors');
    });

    it('rejects http:// URI', () => {
      const result = RootSchema.safeParse({ uri: 'http://example.com/path' });
      assert.ok(!result.success, 'Should reject http:// URI');
      assert.ok(result.error?.issues.length > 0, 'Should have validation errors');
    });

    it('rejects https:// URI', () => {
      const result = RootSchema.safeParse({ uri: 'https://example.com/path' });
      assert.ok(!result.success, 'Should reject https:// URI');
      assert.ok(result.error?.issues.length > 0, 'Should have validation errors');
    });

    it('rejects empty string', () => {
      const result = RootSchema.safeParse({ uri: '' });
      assert.ok(!result.success, 'Should reject empty string');
    });

    it('rejects relative path without file:// prefix', () => {
      const result = RootSchema.safeParse({ uri: './relative/path' });
      assert.ok(!result.success, 'Should reject relative path without file:// prefix');
    });

    it('rejects ftp:// URI', () => {
      const result = RootSchema.safeParse({ uri: 'ftp://server/path' });
      assert.ok(!result.success, 'Should reject ftp:// URI');
    });
  });

  describe('RootsResponseSchema with array of roots', () => {
    it('accepts array of valid file:// URIs', () => {
      const result = RootsResponseSchema.safeParse({
        roots: [{ uri: 'file:///path/1' }, { uri: 'file:///path/2', name: 'Second Root' }],
      });
      assert.ok(result.success, 'Should accept array of valid roots');
      assert.deepStrictEqual(result.data.roots?.length, 2);
    });

    it('filters out roots with invalid URIs via safeParse', () => {
      const result = RootsResponseSchema.safeParse({
        roots: [{ uri: 'file:///valid/path' }, { uri: '/invalid/path' }],
      });
      // safeParse will fail the entire parse since one element is invalid
      assert.ok(!result.success, 'Should fail parse when any root has invalid URI');
    });

    it('accepts empty roots array', () => {
      const result = RootsResponseSchema.safeParse({ roots: [] });
      assert.ok(result.success, 'Should accept empty roots array');
      assert.deepStrictEqual(result.data.roots, []);
    });

    it('accepts response with no roots key', () => {
      const result = RootsResponseSchema.safeParse({});
      assert.ok(result.success, 'Should accept response with missing roots key');
      assert.strictEqual(result.data.roots, undefined);
    });
  });

  describe('extractRoots integration (safeParse behavior)', () => {
    function isRoot(value: unknown): value is { uri: string; name?: string } {
      return (
        typeof value === 'object' &&
        value !== null &&
        typeof (value as Record<string, unknown>)['uri'] === 'string'
      );
    }

    function extractRoots(value: unknown): { uri: string; name?: string }[] {
      const parsed = RootsResponseSchema.safeParse(value);
      if (!parsed.success || !parsed.data.roots) {
        return [];
      }
      const roots: { uri: string; name?: string }[] = [];
      for (const root of parsed.data.roots) {
        if (isRoot(root)) {
          roots.push(root);
        }
      }
      return roots;
    }

    it('returns empty array for invalid response', () => {
      const result = extractRoots({ roots: [{ uri: '/invalid' }] });
      assert.deepStrictEqual(result, [], 'Should return empty array for invalid URIs');
    });

    it('returns empty array for response with no roots', () => {
      const result = extractRoots({});
      assert.deepStrictEqual(result, [], 'Should return empty array when roots missing');
    });

    it('returns empty array for null value', () => {
      const result = extractRoots(null);
      assert.deepStrictEqual(result, [], 'Should return empty array for null input');
    });

    it('returns valid roots from valid response', () => {
      const result = extractRoots({
        roots: [{ uri: 'file:///path/1', name: 'First' }, { uri: 'file:///path/2' }],
      });
      assert.deepStrictEqual(result.length, 2);
      assert.deepStrictEqual(result[0], { uri: 'file:///path/1', name: 'First' });
      assert.deepStrictEqual(result[1], { uri: 'file:///path/2' });
    });
  });

  describe('error messages', () => {
    it('provides clear error message when URI is missing file:// prefix', () => {
      const result = RootSchema.safeParse({ uri: '/home/user' });
      assert.ok(!result.success);
      const errorMessage = result.error?.issues[0]?.message;
      assert.ok(errorMessage?.includes("'file://'"), 'Error message should mention file:// prefix');
    });
  });
});
