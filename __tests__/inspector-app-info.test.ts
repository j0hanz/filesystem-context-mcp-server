import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import {
  cleanupInspectorTestRoot,
  createInspectorTestRoot,
  getStdioServerCommand,
} from './inspector-fixtures.js';
import { executeInspectorCli, isInspectorInstalled } from './inspector-harness.js';

describe(
  'Inspector CLI: MCP App Metadata Probing (--app-info)',
  { skip: !isInspectorInstalled() ? 'inspector not installed' : undefined },
  () => {
    let tmpDir: string;
    let serverCmd: string[];

    before(async () => {
      tmpDir = await createInspectorTestRoot();
      serverCmd = getStdioServerCommand();
    });

    after(async () => {
      await cleanupInspectorTestRoot(tmpDir);
    });

    it('INSP-APP-001: tools/list --app-info emits NDJSON with hasApp for all tools', async () => {
      const res = await executeInspectorCli({
        method: 'tools/list',
        serverCommand: serverCmd,
        serverArgs: [tmpDir],
        appInfo: true,
      });

      assert.strictEqual(
        res.exitCode,
        0,
        `tools/list --app-info should exit with 0. stderr: ${res.stderr}`,
      );

      const lines = res.stdout
        .trim()
        .split('\n')
        .map((l) => l.trim())
        .filter((l) => l.length > 0);

      assert.ok(lines.length > 0, 'NDJSON output should contain tool probe lines');

      const parsedLines = lines
        .map((l) => {
          try {
            return JSON.parse(l) as { toolName?: string; hasApp?: boolean };
          } catch {
            return null;
          }
        })
        .filter((l): l is { toolName: string; hasApp: boolean } => Boolean(l?.toolName));
      assert.ok(parsedLines.length > 0, 'Parsed NDJSON output should contain tool entries');
      for (const item of parsedLines) {
        assert.strictEqual(
          item.hasApp,
          false,
          `filesystem-mcp CLI tool ${item.toolName} should report hasApp: false`,
        );
      }
    });

    it('INSP-APP-002: tools/call --app-info on tool without UI exits with Code 2', async () => {
      const res = await executeInspectorCli({
        method: 'tools/call',
        serverCommand: serverCmd,
        serverArgs: [tmpDir],
        toolName: 'read',
        appInfo: true,
      });

      // Exit code 2: No MCP App found on the tool
      assert.strictEqual(
        res.exitCode,
        2,
        `Probing tool with no MCP App should exit with code 2. Actual: ${res.exitCode}`,
      );
    });
  },
);
