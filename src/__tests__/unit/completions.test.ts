import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { describe, it } from 'node:test';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerCompletions } from '../../completions.js';
import {
  normalizePath,
  setAllowedDirectoriesResolved,
} from '../../lib/paths.js';

describe('completions', () => {
  it('does not reuse stale path suggestions for a different prefix inside the rate limit window', async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`)
    );
    await fs.writeFile(path.join(tmpDir, 'alpha.txt'), 'alpha', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'beta.txt'), 'beta', 'utf8');
    await setAllowedDirectoriesResolved([tmpDir]);

    const server = new McpServer(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );
    registerCompletions(server, '');

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const first = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: 'a' },
      });
      const second = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: 'b' },
      });

      const firstValues = first.completion.values;
      const secondValues = second.completion.values;

      assert.ok(firstValues.some((value) => value.endsWith('alpha.txt')));
      assert.ok(secondValues.some((value) => value.endsWith('beta.txt')));
      assert.ok(!secondValues.some((value) => value.endsWith('alpha.txt')));
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true });
      await setAllowedDirectoriesResolved([]);
    }
  });

  it('does not collide cache keys when context values contain delimiter characters', async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`)
    );
    const fooDir = path.join(tmpDir, 'foo');
    await fs.mkdir(fooDir);
    await fs.writeFile(path.join(fooDir, 'inside.txt'), 'inside', 'utf8');
    await setAllowedDirectoriesResolved([tmpDir]);

    const server = new McpServer(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );
    registerCompletions(server, '');

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const fromContextDirectory = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: '' },
        context: { arguments: { bar: '1', cwd: 'foo' } },
      });
      const withoutContextDirectory = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: '' },
        context: { arguments: { bar: '1&cwd=foo' } },
      });

      const firstValues = fromContextDirectory.completion.values;
      const secondValues = withoutContextDirectory.completion.values;

      assert.ok(firstValues.some((value) => value.endsWith('inside.txt')));
      assert.deepEqual(secondValues.map(normalizePath), [
        normalizePath(tmpDir),
      ]);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await fs.rm(tmpDir, { recursive: true, force: true });
      await setAllowedDirectoriesResolved([]);
    }
  });

  it('completes tool names for the get-tool-help prompt', async () => {
    const server = new McpServer(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );
    registerCompletions(server, '');

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-tool-help' },
        argument: { name: 'name', value: 're' },
      });

      assert.ok(result.completion.values.includes('read'));
      assert.ok(result.completion.values.includes('read_many'));
      assert.ok(!result.completion.values.includes('write'));
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it('completes tool-info template names for resource references', async () => {
    const server = new McpServer(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );
    registerCompletions(server, '');

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      InMemoryTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.complete({
        ref: { type: 'ref/resource', uri: 'internal://tool-info/{name}' },
        argument: { name: 'name', value: 'st' },
      });

      assert.ok(result.completion.values.includes('stat'));
      assert.ok(result.completion.values.includes('stat_many'));
      assert.ok(!result.completion.values.includes('read'));
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});
