/**
 * Integration tests for directory-oriented tools: roots, list, create, rm, move.
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PathGuard, resolveAllowedDirectoriesState } from '../../src/core/path.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';
import { LIST } from '../../src/tools/list.js';
import {
  assertOk,
  assertToolError,
  createTestEnv,
  getStructured,
  type TestEnv,
} from '../helpers.js';

// ─── roots ──────────────────────────────────────────────────────────────────

describe('roots tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('lists allowed roots with terse summary', async () => {
    const raw = await env.client.callTool({ name: 'list_roots', arguments: {} });
    const result = raw;
    assertOk(result);

    // Verify content: terse summary, no resource links
    assert.equal(result.content.length, 1, 'Expected exactly one content block');
    assert.equal(result.content[0].type, 'text', 'Expected text content');
    const summaryText = result.content[0].text;
    assert.ok(summaryText.startsWith('roots:'), 'Expected summary to start with "roots:"');
    assert.ok(summaryText.includes('allowed'), 'Expected summary to include "allowed"');

    // Verify structured content
    const sc = getStructured(result);
    const roots = sc['roots'] as string[];
    assert.ok(
      Array.isArray(roots) && roots.length > 0,
      'Expected at least one root directory path',
    );
    assert.ok(
      roots.every((r) => typeof r === 'string'),
      'Expected all roots to be strings',
    );
  });
});

// ─── list ───────────────────────────────────────────────────────────────────

describe('list tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(join(env.tmpDir, 'alpha.txt'), 'a', 'utf8');
    await writeFile(join(env.tmpDir, 'beta.txt'), 'b', 'utf8');
    await mkdir(join(env.tmpDir, 'sub'));
    await writeFile(join(env.tmpDir, 'sub', 'nested.txt'), 'n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('lists top-level entries flat (default maxDepth=1)', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    assert.equal(typeof sc['path'], 'string');
    assert.equal(typeof sc['markdown'], 'string');

    const entries = sc['entries'] as Record<string, unknown>[];
    const names = entries.map((e) => e['name'] as string);

    // sub directory, then alpha.txt, beta.txt (dirs-first, alpha)
    assert.ok(names.includes('sub'), 'Expected sub dir');
    assert.ok(names.includes('alpha.txt'), 'Expected alpha.txt');
    assert.ok(names.includes('beta.txt'), 'Expected beta.txt');

    // dirs-first: sub must appear before alpha.txt
    assert.ok(names.indexOf('sub') < names.indexOf('alpha.txt'), 'Expected dirs first');
    assert.ok(
      names.indexOf('alpha.txt') < names.indexOf('beta.txt'),
      'Expected alphabetical ordering of files',
    );

    // flat: nested.txt must NOT appear at maxDepth=1
    assert.ok(!names.includes('nested.txt'), 'Expected no nested entries at maxDepth=1');

    assert.ok(typeof sc['entryCount'] === 'number');
    assert.ok(typeof sc['totalEntries'] === 'number');
    assert.ok(typeof sc['totalFiles'] === 'number');
    assert.ok(typeof sc['totalDirectories'] === 'number');
    assert.equal(sc['totalDirectories'], 1);
  });

  it('recurses when maxDepth > 1', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir, maxDepth: 2 },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    const entries = sc['entries'] as Record<string, unknown>[];
    const names = entries.map((e) => e['name'] as string);

    assert.ok(names.includes('alpha.txt'), 'Expected alpha.txt at maxDepth=2');
    assert.ok(names.includes('beta.txt'), 'Expected beta.txt at maxDepth=2');
    assert.ok(names.includes('nested.txt'), 'Expected nested.txt at maxDepth=2');

    // relativePath must be POSIX
    const nested = entries.find((e) => e['name'] === 'nested.txt');
    assert.ok(nested);
    assert.equal(nested['relativePath'], 'sub/nested.txt');
  });

  it('markdown contains root name and entry names', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    const markdown = sc['markdown'] as string;
    const lines = markdown.split('\n');

    // First line is the root dir name
    assert.ok(lines[0], 'Expected root name as first line');
    assert.ok(markdown.includes('sub'), 'Expected sub in markdown');
    assert.ok(markdown.includes('alpha.txt'), 'Expected alpha.txt in markdown');
    // Box-drawing chars present
    assert.ok(markdown.includes('├──') || markdown.includes('└──'), 'Expected box-drawing chars');
  });

  it('truncation stores full result in resourceUri', async () => {
    const manyDir = join(env.tmpDir, 'many');
    await mkdir(manyDir);
    // Create 10 files to exceed maxEntries=3 and trigger truncation behavior
    for (let i = 0; i < 10; i++) {
      await writeFile(join(manyDir, `f${String(i).padStart(2, '0')}.txt`), '', 'utf8');
    }

    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: manyDir, maxEntries: 3 },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    assert.equal(sc['entryCount'], 3);
    assert.ok((sc['totalEntries'] as number) > 3, 'Expected totalEntries > 3');
    assert.ok(typeof sc['resourceUri'] === 'string', 'Expected resourceUri when truncated');
    assert.ok(sc['resourceUri'].includes('filesystem-mcp://result/'));

    const resource = env.resourceStore.getText(sc['resourceUri']);
    const fullOutput = JSON.parse(resource.text) as {
      entries?: unknown[];
      markdown?: string;
      totalEntries?: number;
    };
    assert.equal(fullOutput.totalEntries, sc['totalEntries']);
    assert.equal(fullOutput.entries?.length, sc['totalEntries']);
    const fullMarkdown = fullOutput.markdown;
    assert.ok(
      typeof fullMarkdown === 'string' && fullMarkdown.includes('f09.txt'),
      'Expected full markdown in resource payload',
    );
  });

  it('totalFiles + totalDirectories === totalEntries', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: env.tmpDir, maxDepth: 2 },
    });
    assertOk(raw);

    const sc = getStructured(raw);
    assert.equal(
      (sc['totalFiles'] as number) + (sc['totalDirectories'] as number),
      sc['totalEntries'] as number,
    );
  });

  it('returns ACCESS_DENIED for paths outside allowed roots', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: '/etc' },
    });
    assertToolError(raw, 'ACCESS_DENIED');
  });

  it('returns NOT_DIRECTORY for a file path', async () => {
    const raw = await env.client.callTool({
      name: 'list',
      arguments: { path: join(env.tmpDir, 'alpha.txt') },
    });
    assertToolError(raw, 'NOT_DIRECTORY');
  });
});

describe('list tool progress', () => {
  it('emits monotonic scanned progress across truncation second pass', async () => {
    type CapturedHandler = (
      args: unknown,
      extra: ServerContext,
    ) => Promise<Record<string, unknown>>;
    const capture: { handler?: CapturedHandler } = {};

    const mockServer = {
      registerTool: (_name: string, _schema: unknown, handler: unknown): void => {
        capture.handler = handler as CapturedHandler;
      },
    } as unknown as McpServer;

    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-list-progress-'));

    try {
      await mkdir(join(tmp, 'nested', 'deep'), { recursive: true });
      await writeFile(join(tmp, 'root.txt'), 'root', 'utf8');
      await writeFile(join(tmp, 'nested', 'child.txt'), 'child', 'utf8');
      await writeFile(join(tmp, 'nested', 'deep', 'leaf.txt'), 'leaf', 'utf8');

      const pathGuard = new PathGuard();
      const state = await resolveAllowedDirectoriesState([tmp]);
      pathGuard.initialize(state);

      LIST.register({
        server: mockServer,
        pathGuard,
        resourceStore: createInMemoryResourceStore(),
        isInitialized: () => true,
      });

      assert.ok(capture.handler, 'Expected list handler to be registered');

      const notifications: unknown[] = [];
      const mcpReq = {
        signal: new AbortController().signal,
        _meta: { progressToken: 'list-progress-token' },
        notify: async (notification: unknown) => {
          notifications.push(notification);
        },
        log: async () => undefined,
        elicitInput: async () => ({ action: 'cancel' as const }),
      };

      const raw = await capture.handler(
        {
          path: tmp,
          maxDepth: 4,
          maxEntries: 2,
          includeHidden: false,
          includeIgnored: false,
        },
        { mcpReq } as unknown as ServerContext,
      );

      const output = raw as {
        structuredContent?: {
          resourceUri?: unknown;
          totalEntries?: unknown;
        };
      };
      assert.equal(typeof output.structuredContent?.resourceUri, 'string');

      const progressMethod = 'notifications/progress';
      const deadline = Date.now() + 250;
      while (
        Date.now() < deadline &&
        !notifications.some((notification) => {
          if (!notification || typeof notification !== 'object') return false;
          const candidate = notification as { method?: unknown };
          return candidate.method === progressMethod;
        })
      ) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      const progressPayloads = notifications
        .filter((notification): notification is { method: string; params?: unknown } => {
          if (!notification || typeof notification !== 'object') return false;
          const candidate = notification as { method?: unknown; params?: unknown };
          return candidate.method === progressMethod;
        })
        .map((notification): { progress?: unknown; total?: unknown; progressToken?: unknown } => {
          if (!notification.params || typeof notification.params !== 'object') return {};
          return notification.params;
        });

      const progressValues = progressPayloads
        .map((payload) => payload.progress)
        .filter((value): value is number => typeof value === 'number');

      assert.ok(
        progressPayloads.length >= 1,
        'Expected at least one progress callback while walking temp tree',
      );
      assert.ok(
        progressValues.some((value) => value >= 1),
        'Expected at least one progress callback with payload.progress >= 1 (transport mapping for current)',
      );
      for (let i = 1; i < progressValues.length; i++) {
        const previous = progressValues[i - 1];
        const current = progressValues[i];
        assert.ok(
          current !== undefined && previous !== undefined && current >= previous,
          'Expected progress callbacks to be non-decreasing even when truncation triggers a second pass',
        );
      }
      assert.ok(
        progressPayloads.some((payload) => payload.progressToken === 'list-progress-token'),
        'Expected at least one progress callback with the provided progressToken',
      );
      const maxProgress = progressValues.length > 0 ? Math.max(...progressValues) : 0;
      const includedEntries = output.structuredContent?.totalEntries;
      assert.ok(
        typeof includedEntries === 'number' && maxProgress > includedEntries,
        'Expected scanned progress to exceed included entries count when truncation triggers second collection',
      );
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});

// ─── create ─────────────────────────────────────────────────────────────────

describe('create tool (directory creation)', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('creates a new file and parent directory', async () => {
    const newDir = join(env.tmpDir, 'new-dir');
    const newFile = join(newDir, 'created.txt');
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files: [{ path: newFile, content: '' }] },
    });
    assertOk(raw);

    // Verify content includes terse summary
    const textBlock = raw.content.find((block) => block.type === 'text');
    if (!textBlock) {
      assert.fail('Expected text content');
    }
    const summaryText = textBlock.text;
    assert.ok(summaryText.startsWith('create:'), 'Expected summary to start with "create:"');

    // Verify structured content has created file metadata
    const sc = getStructured(raw);
    const files = sc['files'] as Record<string, unknown>[];
    const createdFile = files[0];
    assert.ok(createdFile, 'Expected first file result');
    assert.ok(createdFile['ok'] === true, 'Expected ok: true');
    const createdPath = createdFile['path'] as string;
    assert.ok(createdPath, 'Expected file path field to be set');
    assert.equal(
      createdPath.toLowerCase(),
      newFile.toLowerCase(),
      'Expected path field to be the created file path',
    );
    assert.equal(createdFile['size'], 0);
    assert.equal(createdFile['lineCount'], 1);
    assert.equal(createdFile['mimeType'], 'text/plain');
    assert.equal(createdFile['kind'], 'text');
    // Verify summary contains the path (case-insensitive)
    assert.ok(
      summaryText.toLowerCase().includes('created.txt'),
      'Expected summary to include the created file name',
    );

    // Verify file and parent directory were actually created
    const dirStat = await stat(newDir);
    assert.ok(dirStat.isDirectory());
    const fileStat = await stat(newFile);
    assert.ok(fileStat.isFile());
  });

  it('overwrites an existing file without error', async () => {
    const existingFile = join(env.tmpDir, 'idempotent-file.txt');
    await writeFile(existingFile, 'existing', 'utf8');
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files: [{ path: existingFile, content: '' }] },
    });
    assertOk(raw);
  });

  it('creates multiple files via files array', async () => {
    const f1 = join(env.tmpDir, 'batch-a', 'created.txt');
    const f2 = join(env.tmpDir, 'batch-b', 'created.txt');
    const raw = await env.client.callTool({
      name: 'create',
      arguments: {
        files: [
          { path: f1, content: '' },
          { path: f2, content: '' },
        ],
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const files = sc['files'] as Record<string, unknown>[];
    assert.equal(files.length, 2);
    const firstFile = files[0];
    assert.ok(firstFile, 'Expected first file result');
    assert.ok(firstFile['ok'] === true);
    assert.equal(
      (firstFile['path'] as string).toLowerCase(),
      f1.toLowerCase(),
      'Expected first file path to match the first input',
    );
    assert.equal(firstFile['size'], 0);
    assert.equal(firstFile['lineCount'], 1);
    assert.equal(firstFile['mimeType'], 'text/plain');
    assert.equal(firstFile['kind'], 'text');
    assert.ok((await stat(f1)).isFile());
    assert.ok((await stat(f2)).isFile());
  });

  it('rejects creation outside allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files: [{ path: `/tmp/escape-${Date.now()}`, content: '' }] },
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
});

// ─── rm ─────────────────────────────────────────────────────────────────────

describe('rm tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('removes an existing file', async () => {
    const file = join(env.tmpDir, 'to-delete.txt');
    await writeFile(file, 'bye', 'utf8');
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [file] },
    });
    assertOk(raw);

    // Verify content: terse summary with deletion confirmation, no resource links
    assert.equal(
      raw.content.length,
      1,
      'Expected exactly one content block (P3 confirmation-only pattern)',
    );
    assert.equal(raw.content[0].type, 'text', 'Expected text content');
    const summaryText = raw.content[0].text;
    assert.ok(
      summaryText.startsWith('delete-file:'),
      'Expected summary to start with "delete-file:"',
    );

    // Verify structured content has path and ok (P3 pattern)
    const sc = getStructured(raw);
    assert.ok(sc['ok'] === true, 'Expected ok: true');
    const deletedPath = sc['path'] as string;
    assert.ok(deletedPath, 'Expected path field to be set');
    assert.equal(
      deletedPath.toLowerCase(),
      file.toLowerCase(),
      'Expected path field to be the deleted file path',
    );
    // Verify summary contains the path (case-insensitive)
    assert.ok(
      summaryText.toLowerCase().includes(deletedPath.toLowerCase()),
      'Expected summary to include the deleted path',
    );

    // Verify file was actually deleted
    await assert.rejects(() => stat(file), /ENOENT/);
  });

  it('removes a directory recursively', async () => {
    const dir = join(env.tmpDir, 'to-delete-dir');
    await mkdir(dir);
    await writeFile(join(dir, 'inner.txt'), 'inner', 'utf8');
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [dir], recursive: true },
    });
    assertOk(raw);

    // Verify content: terse summary with deletion confirmation, no resource links
    assert.equal(
      raw.content.length,
      1,
      'Expected exactly one content block (P3 confirmation-only pattern)',
    );
    assert.equal(raw.content[0].type, 'text', 'Expected text content');
    const summaryText = raw.content[0].text;
    assert.ok(
      summaryText.startsWith('delete-file:'),
      'Expected summary to start with "delete-file:"',
    );

    // Verify structured content has path and ok (P3 pattern)
    const sc = getStructured(raw);
    assert.ok(sc['ok'] === true, 'Expected ok: true');
    assert.ok(sc['path'], 'Expected path field to be set');

    // Verify directory was actually deleted
    await assert.rejects(() => stat(dir), /ENOENT/);
  });

  it('returns NOT_FOUND error for missing file', async () => {
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [join(env.tmpDir, 'ghost.txt')] },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const failures = sc['failures'] as Record<string, unknown>[] | undefined;
    assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 failure');
    assert.equal((failures[0]['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  });

  it('ignoreIfNotExists suppresses NOT_FOUND', async () => {
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: {
        paths: [join(env.tmpDir, 'definitely-not-here.txt')],
        ignoreIfNotExists: true,
      },
    });
    assertOk(raw);
  });

  it('returns ACCESS_DENIED error when deleting workspace root', async () => {
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [env.tmpDir], recursive: true },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const failures = sc['failures'] as Record<string, unknown>[] | undefined;
    assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 failure');
    assert.equal((failures[0]['error'] as Record<string, unknown>)['code'], 'ACCESS_DENIED');
    // Verify root still exists
    const stats = await stat(env.tmpDir);
    assert.ok(stats.isDirectory());
  });
});

// ─── move ───────────────────────────────────────────────────────────────────

describe('move tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('moves a file to a new path', async () => {
    const src = join(env.tmpDir, 'source.txt');
    const dst = join(env.tmpDir, 'dest.txt');
    await writeFile(src, 'move me', 'utf8');
    const raw = await env.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: dst }] },
    });
    assertOk(raw);

    // Verify content: terse summary with source → destination, no resource links
    assert.equal(
      raw.content.length,
      1,
      'Expected exactly one content block (P3 confirmation-only pattern)',
    );
    assert.equal(raw.content[0].type, 'text', 'Expected text content');
    const summaryText = raw.content[0].text;
    assert.ok(summaryText.startsWith('move:'), 'Expected summary to start with "move:"');
    assert.ok(summaryText.includes('→'), 'Expected summary to include arrow (→) separator');

    // Verify structured content has from/to/ok result metadata
    const sc = getStructured(raw);
    const moves = sc['moves'] as Record<string, unknown>[];
    const move = moves[0];
    assert.ok(move, 'Expected first move result');
    assert.ok(move['ok'] === true, 'Expected ok: true');
    assert.equal(
      (move['from'] as string).toLowerCase(),
      src.toLowerCase(),
      'Expected from field to be source path',
    );
    assert.equal(
      (move['to'] as string).toLowerCase(),
      dst.toLowerCase(),
      'Expected to field to be destination path',
    );

    // Verify file was actually moved
    await assert.rejects(() => stat(src), /ENOENT/);
    const content = await readFile(dst, 'utf8');
    assert.equal(content, 'move me');
  });

  it('skips self-moves without changing the file', async () => {
    const src = join(env.tmpDir, 'same-file.txt');
    await writeFile(src, 'same', 'utf8');

    const raw = await env.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: src }] },
    });

    assertOk(raw);
    const sc = getStructured(raw);
    const moves = sc['moves'] as Record<string, unknown>[];
    assert.equal(moves.length, 0);
    assert.equal(await readFile(src, 'utf8'), 'same');
  });

  it('rejects moving a directory into its own subdirectory', async () => {
    const src = join(env.tmpDir, 'parent-dir');
    const dst = join(src, 'child', 'parent-dir');
    await mkdir(src, { recursive: true });

    const raw = await env.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: src, destination: dst }] },
    });

    assertOk(raw);
    const sc = getStructured(raw);
    const failures = sc['failures'] as Record<string, unknown>[] | undefined;
    assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 failure');
    assert.equal((failures[0]['error'] as Record<string, unknown>)['code'], 'INVALID_INPUT');
  });

  it('returns failure in failures[] when source is missing', async () => {
    const raw = await env.client.callTool({
      name: 'move',
      arguments: {
        moves: [
          {
            source: join(env.tmpDir, 'no-source.txt'),
            destination: join(env.tmpDir, 'dst.txt'),
          },
        ],
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    const failures = sc['failures'] as Record<string, unknown>[] | undefined;
    assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 failure');
    assert.ok((failures[0]['source'] as string).includes('no-source.txt'));
  });
});

// ─── invalid cursor ─────────────────────────────────────────────────────────

describe('invalid cursor rejection', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(join(env.tmpDir, 'a.txt'), 'a', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('find rejects a malformed cursor with INVALID_INPUT', async () => {
    const raw = await env.client.callTool({
      name: 'find_files',
      arguments: {
        path: env.tmpDir,
        pattern: '*.txt',
        cursor: 'not-a-valid-cursor',
      },
    });
    assertToolError(raw, 'INVALID_INPUT');
  });
});

// ─── array size limits ──────────────────────────────────────────────────────

describe('array size limits', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('create rejects > 100 files', async () => {
    const files = Array.from({ length: 101 }, (_, i) => ({
      path: join(env.tmpDir, `file-${i}.txt`),
      content: '',
    }));
    const raw = await env.client.callTool({
      name: 'create',
      arguments: { files },
    });
    assertToolError(raw);
    // Verify error mentions the size constraint
    const textBlock = raw.content.find(
      (b): b is { type: 'text'; text: string } => b.type === 'text',
    );
    assert.ok(textBlock?.text.includes('100'), 'Expected error to mention the 100 item limit');
  });
});

describe('delete: processes all paths in batch', () => {
  let env: TestEnv;
  let f1: string;
  let f2: string;
  let f3: string;

  before(async () => {
    env = await createTestEnv();
    f1 = join(env.tmpDir, 'del-a.txt');
    f2 = join(env.tmpDir, 'del-b.txt');
    f3 = join(env.tmpDir, 'del-c.txt');
    await writeFile(f1, 'a', 'utf8');
    await writeFile(f2, 'b', 'utf8');
    await writeFile(f3, 'c', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('deletes all three paths and returns them in paths[]', async () => {
    const result = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [f1, f2, f3] },
    });
    assertOk(result);
    const sc = getStructured(result);

    // All three must be gone from the file system
    for (const f of [f1, f2, f3]) {
      await assert.rejects(stat(f), { code: 'ENOENT' });
    }

    // Structured output must list all three deleted paths
    const paths = sc['paths'] as string[] | undefined;
    assert.ok(Array.isArray(paths) && paths.length === 3, 'Expected paths[] with 3 entries');
    assert.ok(paths.some((p) => p.includes('del-a.txt')));
    assert.ok(paths.some((p) => p.includes('del-b.txt')));
    assert.ok(paths.some((p) => p.includes('del-c.txt')));
  });

  it('collects per-path errors for missing files in failures[], continues rest', async () => {
    const missing = join(env.tmpDir, 'no-such-file.txt');
    const extra = join(env.tmpDir, 'del-extra.txt');
    await writeFile(extra, 'x', 'utf8');

    const result = await env.client.callTool({
      name: 'delete',
      arguments: { paths: [extra, missing], ignoreIfNotExists: false },
    });
    assertOk(result);
    const sc = getStructured(result);

    // extra must be deleted
    await assert.rejects(stat(extra), { code: 'ENOENT' });

    // failures[] must mention the missing file
    const failures = sc['failures'] as Record<string, unknown>[] | undefined;
    assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 failure');
    assert.ok((failures[0]['path'] as string).includes('no-such-file.txt'));
    assert.equal((failures[0]['error'] as Record<string, unknown>)['code'], 'NOT_FOUND');
  });

  it('returns ok:false when every path fails', async () => {
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: {
        paths: [join(env.tmpDir, 'no-such-a.txt'), join(env.tmpDir, 'no-such-b.txt')],
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['ok'], false, 'ok must be false when every path fails');
    const failures = sc['failures'] as Record<string, unknown>[] | undefined;
    assert.ok(Array.isArray(failures) && failures.length === 2, 'Expected 2 failures');
  });

  it('returns ok:true when at least one path succeeds (partial failure)', async () => {
    const goodFile = join(env.tmpDir, 'partial-good.txt');
    await writeFile(goodFile, '', 'utf8');
    const raw = await env.client.callTool({
      name: 'delete',
      arguments: {
        paths: [goodFile, join(env.tmpDir, 'no-such-c.txt')],
      },
    });
    assertOk(raw);
    const sc = getStructured(raw);
    assert.equal(sc['ok'], true, 'ok must be true when at least one path succeeds');
    const failures = sc['failures'] as Record<string, unknown>[] | undefined;
    assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 failure');
  });
});

describe('move: partial failure support', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('moves valid pairs and collects failures for invalid ones', async () => {
    const src1 = join(env.tmpDir, 'mv-good-src.txt');
    const dest1 = join(env.tmpDir, 'mv-good-dest.txt');
    const missingSrc = join(env.tmpDir, 'mv-missing-src.txt'); // does not exist
    const dest2 = join(env.tmpDir, 'mv-bad-dest.txt');

    await writeFile(src1, 'move me', 'utf8');

    const result = await env.client.callTool({
      name: 'move',
      arguments: {
        moves: [
          { source: src1, destination: dest1 }, // succeeds
          { source: missingSrc, destination: dest2 }, // fails (missing source)
        ],
      },
    });

    assertOk(result);
    const sc = getStructured(result);

    // src1 must have been moved to dest1
    const content = await readFile(dest1, 'utf8');
    assert.equal(content, 'move me');

    // moves[] must have exactly 1 success
    const moves = sc['moves'] as Record<string, unknown>[];
    assert.equal(moves.length, 1, 'Expected 1 successful move');
    assert.ok((moves[0]['to'] as string).includes('mv-good-dest.txt'));

    // failures[] must have exactly 1 entry for the missing source
    const failures = sc['failures'] as Record<string, unknown>[] | undefined;
    assert.ok(Array.isArray(failures) && failures.length === 1, 'Expected 1 failure');
    assert.ok((failures[0]['source'] as string).includes('mv-missing-src.txt'));

    const failureError = failures[0]['error'] as Record<string, unknown>;
    assert.equal(failureError['code'], 'NOT_FOUND');
    assert.equal(failureError['path'], missingSrc);
    assert.equal(typeof failureError['suggestion'], 'string');
  });
});
