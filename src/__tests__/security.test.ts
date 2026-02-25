/**
 * Security tests: path traversal, boundary enforcement, symlink escape.
 */
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertToolError,
  createTestEnv,
  type TestEnv,
  type ToolResult,
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

  const toolsAndArgs: Array<{
    tool: string;
    args: (tmpDir: string) => Record<string, unknown>;
  }> = [
    { tool: 'read', args: () => ({ path: '/etc/passwd' }) },
    { tool: 'write', args: () => ({ path: '/tmp/escape.txt', content: 'x' }) },
    { tool: 'stat', args: () => ({ path: '/etc/hostname' }) },
    { tool: 'ls', args: () => ({ path: '/etc' }) },
    { tool: 'rm', args: (d) => ({ path: path.join(d, '../escape.txt') }) },
    { tool: 'mkdir', args: () => ({ path: '/tmp/evil-dir-' + Date.now() }) },
    {
      tool: 'search_and_replace',
      args: () => ({
        path: '/tmp',
        filePattern: '*.txt',
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
      assertToolError(raw as unknown as ToolResult, 'E_ACCESS_DENIED');
    });
  }
});

// ─── Path traversal via ".." ─────────────────────────────────────────────────

describe('security: path traversal via ".."', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await fs.writeFile(path.join(env.tmpDir, 'inner.txt'), 'inner', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('read: rejects traversal above tmpDir', async () => {
    const escaped = path.join(env.tmpDir, '..', '..', 'etc', 'passwd');
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: escaped },
    });
    assertToolError(raw as unknown as ToolResult, 'E_ACCESS_DENIED');
  });

  it('stat: rejects traversal above tmpDir', async () => {
    const escaped = path.join(env.tmpDir, '..', 'some-other-dir');
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: escaped },
    });
    assertToolError(raw as unknown as ToolResult, 'E_ACCESS_DENIED');
  });

  it('write: rejects traversal above tmpDir', async () => {
    const escaped = path.join(env.tmpDir, '..', 'evil.txt');
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: escaped, content: 'exploit' },
    });
    assertToolError(raw as unknown as ToolResult, 'E_ACCESS_DENIED');
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
    const linkPath = path.join(env.tmpDir, 'evil-link.txt');
    try {
      await fs.symlink('/etc/passwd', linkPath);
    } catch {
      // If creating the symlink fails (e.g. permissions on Windows), skip
      return;
    }
    const raw = await env.client.callTool({
      name: 'read',
      arguments: { path: linkPath },
    });
    assertToolError(raw as unknown as ToolResult, 'E_PERMISSION_DENIED');
  });

  it('stat: rejects symlink pointing outside allowed root', async () => {
    const linkPath = path.join(env.tmpDir, 'stat-evil-link');
    try {
      await fs.symlink('/etc', linkPath);
    } catch {
      return;
    }
    const raw = await env.client.callTool({
      name: 'stat',
      arguments: { path: linkPath },
    });
    assertToolError(raw as unknown as ToolResult, 'E_PERMISSION_DENIED');
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
    assertToolError(raw as unknown as ToolResult);
  });

  it('read_many: rejects empty paths array', async () => {
    const raw = await env.client.callTool({
      name: 'read_many',
      arguments: { paths: [] },
    });
    assertToolError(raw as unknown as ToolResult);
  });

  it('mv: rejects missing both source and sources', async () => {
    const raw = await env.client.callTool({
      name: 'mv',
      arguments: { destination: path.join(env.tmpDir, 'dst.txt') },
    });
    assertToolError(raw as unknown as ToolResult);
  });

  it('mkdir: rejects missing both path and paths', async () => {
    const raw = await env.client.callTool({ name: 'mkdir', arguments: {} });
    assertToolError(raw as unknown as ToolResult);
  });

  it('write: rejects missing content field', async () => {
    const raw = await env.client.callTool({
      name: 'write',
      arguments: { path: path.join(env.tmpDir, 'f.txt') },
    });
    assertToolError(raw as unknown as ToolResult);
  });

  it('diff_files: rejects when both paths are missing', async () => {
    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: {},
    });
    assertToolError(raw as unknown as ToolResult);
  });
});
