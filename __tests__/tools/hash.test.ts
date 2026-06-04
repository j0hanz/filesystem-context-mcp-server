/**
 * Integration tests for calculate_hash and diff_files tools.
 */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { z } from 'zod/v4';

import { HashesSchema, HashOutputSchema } from '../../src/tools/calculate-hash.js';
import {
  assertOk,
  assertToolError,
  createTestEnv,
  getStructured,
  type TestEnv,
} from '../helpers.js';

describe('calculate_hash tool', () => {
  let env: TestEnv;
  let file: string;

  before(async () => {
    env = await createTestEnv();
    file = join(env.tmpDir, 'hash-me.txt');
    await writeFile(file, 'deterministic content\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('calculates file hash and stores in resource', async () => {
    const raw = await env.client.callTool({
      name: 'hash_file',
      arguments: { path: file },
    });
    assertOk(raw);
    const sc = getStructured(raw);

    // Verify structured content
    assert.equal(typeof sc['filePath'], 'string');
    assert(sc['filePath'].includes('hash-me.txt'));
    assert.deepEqual(sc['algorithms'], ['sha256']);
    assert(typeof sc['hashes'] === 'object');
    assert.equal(typeof sc['hashes']['sha256'], 'string');
    assert.ok((sc['hashes']['sha256'] as string).length > 0);
    assert.equal(sc['isDirectory'], false);
    assert.equal(typeof sc['resourceUri'], 'string');
    assert((sc['resourceUri'] as string).startsWith('filesystem-mcp://result/'));

    // Verify summary contains file name and algorithm
    const summary = raw.content[0];
    assert(summary && 'text' in summary);
    const text = (summary as { type: string; text: string }).text;
    assert(text.includes('hash-me.txt'));
    assert(text.includes('SHA-256'));
    assert(text.includes(':'));

    // Verify resource link
    const resourceLink = raw.content.find((c) => c && 'type' in c && c.type === 'resource_link');
    assert(resourceLink, 'Should have a resource_link');
    assert.equal((resourceLink as { name: string }).name, 'hash-me.txt');
  });

  it('calculate-hash with multiple algorithms', async () => {
    const raw = await env.client.callTool({
      name: 'hash_file',
      arguments: { path: file, algorithms: ['sha256', 'md5'] },
    });
    assertOk(raw);
    const sc = getStructured(raw);

    // Verify both algorithms are computed
    assert.deepEqual(sc['algorithms'], ['sha256', 'md5']);
    assert.equal(typeof sc['hashes']['sha256'], 'string');
    assert.equal(typeof sc['hashes']['md5'], 'string');
    assert.ok((sc['hashes']['sha256'] as string).length > 0);
    assert.ok((sc['hashes']['md5'] as string).length > 0);

    // Verify summary shows primary algorithm (sha256)
    const summary = raw.content[0];
    assert(summary && 'text' in summary);
    const text = (summary as { type: string; text: string }).text;
    assert(text.includes('SHA-256'));

    // Verify resource link still present
    const resourceLink = raw.content.find((c) => c && 'type' in c && c.type === 'resource_link');
    assert(resourceLink, 'Should have a resource_link');
  });

  it('returns the same hash for identical content', async () => {
    const file2 = join(env.tmpDir, 'hash-copy.txt');
    await writeFile(file2, 'deterministic content\n', 'utf8');

    const raw1 = await env.client.callTool({
      name: 'hash_file',
      arguments: { path: file },
    });
    const raw2 = await env.client.callTool({
      name: 'hash_file',
      arguments: { path: file2 },
    });

    const sc1 = getStructured(raw1);
    const sc2 = getStructured(raw2);
    assert.equal(
      sc1['hashes']['sha256'],
      sc2['hashes']['sha256'],
      'Same content should produce same hash',
    );
  });

  it('returns a different hash after file content changes', async () => {
    const mutable = join(env.tmpDir, 'mutable.txt');
    await writeFile(mutable, 'version 1', 'utf8');
    const r1 = getStructured(
      await env.client.callTool({
        name: 'hash_file',
        arguments: { path: mutable },
      }),
    );
    await writeFile(mutable, 'version 2', 'utf8');
    const r2 = getStructured(
      await env.client.callTool({
        name: 'hash_file',
        arguments: { path: mutable },
      }),
    );
    assert.notEqual(
      r1['hashes']['sha256'],
      r2['hashes']['sha256'],
      'Different content should produce different hash',
    );
  });

  it('returns isDirectory:true and fileCount for a directory', async () => {
    const raw = await env.client.callTool({
      name: 'hash_file',
      arguments: { path: env.tmpDir },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['isDirectory'], true);
    assert.equal(typeof sc['fileCount'], 'number');
    assert.equal(sc['algorithms'][0], 'sha256');
    assert.equal(typeof sc['hashes']['sha256'], 'string');
  });

  it('rejects a non-sha256 algorithm requested for a directory', async () => {
    // Directory hashing is sha256-only; requesting another algorithm must error
    // rather than silently returning a SHA-256 digest mislabeled as the request.
    const raw = await env.client.callTool({
      name: 'hash_file',
      arguments: { path: env.tmpDir, algorithms: ['sha512'] },
    });
    assertToolError(raw, 'INVALID_INPUT');
  });

  it('excludes sensitive files from directory hashing', async () => {
    const dir = join(env.tmpDir, 'sensitive-dir');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'data.txt'), 'public content\n', 'utf8');

    const before = getStructured(
      await env.client.callTool({ name: 'hash_file', arguments: { path: dir } }),
    );

    // `server.key` matches the default `*.key` denylist and is NOT hidden, so
    // without the sensitive-file skip it would be folded into the composite hash.
    await writeFile(join(dir, 'server.key'), 'PRIVATE KEY MATERIAL\n', 'utf8');

    const after = getStructured(
      await env.client.callTool({ name: 'hash_file', arguments: { path: dir } }),
    );

    assert.equal(after['fileCount'], before['fileCount'], 'sensitive file must not be counted');
    assert.equal(
      (after['hashes'] as Record<string, string>)['sha256'],
      (before['hashes'] as Record<string, string>)['sha256'],
      'sensitive file content must not affect the directory hash',
    );
  });

  it('returns NOT_FOUND for a missing path', async () => {
    const raw = await env.client.callTool({
      name: 'hash_file',
      arguments: { path: join(env.tmpDir, 'ghost.txt') },
    });
    assertToolError(raw, 'NOT_FOUND');
  });
});

describe('HashOutputSchema validation', () => {
  it('rejects non-hex digest in hashes', async () => {
    // Test 1: Valid hash should pass
    const validOutput = {
      ok: true,
      filePath: '/some/path',
      algorithms: ['sha256'],
      hashes: {
        sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
      },
      resourceUri: 'filesystem-mcp://result/123',
      isDirectory: false,
    };
    const result1 = HashOutputSchema.safeParse(validOutput);
    assert.equal(result1.success, true, 'Valid hash should pass');

    // Test 2: Non-hex digest should fail
    const invalidHexOutput = {
      ok: true,
      filePath: '/some/path',
      algorithms: ['sha256'],
      hashes: {
        sha256: 'not-a-valid-hex-string',
      },
      resourceUri: 'filesystem-mcp://result/123',
      isDirectory: false,
    };
    const result2 = HashOutputSchema.safeParse(invalidHexOutput);
    assert.equal(result2.success, false, 'Non-hex digest should fail');

    // Test 3: Digest with wrong length is now allowed at schema level (checked at runtime)
    const wrongLengthOutput = {
      ok: true,
      filePath: '/some/path',
      algorithms: ['sha256'],
      hashes: {
        sha256: 'abcd1234', // Too short for SHA256
      },
      resourceUri: 'filesystem-mcp://result/123',
      isDirectory: false,
    };
    const result3 = HashOutputSchema.safeParse(wrongLengthOutput);
    assert.equal(
      result3.success,
      true,
      'Schema validates shape/hex format; length is enforced at runtime in handleCalculateHash',
    );
  });

  it('rejects uppercase hex digest', () => {
    // 64-char valid sha256 but uppercase — currently passes due to /i flag bug
    const result = HashesSchema.safeParse({
      sha256: 'E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855',
    });
    assert.equal(result.success, false, 'Uppercase hex should be rejected');
    assert.ok(
      result.error?.issues.some((i) => i.message === 'Must be lowercase hex string'),
      'Expected "Must be lowercase hex string" in issues',
    );
  });
});

describe('HashesSchema JSON Schema constraints', () => {
  it('output schema constrains hashes keys to SUPPORTED_ALGORITHMS enum', (): void => {
    const json = z.toJSONSchema(HashOutputSchema, {
      io: 'input',
      unrepresentable: 'any',
    }) as Record<string, unknown>;

    const props = json['properties'] as Record<string, unknown>;
    assert.ok(props, 'outputSchema has properties');
    const hashesSchema = props['hashes'] as Record<string, unknown>;
    assert.ok(hashesSchema, 'hashes property exists');

    // z.record(z.enum(...), ...) should produce a propertyNames.enum constraint
    assert.ok(
      'propertyNames' in hashesSchema,
      'hashes JSON Schema must have propertyNames constraint from z.record(z.enum(...))',
    );
    const propNames = hashesSchema['propertyNames'] as Record<string, unknown>;
    assert.ok('enum' in propNames, 'propertyNames should carry an enum array');
    const enumValues = (propNames['enum'] as string[]).slice().sort();
    assert.deepEqual(
      enumValues,
      ['md5', 'sha1', 'sha256', 'sha512'],
      'enum should list all four supported algorithms',
    );
  });
});

// (diff_files removed)
