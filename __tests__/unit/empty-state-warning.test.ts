import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { PathGuard } from '../../src/core/path.js';
import type { ToolCtx } from '../../src/tools/define.js';
import { LIST_ALLOWED_DIRECTORIES } from '../../src/tools/roots.js';

describe('empty state warnings and descriptions', () => {
  it('logMissingDirectories warning contains all three sources and allow-cwd', async () => {
    const { McpRootsSynchronizer } = await import('../../src/core/registrar.js');

    // Test scenario 1: allowCwd is false (warning branch)
    {
      const logged: { level: string; data: string }[] = [];
      const mockServer = {
        server: {
          getClientCapabilities: () => ({ logging: {} }),
        },
        sendLoggingMessage: async (params: { level: string; data: string }) => {
          logged.push(params);
        },
      } as unknown as McpServer;

      const guard = new PathGuard({ allowCwd: false }, { minimumLevel: 'debug' });
      // Clear baseline since it might have cwd if not set up, but we want empty state
      await guard.setRoots([]);

      const synchronizer = new McpRootsSynchronizer(guard, { minimumLevel: 'debug' });
      synchronizer.logMissingDirectoriesIfNeeded(mockServer);

      assert.equal(logged.length, 1);
      const msg = logged[0].data;
      assert.strictEqual(logged[0].level, 'warning');
      assert.match(msg, /cli/i);
      assert.match(msg, /FS_ALLOWED_DIRS/);
      assert.match(msg, /roots/i);
      assert.match(msg, /allow-cwd/i);
    }

    // Test scenario 2: allowCwd is true (notice branch)
    {
      const logged: { level: string; data: string }[] = [];
      const mockServer = {
        server: {
          getClientCapabilities: () => ({ logging: {} }),
        },
        sendLoggingMessage: async (params: { level: string; data: string }) => {
          logged.push(params);
        },
      } as unknown as McpServer;

      // When allowCwd is true, PathGuard will add the cwd, so getAllowedDirectories() won't be empty.
      // But we can test the helper directly or by temporarily stubbing getAllowedDirectories to return []
      const guard = new PathGuard({ allowCwd: true }, { minimumLevel: 'debug' });
      const originalGet = guard.getAllowedDirectories.bind(guard);
      guard.getAllowedDirectories = () => [];

      const synchronizer = new McpRootsSynchronizer(guard, { minimumLevel: 'debug' });
      synchronizer.logMissingDirectoriesIfNeeded(mockServer);

      // Restore
      guard.getAllowedDirectories = originalGet;

      assert.equal(logged.length, 1);
      const msg = logged[0].data;
      assert.strictEqual(logged[0].level, 'notice');
      assert.match(msg, /cli/i);
      assert.match(msg, /FS_ALLOWED_DIRS/);
      assert.match(msg, /roots/i);
      assert.match(msg, /allow-cwd/i);
    }
  });

  it('list_roots tool description and text response when empty reference all three sources', async () => {
    // 1. Tool description
    const desc = LIST_ALLOWED_DIRECTORIES.description;
    assert.match(desc, /cli/i);
    assert.match(desc, /FS_ALLOWED_DIRS/);
    assert.match(desc, /roots/i);
    assert.match(desc, /allow-cwd/i);

    // 2. Tool empty text response
    const mockCtx = {
      pathGuard: {
        getAllowedDirectories: () => [],
      },
    } as unknown as ToolCtx;

    const result = await LIST_ALLOWED_DIRECTORIES._def.run({}, mockCtx);
    assert.match(result.text, /cli/i);
    assert.match(result.text, /FS_ALLOWED_DIRS/);
    assert.match(result.text, /roots/i);
    assert.match(result.text, /allow-cwd/i);
  });
});
