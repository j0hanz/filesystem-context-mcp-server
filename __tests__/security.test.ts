/**
 * Security tests: path traversal, boundary enforcement, symlink escape.
 */
import assert from 'node:assert/strict';
import { lstat, mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertInputRequiredFailClose,
  assertOk,
  assertToolError,
  createTestEnv,
  type TestEnv,
} from './helpers.js';

// ─── Path boundary enforcement ───────────────────────────────────────────────

describe('security: path boundary enforcement', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  const toolsAndArgs: {
    tool: string;
    args: (tmpDir: string) => Record<string, unknown>;
  }[] = [
    // Out-of-root paths here must resolve to an ANCESTOR THAT EXISTS (os.tmpdir()
    // itself, which is a real, existing directory outside env.tmpDir) so the
    // grant-target walk finds a genuine non-root directory and still exercises
    // the legacy-era fail-close path. A path whose entire ancestor chain is
    // missing (e.g. `/etc/*` on a Windows box with no `C:\etc`) walks all the
    // way to the bare filesystem root, which the fix in path.ts's
    // precheckAccess now correctly refuses to offer as a grant target — that
    // case fails closed with a normal ACCESS_DENIED instead, covered separately
    // (see access-grant.test.ts's bare-filesystem-root test).
    { tool: 'read', args: () => ({ path: join(tmpdir(), 'fsmcp-security-outside.txt') }) },
    { tool: 'create', args: () => ({ files: [{ path: '/tmp/escape.txt', content: 'x' }] }) },
    { tool: 'stat', args: () => ({ path: join(tmpdir(), 'fsmcp-security-outside.txt') }) },
    { tool: 'list', args: () => ({ path: tmpdir() }) },
    { tool: 'delete', args: (d) => ({ paths: [join(d, '../escape.txt')] }) },
    {
      tool: 'create',
      args: () => ({ files: [{ path: `/tmp/evil-dir-${Date.now()}/.keep`, content: '' }] }),
    },
    {
      tool: 'replace_text',
      args: () => ({
        path: '/tmp',
        pattern: '*.txt',
        searchPattern: 'x',
        replacement: 'y',
      }),
    },
    { tool: 'hash_file', args: () => ({ path: join(tmpdir(), 'fsmcp-security-outside.txt') }) },
  ];

  for (const { tool, args } of toolsAndArgs) {
    it(`${tool}: rejects access outside allowed root`, async () => {
      const raw = await env.client.callTool({
        name: tool,
        arguments: args(env.tmpDir),
      });
      // Out-of-root on the legacy-era wire harness: precheckGrant returns
      // input_required, and the SDK legacy shim fail-closes (R6 — nothing
      // touched). The grant round-trip itself is covered by the direct-handler
      // tests; here we assert the wire-observable fail-close shape.
      assertInputRequiredFailClose(raw);
    });
  }
});

// ─── Path traversal via ".." ─────────────────────────────────────────────────

describe('security: path traversal via ".."', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(join(env.tmpDir, 'inner.txt'), 'inner', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('read: rejects traversal above tmpDir', async () => {
    const escaped = join(env.tmpDir, '..', '..', 'etc', 'passwd');
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: escaped },
    });
    // path.join resolves ".." away, so this reaches precheckGrant (out-of-root)
    // and fail-closes on the legacy-era harness — R6.
    assertInputRequiredFailClose(raw);
  });

  it('stat: rejects traversal above tmpDir', async () => {
    const escaped = join(env.tmpDir, '..', 'some-other-dir');
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: escaped },
    });
    assertInputRequiredFailClose(raw);
  });

  it('create: rejects traversal above tmpDir', async () => {
    const escaped = join(env.tmpDir, '..', 'evil.txt');
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files: [{ path: escaped, content: 'exploit' }] },
    });
    assertInputRequiredFailClose(raw);
  });
});

// ─── Symlink escape ──────────────────────────────────────────────────────────

describe('security: symlink escape attempt', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('read: rejects symlink pointing outside allowed root', async () => {
    const linkPath = join(env.tmpDir, 'evil-link.txt');
    try {
      await symlink('/etc/passwd', linkPath);
    } catch {
      // If creating the symlink fails (e.g. permissions on Windows), skip
      return;
    }
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: linkPath },
    });
    assertOk(raw);
    const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    const results = sc?.['results'] as { error?: { code?: string } }[] | undefined;
    assert.ok(Array.isArray(results) && results.length > 0, 'read must return results[]');
    assert.equal(results[0]?.error?.code, 'ACCESS_DENIED');
  });

  it('stat: rejects symlink pointing outside allowed root', async () => {
    const linkPath = join(env.tmpDir, 'stat-evil-link');
    try {
      await symlink('/etc', linkPath);
    } catch {
      return;
    }
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: linkPath },
    });
    assertOk(raw);
    const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    const results = sc?.['results'] as { error?: { code?: string } }[] | undefined;
    assert.ok(Array.isArray(results) && results.length > 0, 'stat must return results[]');
    assert.equal(results[0]?.error?.code, 'ACCESS_DENIED');
  });
});

// ─── Schema input validation ─────────────────────────────────────────────────

describe('security: schema validation rejects malformed input', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('stat: rejects empty paths array', async () => {
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { paths: [] },
    });
    assertToolError(raw);
  });

  it('read: rejects empty paths array', async () => {
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { paths: [] },
    });
    assertToolError(raw);
  });

  it('move: rejects missing moves', async () => {
    const raw = await env.client.callTool({
      name: 'move',
      arguments: { destination: join(env.tmpDir, 'dst.txt') },
    });
    assertToolError(raw);
  });

  it('move: rejects legacy source/sources shape', async () => {
    const raw = await env.client.callTool({
      name: 'move',
      arguments: {
        source: join(env.tmpDir, 'a.txt'),
        sources: [join(env.tmpDir, 'b.txt')],
        destination: join(env.tmpDir, 'dst.txt'),
      },
    });
    assertToolError(raw);
  });

  it('create: rejects missing files', async () => {
    const raw = await env.client.callTool({ name: 'create', arguments: {} });
    assertToolError(raw);
  });

  it('create: rejects legacy path/paths shape', async () => {
    const raw = await env.client.callTool({
      name: 'create',
      arguments: {
        path: join(env.tmpDir, 'one'),
        paths: [join(env.tmpDir, 'two')],
      },
    });
    assertToolError(raw);
  });

  it('list: rejects paths outside allowed directories', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: '/../' },
    });
    assertToolError(raw);
  });

  it('create: rejects missing content field', async () => {
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files: [{ path: join(env.tmpDir, 'f.txt') }] },
    });
    assertToolError(raw);
  });
});

// ─── Symlink escape for destructive operations ───────────────────────────────

describe('security: symlink escape for destructive ops', () => {
  let env: TestEnv;
  let outsideDir: string;

  before(async () => {
    env = await createTestEnv();
    // Create a directory outside the allowed root to be a symlink target
    outsideDir = join(dirname(env.tmpDir), `outside-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'target.txt'), 'outside-content', 'utf8');
  });

  after(async () => {
    await env.cleanup();
    await rm(outsideDir, { recursive: true, force: true });
  });

  async function createSymlink(name: string, target: string): Promise<string | null> {
    const linkPath = join(env.tmpDir, name);
    try {
      await symlink(target, linkPath);
      return linkPath;
    } catch {
      return null; // symlink creation may fail on Windows without privileges
    }
  }

  it('create: rejects writing through symlink to outside', async () => {
    const linkPath = await createSymlink('create-escape.txt', join(outsideDir, 'target.txt'));
    if (!linkPath) return;
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files: [{ path: linkPath, content: 'hacked' }] },
    });
    assertOk(raw);
    const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    assert.ok(
      Array.isArray(sc?.['failures']) && sc['failures'].length > 0,
      'create must report ACCESS_DENIED in failures[]',
    );
    assert.equal(
      (sc?.['failures'] as { error: { code: string } }[])[0]?.error?.code,
      'ACCESS_DENIED',
    );
  });

  it('edit: rejects editing through symlink to outside', async () => {
    const linkPath = await createSymlink('edit-escape.txt', join(outsideDir, 'target.txt'));
    if (!linkPath) return;
    const raw = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: linkPath,
        edits: [{ oldText: 'outside-content', newText: 'hacked' }],
      },
    });
    assertOk(raw);
    const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    const results = sc?.['results'] as { error?: { code?: string } }[] | undefined;
    assert.ok(Array.isArray(results) && results.length > 0, 'edit must return results[]');
    assert.equal(results[0]?.error?.code, 'ACCESS_DENIED');
  });

  it('move: rejects moving symlink target outside allowed root', async () => {
    const linkPath = await createSymlink('mv-escape.txt', join(outsideDir, 'target.txt'));
    if (!linkPath) return;
    const raw = await env.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: linkPath, destination: join(env.tmpDir, 'moved.txt') }],
      },
    });
    assertOk(raw);
    const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    assert.ok(
      Array.isArray(sc?.['failures']) && sc['failures'].length > 0,
      'move must report ACCESS_DENIED in failures[]',
    );
    assert.equal(
      (sc?.['failures'] as { error: { code: string } }[])[0]?.error?.code,
      'ACCESS_DENIED',
    );
  });

  it('delete: allows deleting symlink pointing to directory outside', async () => {
    const linkPath = await createSymlink('rm-escape-dir', outsideDir);
    if (!linkPath) return;
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [linkPath] },
    });
    assertOk(raw);
    const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    assert.ok(
      !sc?.['failures'] || sc['failures'].length === 0,
      'delete should not report failures',
    );

    // Verify the symlink itself was deleted
    let linkExists = true;
    try {
      await lstat(linkPath);
    } catch {
      linkExists = false;
    }
    assert.equal(linkExists, false, 'Symlink itself should be deleted');

    // Verify the outside target folder and its contents are NOT deleted
    let targetExists = true;
    try {
      await stat(join(outsideDir, 'target.txt'));
    } catch {
      targetExists = false;
    }
    assert.equal(targetExists, true, 'Symlink target contents should still exist');
  });
});

// ─── Sensitive file blocking ────────────────────────────────────────────────

describe('security: sensitive file blocking', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(join(env.tmpDir, '.env'), 'SECRET=1', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('move: rejects renaming a sensitive file', async () => {
    const raw = await env.client.callTool({
      name: 'move',
      arguments: {
        moves: [{ source: join(env.tmpDir, '.env'), destination: join(env.tmpDir, '.env.bak') }],
      },
    });
    assertOk(raw);
    const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    assert.ok(
      Array.isArray(sc?.['failures']) && sc['failures'].length > 0,
      'move must report ACCESS_DENIED for sensitive file',
    );
    assert.equal(
      (sc?.['failures'] as { error: { code: string } }[])[0]?.error?.code,
      'ACCESS_DENIED',
    );
  });
});

// ─── list: symlink target boundary enforcement ───────────────────────────────

describe('security: list hides symlinks escaping the allowed root', () => {
  let env: TestEnv;
  let outsideDir: string;

  before(async () => {
    env = await createTestEnv();
    outsideDir = join(dirname(env.tmpDir), `outside-list-${Date.now()}`);
    await mkdir(outsideDir, { recursive: true });
    await writeFile(join(outsideDir, 'secret.txt'), 'outside-content', 'utf8');
  });

  after(async () => {
    await env.cleanup();
    await rm(outsideDir, { recursive: true, force: true });
  });

  it('omits a symlink whose target points outside the allowed root', async () => {
    // A regular in-bounds file must always be listed.
    await writeFile(join(env.tmpDir, 'inside.txt'), 'ok', 'utf8');

    const escapeLink = join(env.tmpDir, 'escape-link.txt');
    let linked = true;
    try {
      await symlink(join(outsideDir, 'secret.txt'), escapeLink);
    } catch {
      linked = false; // symlink creation may require privileges on Windows
    }

    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir, maxDepth: 1 },
    });
    assertOk(raw);
    const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    const entries = (sc?.['entries'] ?? []) as { name: string }[];
    const names = entries.map((e) => e.name);

    assert.ok(names.includes('inside.txt'), 'in-bounds file must be listed');
    if (linked) {
      assert.ok(
        !names.includes('escape-link.txt'),
        'symlink whose target escapes the allowed root must be omitted from the listing',
      );
    }
  });
});
