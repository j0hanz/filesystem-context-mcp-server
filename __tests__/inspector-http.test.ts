import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { cleanupTestRoot, createTestRoot } from './helpers.js';
import { startInspectorHttp } from './inspector-fixtures.js';
import { executeInspectorCli, isInspectorInstalled } from './inspector-harness.js';

describe(
  'Inspector CLI: Streamable HTTP Transport & Authentication',
  { skip: !isInspectorInstalled() ? 'inspector not installed' : undefined },
  () => {
    let tmpDir: string;
    let server: Server;
    let serverUrl: string;
    const TEST_API_KEY = 'test-inspector-secret-key-xyz123';

    before(async () => {
      tmpDir = await createTestRoot();
      server = await startInspectorHttp(0, [tmpDir], {
        apiKey: TEST_API_KEY,
      });
      const port = (server.address() as AddressInfo).port;
      serverUrl = `http://127.0.0.1:${port}/mcp`;
    });

    after(async () => {
      if (server) {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
      await cleanupTestRoot(tmpDir);
    });

    it('INSP-HTTP-001: unauthenticated request exits with Code 3 (auth_required)', async () => {
      const res = await executeInspectorCli({
        method: 'tools/list',
        serverUrl,
        transport: 'http',
      });

      assert.strictEqual(
        res.exitCode,
        3,
        `Unauthenticated HTTP request should exit with code 3. Actual: ${res.exitCode}, stderr: ${res.stderr}`,
      );
    });

    it('INSP-HTTP-002: request with valid Bearer header exits with Code 0 and returns tools', async () => {
      const res = await executeInspectorCli<{
        tools?: { name: string }[];
      }>({
        method: 'tools/list',
        serverUrl,
        transport: 'http',
        headers: {
          Authorization: `Bearer ${TEST_API_KEY}`,
        },
      });

      assert.strictEqual(
        res.exitCode,
        0,
        `Authenticated HTTP request should exit with code 0. Actual: ${res.exitCode}, stderr: ${res.stderr}`,
      );
      assert.ok(Array.isArray(res.json?.tools), 'Tools should be returned');
      assert.ok(
        res.json?.tools?.some((t) => t.name === 'read'),
        'read tool should be in listing',
      );
    });
  },
);
