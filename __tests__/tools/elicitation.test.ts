// __tests__/tools/elicitation.test.ts (new file)
import assert from 'node:assert/strict';
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  assertToolError,
  createTestEnv,
  createTestEnvWithElicitation,
  type TestEnv,
} from '../helpers.js';

// ─── rm: backward-compat (no elicitation capability) ─────────────────────────

describe('delete: client without elicitation capability', () => {
  let env: TestEnv;
  let dir: string;

  before(async () => {
    env = await createTestEnv();
    dir = join(env.tmpDir, 'to-delete');
    await mkdir(dir);
    await writeFile(join(dir, 'file.txt'), 'content');
  });

  after(async () => {
    await env.cleanup();
  });

  it('deletes directory immediately without elicitation when capability absent', async () => {
    const result = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [dir], recursive: true },
    });
    assertOk(result);
    // Directory must be gone
    await assert.rejects(readdir(dir), { code: 'ENOENT' });
  });
});

// ─── rm: client declines elicitation ─────────────────────────────────────────

describe('delete: client declines elicitation', () => {
  let env: TestEnv;
  let dir: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'decline' as const,
    }));
    dir = join(env.tmpDir, 'guarded-dir');
    await mkdir(dir);
    await writeFile(join(dir, 'file.txt'), 'content');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns success without deleting when user declines', async () => {
    const result = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [dir], recursive: true },
    });
    assertOk(result);
    const sc = (result as { structuredContent?: { ok?: unknown } }).structuredContent;
    assert.equal((sc as { ok: unknown } | undefined)?.ok, false);
    assert.equal((sc as { path?: unknown } | undefined)?.path, undefined);
    assert.equal((sc as { paths?: unknown } | undefined)?.paths, undefined);
    const failures = (sc as { failures?: { error?: { code?: unknown } }[] } | undefined)?.failures;
    assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 cancellation failure');
    assert.equal(failures?.[0]?.error?.code, 'CANCELLED');
    // Directory must still exist
    const entries = await readdir(dir);
    assert.ok(entries.length > 0, 'directory contents must be intact after decline');
  });
});

// ─── rm: client accepts elicitation ──────────────────────────────────────────

describe('delete: client accepts elicitation', () => {
  let env: TestEnv;
  let dir: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));
    dir = join(env.tmpDir, 'accept-dir');
    await mkdir(dir);
    await writeFile(join(dir, 'file.txt'), 'content');
  });

  after(async () => {
    await env.cleanup();
  });

  it('deletes directory when user accepts elicitation', async () => {
    const result = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [dir], recursive: true },
    });
    assertOk(result);
    await assert.rejects(readdir(dir), { code: 'ENOENT' });
  });

  it('refuses to delete a directory swapped during the confirmation gap', async () => {
    // holder dodges definite-assignment: the handler closes over the path
    // before it is bound to swapEnv.tmpDir (which does not exist yet).
    const holder: { dir: string } = { dir: '' };
    const swapEnv = await createTestEnvWithElicitation(async () => {
      // Swap fires between the pre-elicitation lstat and the post-elicitation
      // re-stat: drop the original dir, recreate the same path with a marker.
      // Same type (directory), different inode/birthtimeMs.
      await rm(holder.dir, { recursive: true, force: true });
      await mkdir(holder.dir);
      await writeFile(join(holder.dir, 'marker.txt'), 'survivor');
      return { action: 'accept' as const, content: { confirm: true } };
    });
    try {
      holder.dir = join(swapEnv.tmpDir, 'swap-dir');
      await mkdir(holder.dir);
      await writeFile(join(holder.dir, 'original.txt'), 'content');

      const result = await swapEnv.client.callTool({
        name: 'delete',
        arguments: { paths: [holder.dir], recursive: true },
      });
      const sc = (result as { structuredContent?: { ok?: unknown } }).structuredContent;
      assert.equal((sc as { ok: unknown } | undefined)?.ok, false, 'swap must abort the delete');
      const failures = (sc as { failures?: { error?: { code?: unknown } }[] } | undefined)
        ?.failures;
      assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 failure');
      assert.equal(failures?.[0]?.error?.code, 'INVALID_INPUT');
      const entries = await readdir(holder.dir);
      assert.ok(
        entries.includes('marker.txt'),
        'swapped marker must survive — performDeletion never ran on the replaced content',
      );
    } finally {
      await swapEnv.cleanup();
    }
  });
});

// ─── mv: backward-compat (no elicitation capability) ─────────────────────────

describe('move: client without elicitation capability', () => {
  let env: TestEnv;
  let src: string;
  let dest: string;

  before(async () => {
    env = await createTestEnv();
    src = join(env.tmpDir, 'src.txt');
    dest = join(env.tmpDir, 'dest.txt');
    await writeFile(src, 'source content');
    await writeFile(dest, 'original dest');
  });

  after(async () => {
    await env.cleanup();
  });

  it('overwrites destination immediately when capability absent', async () => {
    const result = await env.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: dest }] },
    });
    assertOk(result);
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(dest, 'utf8'), 'source content');
  });
});

// ─── mv: client declines when destination would be overwritten ────────────────

describe('move: client declines elicitation (destination exists)', () => {
  let env: TestEnv;
  let src: string;
  let dest: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'decline' as const,
    }));
    src = join(env.tmpDir, 'mv-src.txt');
    dest = join(env.tmpDir, 'mv-dest.txt');
    await writeFile(src, 'new content');
    await writeFile(dest, 'original dest');
  });

  after(async () => {
    await env.cleanup();
  });

  it('returns CANCELLED error without moving when user declines overwrite', async () => {
    const result = await env.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: dest }] },
    });
    assertToolError(result, 'CANCELLED');
    const { readFileSync } = await import('node:fs');
    // destination unchanged
    assert.equal(readFileSync(dest, 'utf8'), 'original dest');
    // source still present
    assert.equal(readFileSync(src, 'utf8'), 'new content');
  });
});

// ─── mv: client accepts overwrite ────────────────────────────────────────────

describe('move: client accepts elicitation (destination exists)', () => {
  let env: TestEnv;
  let src: string;
  let dest: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'accept' as const,
      content: { confirmOverwrite: true },
    }));
    src = join(env.tmpDir, 'mv-accept-src.txt');
    dest = join(env.tmpDir, 'mv-accept-dest.txt');
    await writeFile(src, 'new content');
    await writeFile(dest, 'original dest');
  });

  after(async () => {
    await env.cleanup();
  });

  it('moves and overwrites when user accepts', async () => {
    const result = await env.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: dest }] },
    });
    assertOk(result);
    const { readFileSync, existsSync } = await import('node:fs');
    assert.equal(readFileSync(dest, 'utf8'), 'new content');
    assert.ok(!existsSync(src), 'source must be gone after move');
  });
});

// ─── rm: elicitation handler throws (transport/capability error) ──────────────

describe('delete: elicitation handler throws', () => {
  let env: TestEnv;
  let dir: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => {
      throw new Error('transport failure');
    });
    dir = join(env.tmpDir, 'throw-dir');
    await mkdir(dir);
    await writeFile(join(dir, 'file.txt'), 'precious');
  });

  after(async () => {
    await env.cleanup();
  });

  it('does NOT delete when elicitInput throws', async () => {
    const result = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [dir], recursive: true },
    });
    // Must succeed (fail-closed returns ok:true, no deletion)
    assertOk(result);
    // Directory must still exist with its content intact
    const entries = await readdir(dir);
    assert.ok(entries.length > 0, 'directory contents must be intact when elicitation throws');
  });
});

// ─── mv: elicitation handler throws (transport/capability error) ──────────────

describe('move: elicitation handler throws', () => {
  let env: TestEnv;
  let src: string;
  let dest: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => {
      throw new Error('transport failure');
    });
    src = join(env.tmpDir, 'throw-src.txt');
    dest = join(env.tmpDir, 'throw-dest.txt');
    await writeFile(src, 'source content');
    await writeFile(dest, 'original dest');
  });

  after(async () => {
    await env.cleanup();
  });

  it('does NOT move when elicitInput throws', async () => {
    const result = await env.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: dest }] },
    });
    assertToolError(result, 'CANCELLED');
    const { readFileSync } = await import('node:fs');
    // destination must be unchanged
    assert.equal(readFileSync(dest, 'utf8'), 'original dest');
    // source must still exist
    assert.equal(readFileSync(src, 'utf8'), 'source content');
  });
});

// ─── implicit access: client accepts elicitation ──────────────────────────────

describe('implicit access grant: client accepts elicitation', () => {
  let env: TestEnv;
  let dirOutside: string;
  let fileOutside: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    dirOutside = join(tmpdir(), `fsmcp-implicit-${randomUUID().slice(0, 8)}`);
    await mkdir(dirOutside, { recursive: true });
    fileOutside = join(dirOutside, 'data.txt');
    await writeFile(fileOutside, 'implicit access content');
  });

  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dirOutside, { recursive: true, force: true });
    await env.cleanup();
  });

  it('read succeeds after inline elicitation grants access', async () => {
    const result = await env.client.callTool({
      name: 'read',
      arguments: { path: fileOutside },
    });
    assertOk(result);
    const { getStructured } = await import('../helpers.js');
    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(results[0]?.['value'] !== undefined, 'Expected successful read result');
  });
});

// ─── implicit access: client declines elicitation ────────────────────────────

describe('implicit access denial: client declines elicitation', () => {
  let env: TestEnv;
  let dirOutside: string;
  let fileOutside: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'decline' as const,
    }));
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    dirOutside = join(tmpdir(), `fsmcp-implicit-deny-${randomUUID().slice(0, 8)}`);
    await mkdir(dirOutside, { recursive: true });
    fileOutside = join(dirOutside, 'data.txt');
    await writeFile(fileOutside, 'should not be accessible');
  });

  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dirOutside, { recursive: true, force: true });
    await env.cleanup();
  });

  it('read fails with ACCESS_DENIED when elicitation is declined', async () => {
    const { getStructured } = await import('../helpers.js');
    const result = await env.client.callTool({
      name: 'read',
      arguments: { path: fileOutside },
    });
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    const error = results[0]?.['error'] as Record<string, unknown> | undefined;
    assert.ok(error !== undefined, 'Expected error in result');
    assert.equal(error['code'], 'ACCESS_DENIED');
  });
});

// ─── implicit access: cached denial ──────────────────────────────────────────

describe('implicit access: cached denial', () => {
  let env: TestEnv;
  let dirOutside: string;
  let fileOutside: string;
  let callCount = 0;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => {
      callCount++;
      return { action: 'decline' as const };
    });
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    dirOutside = join(tmpdir(), `fsmcp-implicit-cache-${randomUUID().slice(0, 8)}`);
    await mkdir(dirOutside, { recursive: true });
    fileOutside = join(dirOutside, 'data.txt');
    await writeFile(fileOutside, 'cached denial test');
  });

  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dirOutside, { recursive: true, force: true });
    await env.cleanup();
  });

  it('second read does not re-elicit after cached denial', async () => {
    const { getStructured } = await import('../helpers.js');

    // First read: elicitation fires, user declines
    const result1 = await env.client.callTool({
      name: 'read',
      arguments: { path: fileOutside },
    });
    assertOk(result1);
    const sc1 = getStructured(result1);
    const results1 = sc1['results'] as Record<string, unknown>[];
    const error1 = results1[0]?.['error'] as Record<string, unknown> | undefined;
    assert.equal(error1?.['code'], 'ACCESS_DENIED');
    assert.equal(callCount, 1);

    // Second read: denial is cached, no new elicitation
    const result2 = await env.client.callTool({
      name: 'read',
      arguments: { path: fileOutside },
    });
    assertOk(result2);
    const sc2 = getStructured(result2);
    const results2 = sc2['results'] as Record<string, unknown>[];
    const error2 = results2[0]?.['error'] as Record<string, unknown> | undefined;
    assert.equal(error2?.['code'], 'ACCESS_DENIED');
    assert.equal(callCount, 1, 'Elicitation handler should not be called again (cached denial)');
  });
});

// ─── implicit access: client without elicitation capability ──────────────────

describe('implicit access: client without elicitation capability', () => {
  let env: TestEnv;
  let dirOutside: string;
  let fileOutside: string;

  before(async () => {
    env = await createTestEnv(); // no elicitation capability
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    dirOutside = join(tmpdir(), `fsmcp-implicit-nocap-${randomUUID().slice(0, 8)}`);
    await mkdir(dirOutside, { recursive: true });
    fileOutside = join(dirOutside, 'data.txt');
    await writeFile(fileOutside, 'no capability test');
  });

  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dirOutside, { recursive: true, force: true });
    await env.cleanup();
  });

  it('fails with ACCESS_DENIED without prompting when no elicitation capability', async () => {
    const { getStructured } = await import('../helpers.js');
    const result = await env.client.callTool({
      name: 'read',
      arguments: { path: fileOutside },
    });
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    const error = results[0]?.['error'] as Record<string, unknown> | undefined;
    assert.ok(error !== undefined, 'Expected error in result');
    assert.equal(error['code'], 'ACCESS_DENIED');
  });
});

// ─── implicit access: ROOT_BOUNDARY blocks approval ───────────────────────

describe('implicit access: ROOT_BOUNDARY blocks approval', () => {
  const ORIG_BOUNDARY = process.env['ROOT_BOUNDARY'];
  let env: TestEnv;
  let boundaryDir: string;
  let outsideDir: string;
  let fileOutside: string;

  before(async () => {
    const { mkdtemp, mkdir: mkdirFs } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    const tempDir = await mkdtemp(join(tmpdir(), 'implicit-bound-'));
    boundaryDir = join(tempDir, 'boundary');
    outsideDir = join(tempDir, `outside-${randomUUID().slice(0, 8)}`);
    await mkdirFs(boundaryDir);
    await mkdirFs(outsideDir);
    fileOutside = join(outsideDir, 'secret.txt');
    await writeFile(fileOutside, 'should remain blocked');

    process.env['ROOT_BOUNDARY'] = boundaryDir;

    env = await createTestEnvWithElicitation(async () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));
  });

  after(async () => {
    if (ORIG_BOUNDARY === undefined) {
      delete process.env['ROOT_BOUNDARY'];
    } else {
      process.env['ROOT_BOUNDARY'] = ORIG_BOUNDARY;
    }
    const { rm } = await import('node:fs/promises');
    await rm(join(boundaryDir, '..'), { recursive: true, force: true });
    await env.cleanup();
  });

  it('read fails with ACCESS_DENIED when path is outside ROOT_BOUNDARY even if user approves', async () => {
    const { getStructured } = await import('../helpers.js');
    const result = await env.client.callTool({
      name: 'read',
      arguments: { path: fileOutside },
    });
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    const error = results[0]?.['error'] as Record<string, unknown> | undefined;
    assert.ok(error !== undefined, 'Expected error when outside ROOT_BOUNDARY');
    assert.equal(error['code'], 'ACCESS_DENIED');
  });
});
