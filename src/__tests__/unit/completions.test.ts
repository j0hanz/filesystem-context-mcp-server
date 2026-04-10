import { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { registerCompletions } from '../../completions.js';
import {
  normalizePath,
  setAllowedDirectoriesResolved,
} from '../../lib/paths.js';
import { LinkedTransport } from '../linked-transport.js';

describe('completions', () => {
  it('does not reuse stale path suggestions for a different prefix inside the rate limit window', async () => {
    const tmpDir = await mkdtemp(
      join(tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`)
    );
    await writeFile(join(tmpDir, 'alpha.txt'), 'alpha', 'utf8');
    await writeFile(join(tmpDir, 'beta.txt'), 'beta', 'utf8');
    await setAllowedDirectoriesResolved([tmpDir]);

    const server = new McpServer(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );
    registerCompletions(server, '');

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      LinkedTransport.createLinkedPair();

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
      await rm(tmpDir, { recursive: true, force: true });
      await setAllowedDirectoriesResolved([]);
    }
  });

  it('does not collide cache keys when context values contain delimiter characters', async () => {
    const tmpDir = await mkdtemp(
      join(tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`)
    );
    const fooDir = join(tmpDir, 'foo');
    await mkdir(fooDir);
    await writeFile(join(fooDir, 'inside.txt'), 'inside', 'utf8');
    await setAllowedDirectoriesResolved([tmpDir]);

    const server = new McpServer(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );
    registerCompletions(server, '');

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      LinkedTransport.createLinkedPair();

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
      await rm(tmpDir, { recursive: true, force: true });
      await setAllowedDirectoriesResolved([]);
    }
  });

  it('does not enumerate completion entries through a linked directory outside allowed roots', async () => {
    const tmpDir = await mkdtemp(
      join(tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`)
    );
    const allowedDir = join(tmpDir, 'allowed');
    const outsideDir = join(tmpDir, 'outside');
    const linkedDir = join(allowedDir, 'linked');
    await mkdir(allowedDir);
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf8');
    await symlink(
      outsideDir,
      linkedDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await setAllowedDirectoriesResolved([allowedDir]);

    const server = new McpServer(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );
    registerCompletions(server, '');

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      LinkedTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const direct = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: 'linked/' },
      });
      const fromContext = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: '' },
        context: { arguments: { cwd: 'linked' } },
      });

      assert.ok(
        !direct.completion.values.some((value) => value.endsWith('secret.txt'))
      );
      assert.ok(
        !fromContext.completion.values.some((value) =>
          value.endsWith('secret.txt')
        )
      );
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await rm(tmpDir, { recursive: true, force: true });
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
      LinkedTransport.createLinkedPair();

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
      LinkedTransport.createLinkedPair();

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

  it('completes enum values for sortBy argument', async () => {
    const server = new McpServer(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );
    registerCompletions(server, '');

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      LinkedTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const all = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'sortBy', value: '' },
      });

      assert.deepEqual(all.completion.values, ['name', 'size', 'modified']);

      const filtered = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'sortBy', value: 's' },
      });

      assert.deepEqual(filtered.completion.values, ['size']);
      assert.equal(filtered.completion.hasMore, false);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });

  it('returns empty completions for unknown non-path arguments', async () => {
    const server = new McpServer(
      { name: 'test-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );
    registerCompletions(server, '');

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    const [clientTransport, serverTransport] =
      LinkedTransport.createLinkedPair();

    try {
      await server.connect(serverTransport);
      await client.connect(clientTransport);

      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'unknownArg', value: 'x' },
      });

      assert.deepEqual(result.completion.values, []);
    } finally {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    }
  });
});
