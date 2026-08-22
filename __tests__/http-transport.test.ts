import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { INSTRUCTIONS_URI } from '../src/resources.js';
import {
  cleanupTestRoot,
  createTestHttpHarness,
  createTestRoot,
  type TestHttpContext,
  writeTestFile,
} from './helpers.js';

describe('HTTP In-Process Transport (createMcpHandler / handler.fetch)', () => {
  let tmpDir: string;
  let httpHarness: TestHttpContext;

  before(async () => {
    tmpDir = await createTestRoot();
    httpHarness = await createTestHttpHarness([tmpDir]);
  });

  after(async () => {
    if (httpHarness) {
      await httpHarness.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  it('HTTP-001: Connects client and lists tools over in-process StreamableHTTP', async () => {
    const listResult = await httpHarness.client.listTools();
    assert.strictEqual(listResult.tools.length, 12);
  });

  it('HTTP-002: Executes tool calls over in-process HTTP transport', async () => {
    const filePath = await writeTestFile(tmpDir, 'http_file.txt', 'HTTP transport content');

    const result = await httpHarness.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });

    assert.notStrictEqual(result.isError, true);
    const firstBlock = result.content[0] as { type: string; text?: string };
    assert.strictEqual(firstBlock.type, 'text');
    assert.ok(firstBlock.text?.includes('HTTP transport content'));
  });

  it('HTTP-003: Reads static resource over in-process HTTP transport', async () => {
    const res = await httpHarness.client.readResource({ uri: INSTRUCTIONS_URI });
    assert.strictEqual(res.contents.length, 1);
    assert.strictEqual(res.contents[0].mimeType, 'text/markdown');
  });

  it('HTTP-004: Tool business error returns failed summary over HTTP', async () => {
    const result = await httpHarness.client.callTool({
      name: 'read',
      arguments: { path: join(tmpDir, 'non_existent_http.txt') },
    });

    assert.notStrictEqual(result.isError, true);
    const structured = result.structuredContent as
      | {
          results?: { error?: { code?: string } }[];
          summary?: { failed?: number };
        }
      | undefined;
    assert.strictEqual(structured?.summary?.failed, 1);
    assert.strictEqual(structured?.results?.[0]?.error?.code, 'NOT_FOUND');
  });
});
