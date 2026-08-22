import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { normalizePath } from '../src/core/path.js';
import { ALL_REGISTERED_TOOL_NAMES, MUTATING_TOOL_NAMES } from '../src/tools/index.js';
import {
  cleanupInspectorTestRoot,
  createInspectorTestRoot,
  getStdioServerCommand,
} from './inspector-fixtures.js';
import { executeInspectorCli } from './inspector-harness.js';

describe('Inspector CLI: Stdio Integration & Conformance', () => {
  let tmpDir: string;
  let serverCmd: string[];

  before(async () => {
    tmpDir = await createInspectorTestRoot();
    serverCmd = getStdioServerCommand();
  });

  after(async () => {
    await cleanupInspectorTestRoot(tmpDir);
  });

  it('INSP-STDIO-001: initialize returns serverInfo and capabilities', async () => {
    const res = await executeInspectorCli<{
      serverInfo?: { name?: string; version?: string };
      protocolVersion?: string;
      capabilities?: Record<string, unknown>;
      instructions?: string;
    }>({
      method: 'initialize',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
    });

    assert.strictEqual(res.exitCode, 0, `initialize should exit with 0. stderr: ${res.stderr}`);
    assert.strictEqual(res.json?.serverInfo?.name, 'filesystem-mcp');
    assert.ok(res.json?.protocolVersion, 'protocolVersion should be returned');
    assert.ok(res.json?.capabilities?.tools, 'capabilities.tools should be present');
    assert.ok(res.json?.capabilities?.resources, 'capabilities.resources should be present');
    assert.ok(res.json?.capabilities?.prompts, 'capabilities.prompts should be present');
    assert.ok(res.json?.instructions?.includes('filesystem-mcp'), 'instructions should be present');
  });

  it('INSP-STDIO-002: tools/list returns all registered tools in default mode', async () => {
    const res = await executeInspectorCli<{
      tools?: { name: string; description?: string; inputSchema?: unknown }[];
    }>({
      method: 'tools/list',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
    });

    assert.strictEqual(res.exitCode, 0, `tools/list should exit with 0. stderr: ${res.stderr}`);
    const toolNames = res.json?.tools?.map((t) => t.name) ?? [];
    assert.strictEqual(toolNames.length, ALL_REGISTERED_TOOL_NAMES.length);
    for (const expectedTool of ALL_REGISTERED_TOOL_NAMES) {
      assert.ok(toolNames.includes(expectedTool), `Expected tool ${expectedTool} in listing`);
    }
  });

  it('INSP-STDIO-003: tools/list excludes mutating tools when launched with --read-only', async () => {
    const res = await executeInspectorCli<{
      tools?: { name: string }[];
    }>({
      method: 'tools/list',
      serverCommand: serverCmd,
      serverArgs: ['--read-only', tmpDir],
    });

    assert.strictEqual(res.exitCode, 0, `tools/list should exit with 0. stderr: ${res.stderr}`);
    const toolNames = res.json?.tools?.map((t) => t.name) ?? [];
    for (const mutating of MUTATING_TOOL_NAMES) {
      assert.ok(
        !toolNames.includes(mutating),
        `Mutating tool ${mutating} should be excluded in --read-only mode`,
      );
    }
    assert.ok(toolNames.includes('read'), 'read tool should be available in read-only mode');
    assert.ok(
      toolNames.includes('list_roots'),
      'list_roots tool should be available in read-only mode',
    );
  });

  it('INSP-STDIO-004: tools/call list_roots returns allowed roots', async () => {
    const res = await executeInspectorCli<{
      content?: { type: string; text: string }[];
      structuredContent?: { roots?: string[] };
    }>({
      method: 'tools/call',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
      toolName: 'list_roots',
      toolArgs: {},
    });

    assert.strictEqual(
      res.exitCode,
      0,
      `tools/call list_roots should exit with 0. stderr: ${res.stderr}`,
    );
    const normalizedTmp = normalizePath(tmpDir);
    const roots = res.json?.structuredContent?.roots?.map(normalizePath) ?? [];
    assert.ok(
      roots.includes(normalizedTmp),
      `Expected ${normalizedTmp} in roots: ${roots.join(', ')}`,
    );
  });

  it('INSP-STDIO-005: tools/call create and read roundtrip', async () => {
    const targetFile = join(tmpDir, 'insp-roundtrip.txt');
    const testContent = 'Hello from MCP Inspector CLI test!';

    const createRes = await executeInspectorCli({
      method: 'tools/call',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
      toolName: 'create',
      toolArgs: {
        files: [
          {
            path: targetFile,
            content: testContent,
          },
        ],
      },
    });

    assert.strictEqual(
      createRes.exitCode,
      0,
      `tools/call create should exit 0. stderr: ${createRes.stderr}`,
    );

    const readRes = await executeInspectorCli<{
      content?: { type: string; text: string }[];
    }>({
      method: 'tools/call',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
      toolName: 'read',
      toolArgs: {
        path: targetFile,
      },
    });

    assert.strictEqual(
      readRes.exitCode,
      0,
      `tools/call read should exit 0. stderr: ${readRes.stderr}`,
    );
    const readText = readRes.json?.content?.[0]?.text ?? '';
    assert.ok(
      readText.includes(testContent),
      `Read text should contain created content: ${readText}`,
    );
  });

  it('INSP-STDIO-006: tools/call stat returns file metadata', async () => {
    const targetFile = join(tmpDir, 'insp-stat.txt');

    await executeInspectorCli({
      method: 'tools/call',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
      toolName: 'create',
      toolArgs: {
        files: [{ path: targetFile, content: 'Stat payload' }],
      },
    });

    const statRes = await executeInspectorCli<{
      structuredContent?: {
        results?: { value?: { size?: number; type?: string } }[];
      };
    }>({
      method: 'tools/call',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
      toolName: 'stat',
      toolArgs: { path: targetFile },
    });

    assert.strictEqual(
      statRes.exitCode,
      0,
      `tools/call stat should exit 0. stderr: ${statRes.stderr}`,
    );
    const firstResult = statRes.json?.structuredContent?.results?.[0]?.value;
    assert.strictEqual(firstResult?.type === 'directory', false);
    assert.ok(typeof firstResult?.size === 'number' && firstResult.size > 0);
  });

  it('INSP-STDIO-007: resources/list and resources/read retrieve instructions', async () => {
    const listRes = await executeInspectorCli<{
      resources?: { uri: string; name?: string }[];
    }>({
      method: 'resources/list',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
    });

    assert.strictEqual(
      listRes.exitCode,
      0,
      `resources/list should exit 0. stderr: ${listRes.stderr}`,
    );
    const uris = listRes.json?.resources?.map((r) => r.uri) ?? [];
    assert.ok(
      uris.some((u) => u.includes('instructions')),
      'instructions resource should be in list',
    );

    const instructionsUri =
      uris.find((u) => u.includes('instructions')) ?? 'internal://instructions';
    const readRes = await executeInspectorCli<{
      contents?: { uri: string; text?: string }[];
    }>({
      method: 'resources/read',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
      uri: instructionsUri,
    });

    assert.strictEqual(
      readRes.exitCode,
      0,
      `resources/read should exit 0. stderr: ${readRes.stderr}`,
    );
    const text = readRes.json?.contents?.[0]?.text ?? '';
    assert.ok(text.length > 0, 'Resource contents should not be empty');
  });

  it('INSP-STDIO-008: prompts/list returns registered prompts', async () => {
    const res = await executeInspectorCli<{
      prompts?: { name: string; description?: string }[];
    }>({
      method: 'prompts/list',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
    });

    assert.strictEqual(res.exitCode, 0, `prompts/list should exit 0. stderr: ${res.stderr}`);
    const promptNames = res.json?.prompts?.map((p) => p.name) ?? [];
    assert.ok(promptNames.includes('get-help'), 'get-help prompt should be listed');
  });

  it('INSP-STDIO-009: tools/call out-of-boundary path traversal returns ACCESS_DENIED', async () => {
    const badPath = join(tmpDir, '../../../../etc/shadow');
    const res = await executeInspectorCli<{
      structuredContent?: {
        results?: { error?: { code?: string; message?: string } }[];
      };
    }>({
      method: 'tools/call',
      serverCommand: serverCmd,
      serverArgs: ['--root-boundary', tmpDir, tmpDir],
      toolName: 'read',
      toolArgs: { path: badPath },
    });

    assert.strictEqual(
      res.exitCode,
      0,
      `Out-of-root access should exit with code 0. Actual: ${res.exitCode}, stdout: ${res.stdout}`,
    );
    const firstResult = res.json?.structuredContent?.results?.[0];
    assert.strictEqual(firstResult?.error?.code, 'ACCESS_DENIED');
  });

  it('INSP-STDIO-010: tools/call non-existent tool exits with Code 5', async () => {
    const res = await executeInspectorCli({
      method: 'tools/call',
      serverCommand: serverCmd,
      serverArgs: [tmpDir],
      toolName: 'non_existent_tool_name_xyz',
      toolArgs: {},
    });

    assert.strictEqual(
      res.exitCode,
      5,
      `Non-existent tool should exit with code 5. Actual: ${res.exitCode}`,
    );
  });
});
