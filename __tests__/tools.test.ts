import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { MUTATING_TOOL_NAMES, registeredTools } from '../src/tools/index.js';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
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
    const firstBlock = result.content[0] as { type: string; text?: string };
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
      const firstBlock = result.content[0] as { type: string; text?: string };
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
      assert.strictEqual(toolsResult.tools.length, 7);
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
            (err as { code: number }).code === -32602
          );
        },
      );
    } finally {
      await readOnlyHarness.close();
    }

    const allTools = registeredTools(false);
    assert.strictEqual(allTools.length, 12);
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
    const structured = result.structuredContent as
      | {
          results?: { error?: { code?: string; message?: string } }[];
          summary?: { failed?: number };
        }
      | undefined;
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
    const readStructured = readRes.structuredContent as
      | {
          summary?: { failed?: number };
          results?: { error?: { code?: string } }[];
        }
      | undefined;
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
    const oldStructured = oldRead.structuredContent as
      { summary?: { failed?: number } } | undefined;
    assert.strictEqual(oldStructured?.summary?.failed, 1);

    const newRead = await harness.client.callTool({
      name: 'read',
      arguments: { path: newFile },
    });
    assert.notStrictEqual(newRead.isError, true);
    const block = newRead.content[0] as { type: string; text?: string };
    assert.ok(block.text?.includes('move me'));
  });

  it('TC-FUNC-052: List roots via MCP tool call', async () => {
    const result = await harness.client.callTool({ name: 'list_roots' });
    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as { roots?: string[] } | undefined;
    assert.ok((structured?.roots?.length ?? 0) > 0, 'Should have at least one allowed directory');
  });
});
