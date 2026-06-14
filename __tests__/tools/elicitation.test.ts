// __tests__/tools/elicitation.test.ts (new file)
import assert from 'node:assert/strict';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
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

// ─── request_access: client accepts/grants access ────────────────────────────

describe('request_access: client accepts elicitation', () => {
  let env: TestEnv;
  let dirToRequest: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    dirToRequest = join(tmpdir(), `fsmcp-req-${randomUUID().slice(0, 8)}`);
    await mkdir(dirToRequest, { recursive: true });
    await writeFile(join(dirToRequest, 'secret.txt'), 'secret data');
  });

  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dirToRequest, { recursive: true, force: true });
    await env.cleanup();
  });

  it('grants access, registers root, and allows reading files', async () => {
    const { getStructured } = await import('../helpers.js');
    const filePath = join(dirToRequest, 'secret.txt');

    // 1. Reading must fail initially
    const readResult1 = await env.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });
    assertOk(readResult1);
    const sc1 = getStructured(readResult1);
    const results1 = sc1['results'] as Record<string, unknown>[];
    const error1 = results1[0]?.['error'] as Record<string, unknown>;
    assert.equal(error1?.['code'], 'ACCESS_DENIED');

    // 2. Request access
    const reqResult = await env.client.callTool({
      name: 'request_access',
      arguments: { path: dirToRequest },
    });
    assertOk(reqResult);
    const structured = getStructured(reqResult);
    assert.equal(structured.ok, true);
    assert.equal(structured.granted, dirToRequest);

    // 3. Reading must now succeed
    const readResult2 = await env.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });
    assertOk(readResult2);
  });
});

describe('request_access: client declines elicitation', () => {
  let env: TestEnv;
  let dirToRequest: string;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => ({
      action: 'decline' as const,
    }));
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    dirToRequest = join(tmpdir(), `fsmcp-req-${randomUUID().slice(0, 8)}`);
    await mkdir(dirToRequest, { recursive: true });
  });

  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dirToRequest, { recursive: true, force: true });
    await env.cleanup();
  });

  it('returns ok: false when user declines elicitation', async () => {
    const { getStructured } = await import('../helpers.js');
    const reqResult = await env.client.callTool({
      name: 'request_access',
      arguments: { path: dirToRequest },
    });
    assertOk(reqResult);
    const structured = getStructured(reqResult);
    assert.equal(structured.ok, false);
    assert.ok(structured.reason !== undefined);
  });
});

describe('request_access: cache denial', () => {
  let env: TestEnv;
  let dirToRequest: string;
  let callCount = 0;

  before(async () => {
    env = await createTestEnvWithElicitation(async () => {
      callCount++;
      return { action: 'decline' as const };
    });
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    dirToRequest = join(tmpdir(), `fsmcp-req-${randomUUID().slice(0, 8)}`);
    await mkdir(dirToRequest, { recursive: true });
  });

  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dirToRequest, { recursive: true, force: true });
    await env.cleanup();
  });

  it('second request uses cache and does not prompt client again', async () => {
    const { getStructured } = await import('../helpers.js');

    // First request
    const res1 = await env.client.callTool({
      name: 'request_access',
      arguments: { path: dirToRequest },
    });
    assertOk(res1);
    assert.equal(getStructured(res1).ok, false);
    assert.equal(callCount, 1);

    // Second request
    const res2 = await env.client.callTool({
      name: 'request_access',
      arguments: { path: dirToRequest },
    });
    assertOk(res2);
    assert.equal(getStructured(res2).ok, false);
    assert.equal(callCount, 1); // should still be 1!
  });
});

describe('request_access: client without elicitation capability', () => {
  let env: TestEnv;
  let dirToRequest: string;

  before(async () => {
    env = await createTestEnv(); // no elicitation capability
    const { tmpdir } = await import('node:os');
    const { randomUUID } = await import('node:crypto');
    dirToRequest = join(tmpdir(), `fsmcp-req-${randomUUID().slice(0, 8)}`);
    await mkdir(dirToRequest, { recursive: true });
  });

  after(async () => {
    const { rm } = await import('node:fs/promises');
    await rm(dirToRequest, { recursive: true, force: true });
    await env.cleanup();
  });

  it('fails with ACCESS_DENIED', async () => {
    const result = await env.client.callTool({
      name: 'request_access',
      arguments: { path: dirToRequest },
    });
    assertToolError(result, 'ACCESS_DENIED');
  });
});

describe('request_access: with FS_ROOT_BOUNDARY', () => {
  const ORIG_BOUNDARY = process.env['FS_ROOT_BOUNDARY'];
  let env: TestEnv;
  let boundaryDir: string;
  let insideDir: string;
  let outsideDir: string;

  before(async () => {
    const { mkdtemp, mkdir } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const tempDir = await mkdtemp(join(tmpdir(), 'req-bound-'));
    boundaryDir = join(tempDir, 'boundary');
    insideDir = join(boundaryDir, 'project-a');
    outsideDir = join(tempDir, 'outside-project');

    await mkdir(boundaryDir);
    await mkdir(insideDir);
    await mkdir(outsideDir);

    process.env['FS_ROOT_BOUNDARY'] = boundaryDir;

    env = await createTestEnvWithElicitation(async () => ({
      action: 'accept' as const,
      content: { confirm: true },
    }));
  });

  after(async () => {
    if (ORIG_BOUNDARY === undefined) {
      delete process.env['FS_ROOT_BOUNDARY'];
    } else {
      process.env['FS_ROOT_BOUNDARY'] = ORIG_BOUNDARY;
    }
    const { rm } = await import('node:fs/promises');
    await rm(join(boundaryDir, '..'), { recursive: true, force: true });
    await env.cleanup();
  });

  it('allows access to path inside boundary', async () => {
    const { getStructured } = await import('../helpers.js');
    const result = await env.client.callTool({
      name: 'request_access',
      arguments: { path: insideDir },
    });
    assertOk(result);
    const structured = getStructured(result);
    assert.equal(structured.ok, true);
    assert.equal(structured.granted, insideDir);
  });

  it('rejects access to path outside boundary with ACCESS_DENIED', async () => {
    const result = await env.client.callTool({
      name: 'request_access',
      arguments: { path: outsideDir },
    });
    assertToolError(result, 'ACCESS_DENIED');
  });
});
