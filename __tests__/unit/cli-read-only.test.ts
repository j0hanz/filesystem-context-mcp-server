import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { parseArgs } from '../../src/cli.js';
import { ORACLE_MUTATING_TOOL_NAMES, ORACLE_READ_ONLY_TOOL_NAMES } from '../helpers.js';

describe('parseArgs --read-only / --safe flags (TASK-001)', () => {
  let originalArgv: string[];

  before(() => {
    originalArgv = process.argv.slice();
  });

  after(() => {
    process.argv = originalArgv;
  });

  it('returns readOnly:false when no flag given', async () => {
    process.argv = ['node', 'index.js'];
    const result = await parseArgs();
    assert.equal(result.readOnly, false);
  });

  it('returns readOnly:true for --read-only', async () => {
    process.argv = ['node', 'index.js', '--read-only'];
    const result = await parseArgs();
    assert.equal(result.readOnly, true);
  });

  it('returns readOnly:true for --safe alias', async () => {
    process.argv = ['node', 'index.js', '--safe'];
    const result = await parseArgs();
    assert.equal(result.readOnly, true);
  });
});

const MUTATING_TOOLS = ORACLE_MUTATING_TOOL_NAMES;

describe('createServer readOnly threading (TASK-003)', () => {
  it('createServer with readOnly:true omits mutating tools from registered set', async () => {
    const { createServer } = await import('../../src/server.js');
    const ctx = await createServer({ readOnly: true });
    const registeredNames = Object.keys(
      (ctx.mcp as unknown as Record<string, unknown>)['_registeredTools'] ?? {},
    );
    for (const name of MUTATING_TOOLS) {
      assert.ok(
        !registeredNames.includes(name),
        `Mutating tool '${name}' must not be registered when readOnly:true`,
      );
    }
    await ctx.mcp.close();
  });

  it('createServer without readOnly registers mutating tools', async () => {
    const { createServer } = await import('../../src/server.js');
    const ctx = await createServer({ readOnly: false });
    const registeredNames = Object.keys(
      (ctx.mcp as unknown as Record<string, unknown>)['_registeredTools'] ?? {},
    );
    for (const name of MUTATING_TOOLS) {
      assert.ok(
        registeredNames.includes(name),
        `Mutating tool '${name}' must be registered when readOnly is not set`,
      );
    }
    await ctx.mcp.close();
  });
});
const READ_TOOLS = ORACLE_READ_ONLY_TOOL_NAMES;

describe('toolsRegistrar read-only gating (TASK-002)', () => {
  it('registers mutating tools in normal mode', async () => {
    const { toolsRegistrar } = await import('../../src/tools/index.js');
    const registered: string[] = [];
    const mockDeps = {
      server: {
        registerTool(name: string) {
          registered.push(name);
        },
      },
      isInitialized: () => true,
      pathGuard: {},
      resourceStore: {},
      readOnly: false,
    };
    toolsRegistrar.register(mockDeps as never);
    for (const name of MUTATING_TOOLS) {
      assert.ok(
        registered.includes(name),
        `Expected mutating tool '${name}' to be registered in normal mode`,
      );
    }
  });

  it('excludes all mutating tools when readOnly:true', async () => {
    const { toolsRegistrar } = await import('../../src/tools/index.js');
    const registered: string[] = [];
    const mockDeps = {
      server: {
        registerTool(name: string) {
          registered.push(name);
        },
      },
      isInitialized: () => true,
      pathGuard: {},
      resourceStore: {},
      readOnly: true,
    };
    toolsRegistrar.register(mockDeps as never);
    for (const name of MUTATING_TOOLS) {
      assert.ok(
        !registered.includes(name),
        `Mutating tool '${name}' must NOT be registered in read-only mode`,
      );
    }
  });

  it('keeps non-mutating tools when readOnly:true', async () => {
    const { toolsRegistrar } = await import('../../src/tools/index.js');
    const registered: string[] = [];
    const mockDeps = {
      server: {
        registerTool(name: string) {
          registered.push(name);
        },
      },
      isInitialized: () => true,
      pathGuard: {},
      resourceStore: {},
      readOnly: true,
    };
    toolsRegistrar.register(mockDeps as never);
    assert.ok(
      registered.length > 0,
      'At least some tools must remain registered in read-only mode',
    );
    for (const name of READ_TOOLS) {
      assert.ok(
        registered.includes(name),
        `Expected read tool '${name}' to remain registered in read-only mode`,
      );
    }
  });
});
