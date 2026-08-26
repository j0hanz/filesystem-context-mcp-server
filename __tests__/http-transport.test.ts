import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { INSTRUCTIONS_URI } from '../src/instructions.js';
import { ALL_REGISTERED_TOOL_NAMES } from '../src/tools/index.js';
import {
  cleanupTestRoot,
  createTestHttpHarness,
  createTestRoot,
  failedSummary,
  firstTextBlock,
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
    assert.strictEqual(listResult.tools.length, ALL_REGISTERED_TOOL_NAMES.length);
  });

  it('HTTP-002: Executes tool calls over in-process HTTP transport', async () => {
    const filePath = await writeTestFile(tmpDir, 'http_file.txt', 'HTTP transport content');

    const result = await httpHarness.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });

    assert.notStrictEqual(result.isError, true);
    const firstBlock = firstTextBlock(result);
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

    // A business error stays a tool *result* — a structured per-path summary,
    // never a JSON-RPC protocol error. It is still a failed call: every path
    // failed, so `isError` says so rather than handing the client an error
    // message it would read as file content.
    assert.strictEqual(result.isError, true);
    const structured = failedSummary(result);
    assert.strictEqual(structured?.summary?.failed, 1);
    assert.strictEqual(structured?.results?.[0]?.error?.code, 'NOT_FOUND');
  });

  it('HTTP-005: modern discover carries the serverInfo _meta stamp and cache hints on the wire', () => {
    // Spec PR #3002: server identity rides _meta['io.modelcontextprotocol/serverInfo']
    // on 2026-era responses; getServerVersion() reads the discover result's stamp.
    const version = httpHarness.client.getServerVersion();
    assert.strictEqual(version?.name, 'filesystem-mcp');
    assert.ok(version.version, 'the _meta serverInfo stamp must carry a version');

    // ttlMs/cacheScope are hidden from the public DiscoverResult type but kept
    // at runtime; the cast reads what serverConfig.cacheHints actually emitted
    // (the wire parse defaults an OMITTED hint to 0/'private', so these values
    // prove the advertised policy reached the wire).
    const discover = httpHarness.client.getDiscoverResult() as
      { ttlMs?: number; cacheScope?: string } | undefined;
    assert.ok(discover, 'a modern connection must retain its discover result');
    assert.strictEqual(discover.ttlMs, 3_600_000);
    assert.strictEqual(discover.cacheScope, 'public');
  });
});
