/**
 * Integration tests for diff_files tool.
 */
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertOk, createTestEnv, getStructured, type TestEnv } from '../helpers.js';

describe('diff_files tool', () => {
  let env: TestEnv;
  let originalFile: string;
  let modifiedFile: string;

  before(async () => {
    env = await createTestEnv();
    originalFile = join(env.tmpDir, 'original.txt');
    modifiedFile = join(env.tmpDir, 'modified.txt');
  });

  after(async () => {
    await env.cleanup();
  });

  it('generates diff between text files', async () => {
    await writeFile(originalFile, 'line1\nline2\nline3\n', 'utf8');
    await writeFile(modifiedFile, 'line1\nmodified2\nline3\n', 'utf8');

    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: { original: originalFile, modified: modifiedFile },
    });
    const result = raw;
    assertOk(result);

    // Verify summary text and resource link
    assert.ok(result.content.length >= 2, 'Expected summary text and resource link');
    const summaryBlock = result.content[0];
    assert.equal(summaryBlock.type, 'text');
    const summaryText = (summaryBlock as { text: string }).text;
    assert.match(summaryText, /diff-files:/);
    assert.match(summaryText, /original\.txt/);
    assert.match(summaryText, /modified\.txt/);
    assert.match(summaryText, /change/);

    const linkBlock = result.content[1];
    assert.equal(linkBlock.type, 'resource_link');
    assert.equal(
      (linkBlock as { name: string }).name,
      'diff.patch',
      'Expected resource link name to be "diff.patch"',
    );
    assert.equal(
      (linkBlock as { mimeType: string }).mimeType,
      'text/x-patch',
      'Expected MIME type to be text/x-patch',
    );

    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(sc['isIdentical'], false);
    assert.ok(sc['changeCount'] !== undefined);
    assert.ok(sc['changeCount'] > 0, 'Expected positive change count');
    assert.ok(sc['resourceUri'], 'Expected resourceUri in structured content');
    assert.match(
      sc['resourceUri'] as string,
      /^filesystem-mcp:\/\/result\//,
      'Expected resourceUri to be a filesystem-mcp resource link',
    );
  });

  it('detects identical files', async () => {
    const file = join(env.tmpDir, 'identical.txt');
    await writeFile(file, 'content\n', 'utf8');

    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: { original: file, modified: file },
    });
    const result = raw;
    assertOk(result);

    // Verify summary for identical files
    const summaryBlock = result.content[0];
    assert.equal(summaryBlock.type, 'text');
    const summaryText = (summaryBlock as { text: string }).text;
    assert.match(summaryText, /No differences/);

    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(sc['isIdentical'], true);
    assert.equal(sc['diff'], '', 'Expected empty diff for identical files');
  });

  it('diff-files with large diffs', async () => {
    // Create files with significant differences (50+ lines)
    const original = Array.from({ length: 100 }, (_, i) => `original line ${i + 1}`).join('\n');
    const modified = Array.from({ length: 100 }, (_, i) =>
      i % 2 === 0 ? `modified line ${i + 1}` : `original line ${i + 1}`,
    ).join('\n');

    const originalLargeFile = join(env.tmpDir, 'large-original.txt');
    const modifiedLargeFile = join(env.tmpDir, 'large-modified.txt');

    await writeFile(originalLargeFile, original, 'utf8');
    await writeFile(modifiedLargeFile, modified, 'utf8');

    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: { original: originalLargeFile, modified: modifiedLargeFile },
    });
    const result = raw;
    assertOk(result);

    // Verify that large diff is stored as resource link
    assert.ok(result.content.length >= 2, 'Expected summary and resource link');
    const linkBlock = result.content[1];
    assert.equal(linkBlock.type, 'resource_link', 'Expected resource_link type');

    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(sc['isIdentical'], false);
    assert.ok(sc['changeCount'] > 40, 'Expected significant change count for 50+ line changes');
    assert.ok(sc['resourceUri'], 'Expected resourceUri in structured content');
  });

  it('correctly calculates change count', async () => {
    // Create simple files where we know exact change count
    const original = 'line1\nline2\nline3\n';
    const modified = 'line1\nnew line\nline3\n';

    const originalCountFile = join(env.tmpDir, 'count-original.txt');
    const modifiedCountFile = join(env.tmpDir, 'count-modified.txt');

    await writeFile(originalCountFile, original, 'utf8');
    await writeFile(modifiedCountFile, modified, 'utf8');

    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: { original: originalCountFile, modified: modifiedCountFile },
    });
    const result = raw;
    assertOk(result);

    const sc = getStructured(result);
    assert.equal(sc['changeCount'], 2, 'Expected change count of 2 (1 line removed, 1 line added)');
  });

  it('respects context lines parameter', async () => {
    // Create files where context parameter matters
    const originalContextFile = join(env.tmpDir, 'context-original.txt');
    const modifiedContextFile = join(env.tmpDir, 'context-modified.txt');

    const lines = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);
    lines[10] = 'modified line 11';
    const modified = lines.join('\n');
    const original = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

    await writeFile(originalContextFile, original, 'utf8');
    await writeFile(modifiedContextFile, modified, 'utf8');

    const raw = await env.client.callTool({
      name: 'diff_files',
      arguments: {
        original: originalContextFile,
        modified: modifiedContextFile,
        context: 1,
      },
    });
    const result = raw;
    assertOk(result);

    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(sc['isIdentical'], false);
    // With context: 1, the diff should be smaller than with default context
    assert.ok(sc['diff']);
  });
});
