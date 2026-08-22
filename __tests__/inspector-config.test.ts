import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { normalizePath } from '../src/core/path.js';
import {
  cleanupInspectorTestRoot,
  createInspectorConfigFile,
  createInspectorTestRoot,
} from './inspector-fixtures.js';
import { executeInspectorCli } from './inspector-harness.js';

describe('Inspector CLI: Declarative Configuration & Roots (--config)', () => {
  let tmpDir: string;
  let configFile: string;
  const SERVER_NAME = 'fs_config_test';

  before(async () => {
    tmpDir = await createInspectorTestRoot();
    configFile = join(tmpDir, 'test-mcp-config.json');

    const repoRoot = fileURLToPath(new URL('..', import.meta.url));
    const srcIndex = join(repoRoot, 'src/index.ts');

    const rootUri = pathToFileURL(tmpDir).href;

    await createInspectorConfigFile(configFile, SERVER_NAME, {
      command: process.execPath,
      args: ['--import', 'tsx', srcIndex],
      protocolEra: 'modern',
      roots: [{ uri: rootUri, name: 'dynamic-root' }],
    });
  });

  after(async () => {
    await cleanupInspectorTestRoot(tmpDir);
  });

  it('INSP-CFG-001: connects to server named in --config and executes initialize', async () => {
    const res = await executeInspectorCli<{
      serverInfo?: { name?: string };
    }>({
      method: 'initialize',
      configPath: configFile,
      serverName: SERVER_NAME,
    });

    assert.strictEqual(
      res.exitCode,
      0,
      `initialize via --config should exit with 0. stderr: ${res.stderr}`,
    );
    assert.strictEqual(res.json?.serverInfo?.name, 'filesystem-mcp');
  });

  it('INSP-CFG-002: server receives advertised roots configured in session file', async () => {
    const res = await executeInspectorCli<{
      structuredContent?: { roots?: string[] };
    }>({
      method: 'tools/call',
      configPath: configFile,
      serverName: SERVER_NAME,
      toolName: 'list_roots',
      toolArgs: {},
    });

    assert.strictEqual(
      res.exitCode,
      0,
      `tools/call list_roots via --config should exit 0. stderr: ${res.stderr}`,
    );
    const normalizedTmp = normalizePath(tmpDir).toLowerCase();
    const roots = (res.json?.structuredContent?.roots ?? []).map((r) =>
      normalizePath(r).toLowerCase(),
    );
    assert.ok(
      roots.some((r) => r.includes(normalizedTmp) || normalizedTmp.includes(r)),
      `Advertised root should be discovered by server: ${roots.join(', ')} vs ${normalizedTmp}`,
    );
  });
});
