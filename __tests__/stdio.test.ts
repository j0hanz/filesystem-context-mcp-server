import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ALL_REGISTERED_TOOL_NAMES } from '../src/tools/index.js';
import {
  cleanupTestRoot,
  createStdioClient,
  createTestRoot,
  firstTextBlock,
  writeTestFile,
} from './helpers.js';

describe('Stdio Transport (real subprocess)', () => {
  let tmpDir: string;
  let harness: Awaited<ReturnType<typeof createStdioClient>>;

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createStdioClient(tmpDir);
  });

  after(async () => {
    if (harness) await harness.close();
    if (tmpDir) await cleanupTestRoot(tmpDir);
  });

  it('STDIO-001: lists all tools over a real stdio subprocess', async () => {
    const tools = await harness.client.listTools();
    assert.strictEqual(tools.tools.length, ALL_REGISTERED_TOOL_NAMES.length);
  });

  it('STDIO-002: reads a file over a real stdio subprocess', async () => {
    const filePath = await writeTestFile(tmpDir, 'stdio.txt', 'stdio content');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });
    assert.notStrictEqual(result.isError, true);
    assert.ok(firstTextBlock(result).text?.includes('stdio content'));
  });
});
