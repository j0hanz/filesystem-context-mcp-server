/**
 * Security tests: path traversal, boundary enforcement, symlink escape.
 */
import assert from 'node:assert/strict';
import { mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertOk, assertToolError, createTestEnv, type TestEnv } from './helpers.js';

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
    { tool: 'read', args: () => ({ path: '/etc/passwd' }) },
    { tool: 'write', args: () => ({ path: '/tmp/escape.txt', content: 'x' }) },
    { tool: 'stat', args: () => ({ path: '/etc/hostname' }) },
    { tool: 'ls', args: () => ({ path: '/etc' }) },
    { tool: 'rm', args: (d) => ({ paths: [join(d, '../escape.txt')] }) },
    { tool: 'mkdir', args: () => ({ paths: [`/tmp/evil-dir-${Date.now()}`] }) },
    {
      tool: 'search_and_replace',
      args: () => ({
        path: '/tmp',
        pattern: '*.txt',
        searchPattern: 'x',
        replacement: 'y',
      }),
    },
    { tool: 'calculate_hash', args: () => ({ path: '/etc/passwd' }) },
  ];

  for (const { tool, args } of toolsAndArgs) {
    it(`${tool}: rejects access outside allowed root`, async () => {
      const raw = await env.client.callTool({
        name: tool,
        arguments: args(env.tmpDir),
      });
      // rm returns ok:true with failures[] for per-path errors; all others return isError
      if (tool === 'rm') {
        assertOk(raw);
        const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
        assert.ok(
          Array.isArray(sc?.['failures']) && sc['failures'].length > 0,
          'rm must report ACCESS_DENIED in failures[]',
        );
        assert.equal(
          (sc?.['failures'] as { error: { code: string } }[])[0]?.error?.code,
          'ACCESS_DENIED',
        );
      } else {
        assertToolError(raw, 'ACCESS_DENIED');
      }
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
    assertToolError(raw, 'ACCESS_DENIED');
  });

  it('stat: rejects traversal above tmpDir', async () => {
    const escaped = join(env.tmpDir, '..', 'some-other-dir');
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: escaped },
    });
    assertToolError(raw, 'ACCESS_DENIED');
  });

  it('write: rejects traversal above tmpDir', async () => {
    const escaped = join(env.tmpDir, '..', 'evil.txt');
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: escaped, content: 'exploit' },
    });
    assertToolError(raw, 'ACCESS_DENIED');
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
    assertToolError(raw, 'ACCESS_DENIED');
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
    assertToolError(raw, 'ACCESS_DENIED');
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

  it('stat_many: rejects empty paths array', async () => {
    const raw = await env.client.callTool({
      name: 'stat_many',
      arguments: { paths: [] },
    });
    assertToolError(raw);
  });

  it('read_many: rejects empty paths array', async () => {
    const raw = await env.client.callTool({
      name: 'read_many',
      arguments: { paths: [] },
    });
    assertToolError(raw);
  });

  it('mv: rejects missing both source and sources', async () => {
    const raw = await env.client.callTool({
      name: 'mv',
      arguments: { destination: join(env.tmpDir, 'dst.txt') },
    });
    assertToolError(raw);
  });

  it('mv: rejects providing both source and sources', async () => {
    const raw = await env.client.callTool({
      name: 'mv',
      arguments: {
        source: join(env.tmpDir, 'a.txt'),
        sources: [join(env.tmpDir, 'b.txt')],
        destination: join(env.tmpDir, 'dst.txt'),
      },
    });
    assertToolError(raw);
  });

  it('mkdir: rejects missing both path and paths', async () => {
    const raw = await env.client.callTool({ name: 'mkdir', arguments: {} });
    assertToolError(raw);
  });

  it('mkdir: rejects providing both path and paths', async () => {
    const raw = await env.client.callTool({
      name: 'mkdir',
      arguments: {
        path: join(env.tmpDir, 'one'),
        paths: [join(env.tmpDir, 'two')],
      },
    });
    assertToolError(raw);
  });

  it('ls: rejects unsafe recursive glob patterns', async () => {
    const raw = await env.client.callTool({
      name: 'ls',
      arguments: { path: env.tmpDir, pattern: '../../*' },
    });
    assertToolError(raw);
  });

  it('write: rejects missing content field', async () => {
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: join(env.tmpDir, 'f.txt') },
    });
    assertToolError(raw);
  });

  it('diff_files: rejects when both paths are missing', async () => {
    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: {},
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

  it('write: rejects writing through symlink to outside', async () => {
    const linkPath = await createSymlink('write-escape.txt', join(outsideDir, 'target.txt'));
    if (!linkPath) return;
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: linkPath, content: 'hacked' },
    });
    assertToolError(raw, 'ACCESS_DENIED');
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
    assertToolError(raw, 'ACCESS_DENIED');
  });

  it('mv: rejects moving symlink target outside allowed root', async () => {
    const linkPath = await createSymlink('mv-escape.txt', join(outsideDir, 'target.txt'));
    if (!linkPath) return;
    const raw = await env.client.callTool({
      name: 'mv',
      arguments: {
        source: linkPath,
        destination: join(env.tmpDir, 'moved.txt'),
      },
    });
    assertToolError(raw, 'ACCESS_DENIED');
  });

  it('rm: rejects deleting through symlink to directory outside', async () => {
    const linkPath = await createSymlink('rm-escape-dir', outsideDir);
    if (!linkPath) return;
    const raw = await env.client.callTool({
      name: 'rm',
      arguments: { paths: [linkPath] },
    });
    assertOk(raw);
    const sc = (raw as { structuredContent?: Record<string, unknown> }).structuredContent;
    assert.ok(
      Array.isArray(sc?.['failures']) && sc['failures'].length > 0,
      'rm must report ACCESS_DENIED in failures[]',
    );
    assert.equal(
      (sc?.['failures'] as { error: { code: string } }[])[0]?.error?.code,
      'ACCESS_DENIED',
    );
  });
});
