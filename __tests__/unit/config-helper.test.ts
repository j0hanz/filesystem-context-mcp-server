import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  allowPath,
  disallowPath,
  getExistingConfigPaths,
  listAllowedPaths,
  parseArgs,
  writeJsonAtomic,
} from '../../src/cli.js';

describe('mcp-config-helper', () => {
  it('getExistingConfigPaths returns Windows paths when config files exist', () => {
    const mockEnv = { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' };
    const mockHome = 'C:\\Users\\test';
    const appData = 'C:\\Users\\test\\AppData\\Roaming';
    const existingPaths = new Set([
      join(appData, 'Claude', 'claude_desktop_config.json'),
      join(mockHome, '.cursor', 'mcp.json'),
      join(mockHome, '.mcp.json'),
      join(
        appData,
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json',
      ),
      join(
        appData,
        'Code',
        'User',
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'mcp_settings.json',
      ),
    ]);
    const mockExists = (p: string) => existingPaths.has(p);

    const paths = getExistingConfigPaths(mockEnv, 'win32', mockHome, mockExists);

    assert.strictEqual(paths.length, 5);
    assert.strictEqual(paths[0].name, 'Claude Desktop');
    assert.strictEqual(paths[1].name, 'Cursor Global');
    assert.strictEqual(paths[2].name, 'Global MCP (.mcp.json)');
    assert.strictEqual(paths[3].name, 'VS Code Cline Extension');
    assert.strictEqual(paths[4].name, 'VS Code Roo Code Extension');
  });

  it('getExistingConfigPaths returns macOS paths when config files exist', () => {
    const mockEnv = {};
    const mockHome = '/Users/test';
    const existingPaths = new Set([
      join(mockHome, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
      join(mockHome, '.cursor', 'mcp.json'),
      join(mockHome, '.mcp.json'),
      join(
        mockHome,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json',
      ),
      join(
        mockHome,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'rooveterinaryinc.roo-cline',
        'settings',
        'mcp_settings.json',
      ),
    ]);
    const mockExists = (p: string) => existingPaths.has(p);

    const paths = getExistingConfigPaths(mockEnv, 'darwin', mockHome, mockExists);

    assert.strictEqual(paths.length, 5);
    assert.strictEqual(paths[0].name, 'Claude Desktop');
    assert.strictEqual(paths[1].name, 'Cursor Global');
    assert.strictEqual(paths[2].name, 'Global MCP (.mcp.json)');
    assert.strictEqual(paths[3].name, 'VS Code Cline Extension');
    assert.strictEqual(paths[4].name, 'VS Code Roo Code Extension');
  });

  it('writeJsonAtomic writes JSON data atomically and preserves formatting', async () => {
    const tempFile = join(process.cwd(), 'temp_test_config.json');
    try {
      const data = { test: 'value', nested: { val: 1 } };
      await writeJsonAtomic(tempFile, data);

      const content = await fs.readFile(tempFile, 'utf8');
      assert.strictEqual(content, JSON.stringify(data, null, 2) + '\n');
    } finally {
      try {
        await fs.unlink(tempFile);
      } catch {
        // ignore
      }
    }
  });

  it('allowPath, listAllowedPaths, and disallowPath modify config correctly', async () => {
    const tempFile = join(process.cwd(), 'temp_test_config_2.json');
    try {
      // 1. allowPath creates file and adds path (simulating Windows absolute path)
      await allowPath('C:\\test-dir-1', { config: tempFile });

      let allowed = await listAllowedPaths({ config: tempFile });
      assert.deepStrictEqual(allowed, ['C:\\test-dir-1']);

      // 2. allowPath appends second path
      await allowPath('C:\\test-dir-2', { config: tempFile });
      allowed = await listAllowedPaths({ config: tempFile });
      assert.deepStrictEqual(allowed, ['C:\\test-dir-1', 'C:\\test-dir-2']);

      // 3. disallowPath removes a path
      await disallowPath('C:\\test-dir-1', { config: tempFile });
      allowed = await listAllowedPaths({ config: tempFile });
      assert.deepStrictEqual(allowed, ['C:\\test-dir-2']);
    } finally {
      try {
        await fs.unlink(tempFile);
      } catch {
        // ignore
      }
    }
  });

  it('parseArgs parses subcommands and mcp-config flags correctly', async () => {
    const originalArgv = process.argv;
    try {
      process.argv = ['node', 'cli.js', 'allow', 'C:\\my\\path', '--client', 'claude', '--dry-run'];

      const result = await parseArgs();
      assert.strictEqual(result.subcommand, 'allow');
      assert.strictEqual(result.subcommandPath, 'C:\\my\\path');
      assert.strictEqual(result.client, 'claude');
      assert.strictEqual(result.dryRun, true);
    } finally {
      process.argv = originalArgv;
    }
  });

  it('CLI subcommand integration runs end-to-end', () => {
    const tempFile = join(process.cwd(), 'temp_integration_config.json');
    try {
      // Allow C:\test-dir
      const cmd1 = `node --import tsx src/index.ts allow C:\\test-dir --config ${tempFile}`;
      execSync(cmd1, { stdio: 'pipe' });

      // List allowed
      const cmd2 = `node --import tsx src/index.ts list-allowed --config ${tempFile}`;
      const output = execSync(cmd2, { encoding: 'utf8' }).trim();
      assert.strictEqual(output, 'C:\\test-dir');

      // List allowed as JSON
      const cmd3 = `node --import tsx src/index.ts list-allowed --config ${tempFile} --json`;
      const outputJson = JSON.parse(execSync(cmd3, { encoding: 'utf8' }));
      assert.deepStrictEqual(outputJson, ['C:\\test-dir']);

      // Disallow
      const cmd4 = `node --import tsx src/index.ts disallow C:\\test-dir --config ${tempFile}`;
      execSync(cmd4, { stdio: 'pipe' });

      const outputAfter = execSync(cmd2, { encoding: 'utf8' }).trim();
      assert.strictEqual(outputAfter, '');
    } finally {
      try {
        import('node:fs').then((fs) => fs.default.unlinkSync(tempFile));
      } catch {
        // ignore
      }
    }
  });
});
