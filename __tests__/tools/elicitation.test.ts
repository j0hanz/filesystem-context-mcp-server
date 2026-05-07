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

describe('rm: client without elicitation capability', () => {
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
      name: 'rm',
      arguments: { paths: [dir], recursive: true },
    });
    assertOk(result);
    // Directory must be gone
    await assert.rejects(readdir(dir), { code: 'ENOENT' });
  });
});

// ─── rm: client declines elicitation ─────────────────────────────────────────

describe('rm: client declines elicitation', () => {
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
      name: 'rm',
      arguments: { paths: [dir], recursive: true },
    });
    assertOk(result);
    const sc = (result as { structuredContent?: { ok?: unknown } })
      .structuredContent;
    assert.equal((sc as { ok: unknown } | undefined)?.ok, true);
    // Directory must still exist
    const entries = await readdir(dir);
    assert.ok(
      entries.length > 0,
      'directory contents must be intact after decline'
    );
  });
});

// ─── rm: client accepts elicitation ──────────────────────────────────────────

describe('rm: client accepts elicitation', () => {
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
      name: 'rm',
      arguments: { paths: [dir], recursive: true },
    });
    assertOk(result);
    await assert.rejects(readdir(dir), { code: 'ENOENT' });
  });
});

// ─── mv: backward-compat (no elicitation capability) ─────────────────────────

describe('mv: client without elicitation capability', () => {
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
      name: 'mv',
      arguments: { sources: [src], destination: dest },
    });
    assertOk(result);
    const { readFileSync } = await import('node:fs');
    assert.equal(readFileSync(dest, 'utf8'), 'source content');
  });
});

// ─── mv: client declines when destination would be overwritten ────────────────

describe('mv: client declines elicitation (destination exists)', () => {
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
      name: 'mv',
      arguments: { sources: [src], destination: dest },
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

describe('mv: client accepts elicitation (destination exists)', () => {
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
      name: 'mv',
      arguments: { sources: [src], destination: dest },
    });
    assertOk(result);
    const { readFileSync, existsSync } = await import('node:fs');
    assert.equal(readFileSync(dest, 'utf8'), 'new content');
    assert.ok(!existsSync(src), 'source must be gone after move');
  });
});

// ─── rm: elicitation handler throws (transport/capability error) ──────────────

describe('rm: elicitation handler throws', () => {
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
      name: 'rm',
      arguments: { paths: [dir], recursive: true },
    });
    // Must succeed (fail-closed returns ok:true, no deletion)
    assertOk(result);
    // Directory must still exist with its content intact
    const entries = await readdir(dir);
    assert.ok(
      entries.length > 0,
      'directory contents must be intact when elicitation throws'
    );
  });
});

// ─── mv: elicitation handler throws (transport/capability error) ──────────────

describe('mv: elicitation handler throws', () => {
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
      name: 'mv',
      arguments: { sources: [src], destination: dest },
    });
    assertToolError(result, 'CANCELLED');
    const { readFileSync } = await import('node:fs');
    // destination must be unchanged
    assert.equal(readFileSync(dest, 'utf8'), 'original dest');
    // source must still exist
    assert.equal(readFileSync(src, 'utf8'), 'source content');
  });
});
