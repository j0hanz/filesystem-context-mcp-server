import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { setAllowedDirectoriesResolved } from '../../lib/path-validation.js';
import {
  CreateDirectoryInputSchema,
  EditFileInputSchema,
  MoveFileInputSchema,
  SearchAndReplaceInputSchema,
} from '../../schemas.js';
import { handleCreateDirectory } from '../../tools/create-directory.js';
import { handleEditFile } from '../../tools/edit-file.js';
import { handleMoveFile } from '../../tools/move-file.js';
import { handleSearchAndReplace } from '../../tools/replace-in-files.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_ROOT = path.join(__dirname, 'enhanced_test_root');

async function setup() {
  await fs.rm(TEST_ROOT, { recursive: true, force: true });
  await fs.mkdir(TEST_ROOT, { recursive: true });
  await setAllowedDirectoriesResolved([TEST_ROOT]);
}

test('Enhanced Tools', async (t) => {
  await setup();

  await t.test('mkdir supports multiple paths', async () => {
    const p1 = path.join(TEST_ROOT, 'dir1');
    const p2 = path.join(TEST_ROOT, 'dir2');

    const args = CreateDirectoryInputSchema.parse({ paths: [p1, p2] });
    await handleCreateDirectory(args);

    const s1 = await fs.stat(p1);
    const s2 = await fs.stat(p2);
    assert.ok(s1.isDirectory());
    assert.ok(s2.isDirectory());
  });

  await t.test('mv supports multiple sources into directory', async () => {
    const f1 = path.join(TEST_ROOT, 'f1.txt');
    const f2 = path.join(TEST_ROOT, 'f2.txt');
    const destDir = path.join(TEST_ROOT, 'dest_dir');

    await fs.writeFile(f1, 'content1');
    await fs.writeFile(f2, 'content2');
    await fs.mkdir(destDir);

    const args = MoveFileInputSchema.parse({
      sources: [f1, f2],
      destination: destDir,
    });
    await handleMoveFile(args);

    assert.strictEqual(
      await fs.readFile(path.join(destDir, 'f1.txt'), 'utf8'),
      'content1'
    );
    assert.strictEqual(
      await fs.readFile(path.join(destDir, 'f2.txt'), 'utf8'),
      'content2'
    );
  });

  await t.test('edit supports ignoreWhitespace', async () => {
    const file = path.join(TEST_ROOT, 'edit_test.txt');
    const content = 'function foo() {\n  return 1;\n}';
    await fs.writeFile(file, content);

    // Attempt to edit with different whitespace (newlines vs spaces)
    const oldText = 'function foo() { return 1; }'; // single line
    const newText = 'function bar() { return 2; }';

    // Should fail without flag (implicit default false)
    const args1 = EditFileInputSchema.parse({
      path: file,
      edits: [{ oldText, newText }],
    });
    const res1 = await handleEditFile(args1);
    assert.strictEqual(res1.structuredContent.appliedEdits, 0);

    // Should succeed with flag
    const args2 = EditFileInputSchema.parse({
      path: file,
      edits: [{ oldText, newText }],
      ignoreWhitespace: true,
    });
    const res2 = await handleEditFile(args2);
    assert.strictEqual(res2.structuredContent.appliedEdits, 1);

    const newContent = await fs.readFile(file, 'utf8');
    assert.strictEqual(newContent, newText);
  });

  await t.test('search_and_replace returns diff', async () => {
    const file = path.join(TEST_ROOT, 'replace_test.txt');
    await fs.writeFile(file, 'hello world');

    const args = SearchAndReplaceInputSchema.parse({
      path: TEST_ROOT,
      filePattern: 'replace_test.txt',
      searchPattern: 'world',
      replacement: 'universe',
      returnDiff: true,
    });

    const res = await handleSearchAndReplace(args);

    assert.ok(res.structuredContent.diff);
    assert.ok(res.structuredContent.diff?.includes('-hello world'));
    assert.ok(res.structuredContent.diff?.includes('+hello universe'));
    assert.strictEqual(await fs.readFile(file, 'utf8'), 'hello universe');
  });
});
