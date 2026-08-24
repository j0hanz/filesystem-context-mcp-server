import { Client, InMemoryTransport } from '@modelcontextprotocol/client';
import { ProtocolErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createServer } from '../src/server.js';
import {
  ALL_REGISTERED_TOOL_NAMES,
  ALL_TOOLS,
  MUTATING_TOOL_NAMES,
  registeredTools,
} from '../src/tools/index.js';
import {
  cleanupTestRoot,
  createElicitationClientPair,
  createTestClientPair,
  createTestRoot,
  failedSummary,
  firstTextBlock,
  type TestClientContext,
} from './helpers.js';

describe('P0 Functional Tests - Tools (MCP Client)', () => {
  let tmpDir: string;
  let harness: TestClientContext;

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createTestClientPair([tmpDir]);
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  it('TC-FUNC-001: Read single text file via MCP tool call', async () => {
    const file = join(tmpDir, 'hello.txt');
    await writeFile(file, 'Hello\nWorld\n');

    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    assert.notStrictEqual(result.isError, true);
    const firstBlock = firstTextBlock(result);
    assert.strictEqual(firstBlock.type, 'text');
    assert.ok(firstBlock.text?.includes('Hello\nWorld\n'));
  });

  it('TC-FUNC-007: Read path outside allowed root returns isError: true with ACCESS_DENIED', async () => {
    const outsideFile = join(tmpdir(), 'outside_test.txt');
    await writeFile(outsideFile, 'secret');
    try {
      const result = await harness.client.callTool({
        name: 'read',
        arguments: { path: outsideFile },
      });
      assert.strictEqual(result.isError, true);
      const firstBlock = firstTextBlock(result);
      assert.ok(firstBlock.text);
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it('TC-FUNC-009: Create single file via MCP tool call', async () => {
    const file = join(tmpDir, 'new.txt');
    const result = await harness.client.callTool({
      name: 'create',
      arguments: { files: [{ path: file, content: 'new content' }] },
    });
    assert.notStrictEqual(result.isError, true);

    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'new content');
  });

  it('TC-FUNC-012: --read-only suppresses mutating tools on client.listTools()', async () => {
    const readOnlyHarness = await createTestClientPair([tmpDir], { readOnly: true });
    try {
      const toolsResult = await readOnlyHarness.client.listTools();
      assert.strictEqual(toolsResult.tools.length, registeredTools(true).length);
      for (const tool of toolsResult.tools) {
        assert(!MUTATING_TOOL_NAMES.has(tool.name));
      }

      // Calling a mutating tool on read-only server should reject with -32602
      await assert.rejects(
        async () => {
          await readOnlyHarness.client.callTool({
            name: 'create',
            arguments: { files: [{ path: join(tmpDir, 'fail.txt'), content: 'fail' }] },
          });
        },
        (err: unknown) => {
          return (
            typeof err === 'object' &&
            err !== null &&
            'code' in err &&
            (err as { code: ProtocolErrorCode }).code === ProtocolErrorCode.InvalidParams
          );
        },
      );
    } finally {
      await readOnlyHarness.close();
    }

    const allTools = registeredTools(false);
    assert.strictEqual(allTools.length, ALL_REGISTERED_TOOL_NAMES.length);
  });

  it('TC-FUNC-013: Edit via MCP tool call', async () => {
    const file = join(tmpDir, 'edit.txt');
    await writeFile(file, 'original content');

    const result = await harness.client.callTool({
      name: 'edit',
      arguments: {
        path: file,
        edits: [{ oldText: 'original', newText: 'modified' }],
      },
    });
    assert.notStrictEqual(result.isError, true);

    const content = await readFile(file, 'utf-8');
    assert.strictEqual(content, 'modified content');
  });

  it('TC-FUNC-015: Read non-existent file returns error in per-path results', async () => {
    const missing = join(tmpDir, 'missing.txt');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: missing },
    });
    const structured = failedSummary(result);
    assert.strictEqual(structured?.summary?.failed, 1);
    assert.strictEqual(structured?.results?.[0]?.error?.code, 'NOT_FOUND');
  });

  it('TC-FUNC-017: Delete file via MCP tool call', async () => {
    const file = join(tmpDir, 'delete.txt');
    await writeFile(file, 'to delete');

    const result = await harness.client.callTool({
      name: 'delete',
      arguments: { paths: [file] },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as { ok?: boolean } | undefined;
    assert.strictEqual(structured?.ok, true);

    const readRes = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    const readStructured = failedSummary(readRes);
    assert.strictEqual(readStructured?.summary?.failed, 1);
    assert.strictEqual(readStructured?.results?.[0]?.error?.code, 'NOT_FOUND');
  });

  it('TC-FUNC-021: Move/rename via MCP tool call', async () => {
    const file = join(tmpDir, 'old.txt');
    const newFile = join(tmpDir, 'new_name.txt');
    await writeFile(file, 'move me');

    const result = await harness.client.callTool({
      name: 'move',
      arguments: { moves: [{ source: file, destination: newFile }] },
    });
    assert.notStrictEqual(result.isError, true);

    const oldRead = await harness.client.callTool({
      name: 'read',
      arguments: { path: file },
    });
    const oldStructured = failedSummary(oldRead);
    assert.strictEqual(oldStructured?.summary?.failed, 1);

    const newRead = await harness.client.callTool({
      name: 'read',
      arguments: { path: newFile },
    });
    assert.notStrictEqual(newRead.isError, true);
    const block = firstTextBlock(newRead);
    assert.ok(block.text?.includes('move me'));
  });

  it('TC-FUNC-052: List roots via MCP tool call', async () => {
    const result = await harness.client.callTool({ name: 'list_roots' });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as { roots?: string[] } | undefined;
    assert.ok((structured?.roots?.length ?? 0) > 0, 'Should have at least one allowed directory');
  });

  it('TC-FUNC-053: Copy with overwrite: true succeeds when destination exists', async () => {
    const src = join(tmpDir, 'copy_ow_src.txt');
    const dst = join(tmpDir, 'copy_ow_dst.txt');
    await writeFile(src, 'new source');
    await writeFile(dst, 'existing dst');

    const result = await harness.client.callTool({
      name: 'copy',
      arguments: {
        copies: [{ source: src, destination: dst }],
        overwrite: true,
      },
    });
    assert.notStrictEqual(result.isError, true);
    const dstContent = await readFile(dst, 'utf-8');
    assert.strictEqual(dstContent, 'new source');
  });

  it('TC-FUNC-054: Copy single file via MCP tool call', async () => {
    const src = join(tmpDir, 'copy_src.txt');
    const dst = join(tmpDir, 'copy_dst.txt');
    await writeFile(src, 'copy content');

    const result = await harness.client.callTool({
      name: 'copy',
      arguments: {
        copies: [{ source: src, destination: dst }],
      },
    });
    assert.notStrictEqual(result.isError, true);

    const srcContent = await readFile(src, 'utf-8');
    const dstContent = await readFile(dst, 'utf-8');
    assert.strictEqual(srcContent, 'copy content');
    assert.strictEqual(dstContent, 'copy content');
  });

  it('TC-FUNC-055: Copy recursive directory via MCP tool call', async () => {
    const srcDir = join(tmpDir, 'copy_src_dir');
    const dstDir = join(tmpDir, 'copy_dst_dir');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(srcDir, 'sub'), { recursive: true });
    await writeFile(join(srcDir, 'file1.txt'), 'file1');
    await writeFile(join(srcDir, 'sub', 'file2.txt'), 'file2');

    const result = await harness.client.callTool({
      name: 'copy',
      arguments: {
        copies: [{ source: srcDir, destination: dstDir }],
      },
    });
    assert.notStrictEqual(result.isError, true);

    const dst1 = await readFile(join(dstDir, 'file1.txt'), 'utf-8');
    const dst2 = await readFile(join(dstDir, 'sub', 'file2.txt'), 'utf-8');
    assert.strictEqual(dst1, 'file1');
    assert.strictEqual(dst2, 'file2');
  });

  it('TC-FUNC-056: Copy out-of-root source returns isError: true with ACCESS_DENIED', async () => {
    const outsideFile = join(tmpdir(), 'outside_copy.txt');
    await writeFile(outsideFile, 'secret');
    try {
      const result = await harness.client.callTool({
        name: 'copy',
        arguments: {
          copies: [{ source: outsideFile, destination: join(tmpDir, 'stolen.txt') }],
        },
      });
      assert.strictEqual(result.isError, true);
    } finally {
      await rm(outsideFile, { force: true });
    }
  });

  it('TC-FUNC-057: long-running tools declare execution taskSupport metadata', () => {
    const taskTools = ['search_text', 'find_files', 'replace_text', 'hash_file', 'copy', 'delete'];
    for (const name of taskTools) {
      const tool = ALL_TOOLS.find((t) => t.name === name);
      assert.ok(tool, `${name} tool should be defined`);
      assert.deepStrictEqual(tool.execution, { taskSupport: 'optional' });
    }
  });

  it('TC-FUNC-058: list tool declares idempotentHint', () => {
    const listTool = ALL_TOOLS.find((t) => t.name === 'list');
    assert.ok(listTool, 'list tool should be defined');
    assert.strictEqual(listTool.annotations.idempotentHint, true);
  });

  it('TC-FUNC-059: createServer wires notifier to tool context on grant', async () => {
    const parentDir = await createTestRoot();
    const rootDir = join(parentDir, 'root');
    const outsideDir = join(parentDir, 'outside');
    await mkdir(rootDir, { recursive: true });
    await mkdir(outsideDir, { recursive: true });
    const outsideFile = join(outsideDir, 'file.txt');
    await writeFile(outsideFile, 'test content');

    const prevBoundary = process.env['ROOT_BOUNDARY'];
    process.env['ROOT_BOUNDARY'] = parentDir;

    let notified = false;
    const notifier = {
      resourcesChanged: () => {
        notified = true;
      },
      resourceUpdated: () => {},
    };

    try {
      const serverCtx = await createServer({ cliAllowedDirs: [rootDir] }, { notifier });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client(
        { name: 'test-harness', version: '1.0.0' },
        { capabilities: { elicitation: {} } },
      );
      client.setRequestHandler('elicitation/create', async () => {
        return {
          action: 'accept',
          content: { confirm: true },
        };
      });
      await Promise.all([client.connect(clientTransport), serverCtx.mcp.connect(serverTransport)]);

      try {
        assert.strictEqual(notified, false);
        const result = await client.callTool({
          name: 'read',
          arguments: { path: outsideFile },
        });
        assert.notStrictEqual(result.isError, true);
        assert.strictEqual(notified, true, 'notifier.resourcesChanged should be called on grant');
      } finally {
        await client.close();
        await serverCtx.close();
      }
    } finally {
      if (prevBoundary !== undefined) {
        process.env['ROOT_BOUNDARY'] = prevBoundary;
      } else {
        delete process.env['ROOT_BOUNDARY'];
      }
      await cleanupTestRoot(parentDir);
    }
  });

  it('TC-FUNC-060: diff two files returns a unified diff', async () => {
    const a = join(tmpDir, 'diff_a.txt');
    const b = join(tmpDir, 'diff_b.txt');
    await writeFile(a, 'x\ny\nz\n');
    await writeFile(b, 'x\nY\nz\n');
    const result = await harness.client.callTool({
      name: 'diff',
      arguments: { a, b },
    });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as {
      linesAdded?: number;
      linesRemoved?: number;
      diff?: string;
    };
    assert.strictEqual(structured.linesAdded, 1);
    assert.strictEqual(structured.linesRemoved, 1);
    assert.ok(structured.diff?.includes('-y') && structured.diff?.includes('+Y'));
  });

  it('TC-FUNC-061: patch applies a unified diff', async () => {
    const f = join(tmpDir, 'patch_target.txt');
    await writeFile(f, 'a\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({
      name: 'patch',
      arguments: { path: f, diff },
    });
    assert.notStrictEqual(result.isError, true);
    assert.strictEqual(await readFile(f, 'utf-8'), 'X\nb\nc\n');
  });

  it('TC-FUNC-062: patch that does not apply returns isError', async () => {
    const f = join(tmpDir, 'patch_bad.txt');
    await writeFile(f, 'q\nb\nc\n');
    const diff = '--- f.txt\n+++ f.txt\n@@ -1,2 +1,2 @@\n-a\n+X\n b\n';
    const result = await harness.client.callTool({ name: 'patch', arguments: { path: f, diff } });
    assert.strictEqual(result.isError, true);
  });

  it('TC-FUNC-063: list paginates entries via nextCursor', async () => {
    const sub = join(tmpDir, 'page_dir');
    await mkdir(sub, { recursive: true });
    for (let i = 0; i < 4; i++) await writeFile(join(sub, `f${i}.txt`), 'x');
    const r1 = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2 },
    });
    const s1 = r1.structuredContent as { nextCursor?: string; entryCount?: number };
    assert.strictEqual(s1.entryCount, 2);
    assert.ok(s1.nextCursor, 'first page should yield a nextCursor');
    const r2 = await harness.client.callTool({
      name: 'list',
      arguments: { path: sub, maxEntries: 2, cursor: s1.nextCursor },
    });
    const s2 = r2.structuredContent as { nextCursor?: string; entryCount?: number };
    assert.strictEqual(s2.entryCount, 2);
    assert.ok(!s2.nextCursor, 'second page is the last');
  });

  it('TC-LOG-001: Tool execution logs to stderr', async () => {
    const file = join(tmpDir, 'log-test.txt');
    await writeFile(file, 'initial line\n');
    const origErr = console.error;
    const lines: string[] = [];
    console.error = (...args: unknown[]) => {
      lines.push(args.map(String).join(' '));
    };
    try {
      const result = await harness.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText: 'initial', newText: 'updated' }] },
      });
      assert.notStrictEqual(result.isError, true);
      assert.ok(
        lines.some((l) => l.includes('edit:')),
        'stderr should carry the edit log line',
      );
    } finally {
      console.error = origErr;
    }
  });

  it('TC-FUNC-064: copy skip via choice round-trip leaves dst untouched', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'skip' },
    }));
    try {
      const src = join(tmpDir, 'choice_skip_src.txt');
      const dst = join(tmpDir, 'choice_skip_dst.txt');
      await writeFile(src, 'new source');
      await writeFile(dst, 'existing dst');
      const result = await eh.client.callTool({
        name: 'copy',
        arguments: { copies: [{ source: src, destination: dst }] },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result.structuredContent as { copies?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.copies?.length, 0);
      assert.ok(s.skipped?.includes(dst));
      assert.strictEqual(await readFile(dst, 'utf-8'), 'existing dst');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-065: copy overwrite via choice round-trip replaces dst', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'overwrite' },
    }));
    try {
      const src = join(tmpDir, 'choice_ow_src.txt');
      const dst = join(tmpDir, 'choice_ow_dst.txt');
      await writeFile(src, 'new source');
      await writeFile(dst, 'existing dst');
      const result = await eh.client.callTool({
        name: 'copy',
        arguments: { copies: [{ source: src, destination: dst }] },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result.structuredContent as { copies?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.copies?.length, 1);
      assert.strictEqual(s.skipped, undefined);
      assert.strictEqual(await readFile(dst, 'utf-8'), 'new source');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-066: move skip via choice round-trip leaves src and dst intact', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'skip' },
    }));
    try {
      const src = join(tmpDir, 'move_skip_src.txt');
      const dst = join(tmpDir, 'move_skip_dst.txt');
      await writeFile(src, 'move me');
      await writeFile(dst, 'dst stays');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }] },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result.structuredContent as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 0);
      assert.ok(s.skipped?.includes(dst));
      assert.strictEqual(await readFile(src, 'utf-8'), 'move me');
      assert.strictEqual(await readFile(dst, 'utf-8'), 'dst stays');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-067: move overwrite via choice round-trip replaces dst', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'overwrite' },
    }));
    try {
      const src = join(tmpDir, 'move_ow_src.txt');
      const dst = join(tmpDir, 'move_ow_dst.txt');
      await writeFile(src, 'move me');
      await writeFile(dst, 'dst old');
      const result = await eh.client.callTool({
        name: 'move',
        arguments: { moves: [{ source: src, destination: dst }] },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result.structuredContent as { moves?: unknown[]; skipped?: string[] };
      assert.strictEqual(s.moves?.length, 1);
      assert.strictEqual(s.skipped, undefined);
      assert.strictEqual(await readFile(dst, 'utf-8'), 'move me');
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-068: delete skip via choice round-trip leaves dir in place', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'skip' },
    }));
    try {
      const dir = join(tmpDir, 'del_skip_dir');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'sub', 'f.txt'), 'x');
      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result.structuredContent as {
        ok?: boolean;
        failures?: { path?: string }[];
        skipped?: string[];
      };
      assert.strictEqual(s.ok, true);
      assert.ok((s.failures?.length ?? 0) === 0);
      assert.ok(s.skipped?.some((p) => p.toLowerCase() === dir.toLowerCase()));
      await access(dir); // still exists
    } finally {
      await eh.close();
    }
  });

  it('TC-FUNC-069: delete via choice round-trip removes the dir', async () => {
    const eh = await createElicitationClientPair([tmpDir], async () => ({
      action: 'accept' as const,
      content: { choice: 'delete' },
    }));
    try {
      const dir = join(tmpDir, 'del_choice_dir');
      await mkdir(join(dir, 'sub'), { recursive: true });
      await writeFile(join(dir, 'sub', 'f.txt'), 'x');
      const result = await eh.client.callTool({
        name: 'delete',
        arguments: { paths: [dir], recursive: true },
      });
      assert.notStrictEqual(result.isError, true);
      const s = result.structuredContent as {
        ok?: boolean;
        path?: string;
        skipped?: string[];
      };
      assert.strictEqual(s.ok, true);
      assert.strictEqual(s.path?.toLowerCase(), dir.toLowerCase());
      assert.strictEqual(s.skipped, undefined);
      await assert.rejects(() => access(dir));
    } finally {
      await eh.close();
    }
  });
});
