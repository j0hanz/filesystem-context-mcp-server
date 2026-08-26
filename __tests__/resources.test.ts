import { McpServer, ProtocolErrorCode, ResourceNotFoundError } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.js';
import { buildFileResourceUri } from '../src/core/file-uri.js';
import { PathGuard } from '../src/core/path.js';
import { ResourceStore } from '../src/core/store.js';
import { createWatcherRegistry } from '../src/core/watcher-registry.js';
import { buildSectionsRecord, INSTRUCTIONS_URI, renderSections } from '../src/instructions.js';
import { getResourceContracts, registerResources } from '../src/resources.js';
import { createServer } from '../src/server.js';
import { MUTATING_TOOL_NAMES } from '../src/tools/index.js';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  waitFor,
  writeTestFile,
} from './helpers.js';

const dummyContext = { sessionId: 'test-session' } as unknown as ServerContext;

describe('MCP Resources', () => {
  describe('internal://instructions (TC-FUNC-055–057)', () => {
    it('TC-FUNC-055: buildSectionsRecord produces guidelines, tools_overview, constraints, error_recovery', () => {
      const sections = buildSectionsRecord(false);

      assert.ok('guidelines' in sections, 'guidelines should be present');
      assert.ok('tools_overview' in sections, 'tools_overview should be present');
      assert.ok('constraints' in sections, 'constraints should be present');
      assert.ok('error_recovery' in sections, 'error_recovery should be present');

      // Verify guidelines content
      assert.match(sections.guidelines, /root_access:/);
      assert.match(sections.guidelines, /path_resolution:/);

      // Verify constraints content
      assert.match(sections.constraints, /allowed_roots:/);
      assert.match(sections.constraints, /sensitive_paths:/);
      assert.match(sections.constraints, /enforced_limits:/);
      assert.match(sections.constraints, /ephemeral_results:/);

      // Verify error recovery content
      assert.match(sections.error_recovery, /ACCESS_DENIED:/);
      assert.match(sections.error_recovery, /NOT_FOUND:/);
      assert.match(sections.error_recovery, /TOO_LARGE:/);
      assert.match(sections.error_recovery, /TIMEOUT:/);
      assert.match(sections.error_recovery, /INVALID_INPUT:/);
    });

    it('TC-FUNC-056: tools_overview behavior under readOnly true vs false', () => {
      // When readOnly = false, mutating tools are listed under Write
      const sectionsWritable = buildSectionsRecord(false);
      assert.match(sectionsWritable.tools_overview, /Navigate:/);
      assert.match(sectionsWritable.tools_overview, /Inspect:/);
      assert.match(sectionsWritable.tools_overview, /Read:/);
      assert.match(sectionsWritable.tools_overview, /Write:/);

      for (const toolName of MUTATING_TOOL_NAMES) {
        assert.ok(
          sectionsWritable.tools_overview.includes(toolName),
          `Mutating tool ${toolName} should be in tools_overview when readOnly=false`,
        );
      }

      // When readOnly = true, "Write" section is omitted from tools_overview
      const sectionsReadOnly = buildSectionsRecord(true);
      assert.match(sectionsReadOnly.tools_overview, /Navigate:/);
      assert.match(sectionsReadOnly.tools_overview, /Inspect:/);
      assert.match(sectionsReadOnly.tools_overview, /Read:/);
      assert.doesNotMatch(sectionsReadOnly.tools_overview, /Write:/);

      for (const toolName of MUTATING_TOOL_NAMES) {
        assert.ok(
          !sectionsReadOnly.tools_overview.includes(toolName),
          `Mutating tool ${toolName} should not be in tools_overview when readOnly=true`,
        );
      }
    });

    it('TC-FUNC-057: renderSections formats markdown and instructions contract reads correctly', async () => {
      const sections = buildSectionsRecord(false);
      const rendered = renderSections(sections);

      assert.strictEqual(typeof rendered, 'string');
      assert.ok(rendered.startsWith('\nGuidelines:'));
      assert.ok(rendered.includes('\n\nTools Overview:'));
      assert.ok(rendered.includes('\n\nConstraints:'));
      assert.ok(rendered.includes('\n\nError Recovery:'));
      assert.ok(rendered.endsWith('\n'));

      // Test reading via resource contract
      const store = new ResourceStore();
      const contracts = getResourceContracts({ resourceStore: store, readOnly: false });
      const instructionsContract = contracts.find((c) => c.name === 'filesystem-mcp-instructions');

      assert.ok(instructionsContract, 'filesystem-mcp-instructions contract should be present');
      assert.strictEqual(instructionsContract.uri, INSTRUCTIONS_URI);
      assert.strictEqual(instructionsContract.mimeType, 'text/markdown');

      const readResult = await instructionsContract.read(
        new URL(INSTRUCTIONS_URI),
        {},
        dummyContext,
      );

      assert.strictEqual(readResult.contents.length, 1);
      assert.strictEqual(readResult.contents[0].uri, INSTRUCTIONS_URI);
      assert.strictEqual(readResult.contents[0].mimeType, 'text/markdown');
      assert.strictEqual(readResult.contents[0].text, rendered);
    });
  });

  describe('filesystem-mcp://result/{id} (TC-FUNC-058–060)', () => {
    it('TC-FUNC-058: Store a text entry in ResourceStore and verify text, mimeType', () => {
      const store = new ResourceStore();
      const content = 'Sample calculation result content\nLine 2';

      const entry = store.putText({
        name: 'test_calc',
        mimeType: 'text/plain',
        text: content,
      });

      assert.ok(entry.uri.startsWith('filesystem-mcp://result/'));
      assert.strictEqual(entry.name, 'test_calc');
      assert.strictEqual(entry.mimeType, 'text/plain');
      assert.strictEqual(entry.text, content);

      // Retrieve via getEntry
      const retrievedEntry = store.getEntry(entry.uri);
      assert.strictEqual(retrievedEntry.uri, entry.uri);
      assert.strictEqual(retrievedEntry.text, content);
    });

    it('TC-FUNC-059: Read cached result via resource contract', async () => {
      const store = new ResourceStore();
      const contracts = getResourceContracts({ resourceStore: store, readOnly: false });
      const resultContract = contracts.find((c) => c.name === 'filesystem-mcp-result');

      assert.ok(resultContract, 'filesystem-mcp-result contract should be present');
      assert.strictEqual(resultContract.uriTemplate, 'filesystem-mcp://result/{id}');

      // Test text cached result
      const textEntry = store.putText({
        name: 'summary_result',
        mimeType: 'text/markdown',
        text: '# Test Summary',
      });
      const textUrl = new URL(textEntry.uri);
      const textId = textUrl.pathname.replace(/^\//, '');

      const textRead = await resultContract.read(textUrl, { id: textId }, dummyContext);
      assert.strictEqual(textRead.contents.length, 1);
      assert.strictEqual(textRead.contents[0].uri, textEntry.uri);
      assert.strictEqual(textRead.contents[0].mimeType, 'text/markdown');
      assert.strictEqual(textRead.contents[0].text, '# Test Summary');
    });

    it('TC-FUNC-060: Missing entry throws NOT_FOUND / ResourceNotFoundError', async () => {
      const store = new ResourceStore();
      const nonExistentUri = 'filesystem-mcp://result/00000000-0000-0000-0000-000000000000';

      // Direct store access throws FsError with NOT_FOUND
      assert.throws(
        () => store.getEntry(nonExistentUri),
        (err: unknown) => {
          assert(isFsError(err));
          assert.strictEqual(err.code, ErrorCode.NOT_FOUND);
          return true;
        },
      );

      // Contract read on missing result throws ResourceNotFoundError
      const contracts = getResourceContracts({ resourceStore: store, readOnly: false });
      const resultContract = contracts.find((c) => c.name === 'filesystem-mcp-result');
      assert.ok(resultContract, 'filesystem-mcp-result contract should exist');

      await assert.rejects(
        async () => {
          await resultContract.read(
            new URL(nonExistentUri),
            { id: '00000000-0000-0000-0000-000000000000' },
            dummyContext,
          );
        },
        { code: ProtocolErrorCode.InvalidParams },
      );

      // Contract read with empty or missing id throws ProtocolError
      await assert.rejects(
        async () => {
          await resultContract.read(new URL('filesystem-mcp://result/'), { id: '' }, dummyContext);
        },
        { code: ProtocolErrorCode.InvalidParams },
      );
    });

    it('TC-FUNC-060A: resourcesListChanged emits once per ResourceStore mutation', () => {
      let notifications = 0;
      const store = new ResourceStore(() => {
        notifications += 1;
      });

      store.putText({ name: 'first', text: 'first' });
      assert.strictEqual(notifications, 1, 'insertion must emit one list change');

      for (let i = 1; i < 64; i += 1) {
        store.putText({ name: `entry-${String(i)}`, text: String(i) });
      }
      notifications = 0;
      store.putText({ name: 'evicting-entry', text: 'last' });

      assert.strictEqual(notifications, 1, 'insert plus eviction must be coalesced');
      assert.strictEqual(store.keys().length, 64, 'entry limit must still be enforced');
    });
  });

  describe('filesystem-mcp://file/{+path} (TC-FUNC-061–066)', () => {
    let tmpDir: string;
    let pathGuard: PathGuard;
    let store: ResourceStore;

    before(async () => {
      tmpDir = await createTestRoot();
      pathGuard = await PathGuard.fromAllowedDirectories([tmpDir]);
      store = new ResourceStore();
    });

    after(async () => {
      if (tmpDir) {
        await cleanupTestRoot(tmpDir);
      }
    });

    it('TC-FUNC-061: Read workspace text file via resource contract', async () => {
      const textContent = 'Hello from workspace file!\nLine 2 content.';
      const filePath = await writeTestFile(tmpDir, 'document.txt', textContent);
      const uriString = buildFileResourceUri(filePath);
      const uri = new URL(uriString);

      const contracts = getResourceContracts({
        resourceStore: store,
        pathGuard,
        readOnly: false,
      });
      const fileContract = contracts.find((c) => c.name === 'filesystem-mcp-file');
      assert.ok(fileContract, 'filesystem-mcp-file contract should be present');

      const result = await fileContract.read(uri, { path: filePath }, dummyContext);

      assert.strictEqual(result.contents.length, 1);
      assert.strictEqual(result.contents[0].uri, uri.href);
      assert.strictEqual(result.contents[0].mimeType, 'text/plain');
      assert.strictEqual(result.contents[0].text, textContent);
    });

    it('TC-FUNC-062: Read workspace binary file via resource contract', async () => {
      // PNG header magic bytes
      const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
      const binPath = join(tmpDir, 'image.png');
      await writeFile(binPath, pngBytes);

      const uriString = buildFileResourceUri(binPath);
      const uri = new URL(uriString);

      const contracts = getResourceContracts({
        resourceStore: store,
        pathGuard,
        readOnly: false,
      });
      const fileContract = contracts.find((c) => c.name === 'filesystem-mcp-file');
      assert.ok(fileContract, 'filesystem-mcp-file contract should exist');

      const result = await fileContract.read(uri, { path: binPath }, dummyContext);

      assert.strictEqual(result.contents.length, 1);
      assert.strictEqual(result.contents[0].uri, uri.href);
      assert.strictEqual(result.contents[0].mimeType, 'image/png');
      assert.strictEqual(result.contents[0].blob, pngBytes.toString('base64'));
      assert.strictEqual(result.contents[0].text, undefined);
    });

    it('TC-FUNC-063: WatcherRegistry - add callback, attach watcher, and debounce notifications', async () => {
      const registry = createWatcherRegistry();
      const testFile = await writeTestFile(tmpDir, 'watch_test.txt', 'initial');
      const testUri = buildFileResourceUri(testFile);

      const notifications: string[] = [];
      registry.addCallback(testUri, (uri) => {
        notifications.push(uri);
      });

      const attached = registry.attach(testUri, testFile);
      assert.strictEqual(attached, true);
      assert.strictEqual(registry.hasWatcher(testUri), true);
      assert.strictEqual(registry.isStale(testUri), false);

      // Trigger file modification
      await writeFile(testFile, 'updated content');

      // Poll for the debounced notification (50ms debounce) — fixed waits flake on loaded CI.
      await waitFor(() => notifications.length > 0, 1000);

      assert.ok(notifications.length >= 1, 'Watcher callback should have received notification');
      assert.strictEqual(notifications[0], testUri);

      registry.destroy();
    });

    it('TC-FUNC-064: WatcherRegistry - remove tears down watcher and leaves no stale state', async () => {
      const registry = createWatcherRegistry();
      const testFile = await writeTestFile(tmpDir, 'remove_test.txt', 'content');
      const testUri = buildFileResourceUri(testFile);

      registry.addCallback(testUri, () => {});
      registry.retain(testUri);
      registry.attach(testUri, testFile);
      assert.strictEqual(registry.hasWatcher(testUri), true);

      registry.release(testUri);
      assert.strictEqual(registry.hasWatcher(testUri), false);
      assert.strictEqual(registry.isStale(testUri), false);

      registry.destroy();
    });

    it('TC-FUNC-064A: WatcherRegistry - callback identity is independent from leases', async () => {
      const registry = createWatcherRegistry();
      const testFile = await writeTestFile(tmpDir, 'lease_test.txt', 'content');
      const testUri = buildFileResourceUri(testFile);
      let notifications = 0;
      const callback = () => {
        notifications += 1;
      };

      registry.addCallback(testUri, callback);
      registry.addCallback(testUri, callback);
      registry.retain(testUri);
      registry.retain(testUri);
      assert.strictEqual(registry.attach(testUri, testFile), true);

      await writeFile(testFile, 'changed');
      await waitFor(() => notifications > 0, 1000);

      assert.strictEqual(notifications, 1, 'one filesystem event must invoke one callback');

      registry.release(testUri);
      assert.strictEqual(registry.hasWatcher(testUri), true, 'one retained lease must remain');
      registry.release(testUri);
      assert.strictEqual(registry.hasWatcher(testUri), false, 'last release must drop the watcher');

      registry.destroy();
    });

    it('TC-FUNC-065: WatcherRegistry - isAtCap reports capacity state', () => {
      const registry = createWatcherRegistry();
      assert.strictEqual(registry.isAtCap(), false);
      registry.destroy();
    });

    it('TC-FUNC-066: WatcherRegistry - destroy closes all watchers and marks all stale', async () => {
      const registry = createWatcherRegistry();
      const fileA = await writeTestFile(tmpDir, 'destroy_a.txt', 'A');
      const fileB = await writeTestFile(tmpDir, 'destroy_b.txt', 'B');
      const uriA = buildFileResourceUri(fileA);
      const uriB = buildFileResourceUri(fileB);

      registry.addCallback(uriA, () => {});
      registry.addCallback(uriB, () => {});
      registry.attach(uriA, fileA);
      registry.attach(uriB, fileB);

      assert.strictEqual(registry.hasWatcher(uriA), true);
      assert.strictEqual(registry.hasWatcher(uriB), true);
      assert.strictEqual(registry.isStale(uriA), false);
      assert.strictEqual(registry.isStale(uriB), false);

      registry.destroy();

      assert.strictEqual(registry.hasWatcher(uriA), false);
      assert.strictEqual(registry.hasWatcher(uriB), false);
      assert.strictEqual(registry.isStale(uriA), true);
      assert.strictEqual(registry.isStale(uriB), true);
      assert.strictEqual(registry.isStale('filesystem-mcp://file/nonexistent'), true);
    });

    it('TC-FUNC-067: WatcherRegistry - remove during in-flight subscribe marks stale; settled remove does not', async () => {
      const registry = createWatcherRegistry();
      const file = await writeTestFile(tmpDir, 'resub.txt', 'content');
      const uri = buildFileResourceUri(file);

      registry.startSubscribe(uri);
      assert.strictEqual(registry.isStale(uri), false);
      registry.addCallback(uri, () => {});
      registry.retain(uri);
      registry.attach(uri, file);

      registry.release(uri);
      assert.strictEqual(registry.isStale(uri), false);

      registry.startSubscribe(uri);
      assert.strictEqual(registry.isStale(uri), false);
      registry.addCallback(uri, () => {});
      registry.retain(uri);
      assert.strictEqual(registry.isStale(uri), false);

      // in-flight abort: a subscribe that never settles (no addCallback yet)
      // must leave the stale marker a mid-await subscriber checks — using a
      // fresh uri so this doesn't inherit ref-count/watcher state from above.
      const abortFile = await writeTestFile(tmpDir, 'resub_abort.txt', 'content');
      const abortUri = buildFileResourceUri(abortFile);
      registry.startSubscribe(abortUri);
      registry.release(abortUri);
      assert.strictEqual(registry.isStale(abortUri), true);

      // and a fresh startSubscribe clears it again
      registry.startSubscribe(abortUri);
      assert.strictEqual(registry.isStale(abortUri), false);

      registry.destroy();
    });
  });

  describe('MCP Client Resource Operations', () => {
    let clientTmpDir: string;
    let harness: Awaited<ReturnType<typeof createTestClientPair>>;

    before(async () => {
      clientTmpDir = await createTestRoot();
      harness = await createTestClientPair([clientTmpDir]);
    });

    after(async () => {
      if (harness) {
        await harness.close();
      }
      if (clientTmpDir) {
        await cleanupTestRoot(clientTmpDir);
      }
    });

    it('client.listResources() returns the static instructions resource and no per-root entries', async () => {
      const result = await harness.client.listResources();
      const instructions = result.resources.find((r) => r.uri === INSTRUCTIONS_URI);
      assert.ok(instructions, 'instructions resource should be present');
      assert.strictEqual(instructions.mimeType, 'text/markdown');

      // Allowed roots are not listed as concrete resources; the
      // filesystem-mcp://file/{+path} template and list_roots cover them.
      const allowedRoots = harness.serverCtx.pathGuard.getAllowedDirectories();
      const rootUri = buildFileResourceUri(allowedRoots[0] ?? clientTmpDir);
      assert.strictEqual(
        result.resources.some((r) => r.uri === rootUri),
        false,
        'workspace roots must not be duplicated into resources/list',
      );
    });

    it('resource contracts specify cacheHint for client caching optimization', () => {
      const store = new ResourceStore();
      const contracts = getResourceContracts({ resourceStore: store, readOnly: false });
      const instructions = contracts.find((c) => c.name === 'filesystem-mcp-instructions');
      assert.deepStrictEqual(instructions?.cacheHint, { cacheScope: 'public', ttlMs: 300_000 });

      const resultContract = contracts.find((c) => c.name === 'filesystem-mcp-result');
      assert.deepStrictEqual(resultContract?.cacheHint, { cacheScope: 'private', ttlMs: 60_000 });
    });

    it('client.listResourceTemplates() returns result and file templates', async () => {
      const result = await harness.client.listResourceTemplates();
      assert.ok(result.resourceTemplates.length >= 2);
      assert.ok(
        result.resourceTemplates.some((t) => t.uriTemplate === 'filesystem-mcp://result/{id}'),
      );
      assert.ok(
        result.resourceTemplates.some((t) => t.uriTemplate === 'filesystem-mcp://file/{+path}'),
      );

      // Every entry the result store writes is JSON (putJsonResource), so the
      // template must not advertise a type none of its resources have.
      const resultTemplate = result.resourceTemplates.find(
        (t) => t.uriTemplate === 'filesystem-mcp://result/{id}',
      );
      assert.strictEqual(resultTemplate?.mimeType, 'application/json');
    });

    it('client.readResource() reads internal instructions', async () => {
      const result = await harness.client.readResource({ uri: INSTRUCTIONS_URI });
      assert.strictEqual(result.contents.length, 1);
      assert.strictEqual(result.contents[0].uri, INSTRUCTIONS_URI);
      assert.strictEqual(result.contents[0].mimeType, 'text/markdown');
      assert.ok((result.contents[0] as { text: string }).text.includes('Guidelines:'));
    });

    it('client.readResource() reads workspace file via uri', async () => {
      const filePath = await writeTestFile(clientTmpDir, 'client_read.txt', 'client resource read');
      const uri = buildFileResourceUri(filePath);
      const result = await harness.client.readResource({ uri });
      assert.strictEqual(result.contents.length, 1);
      assert.strictEqual(result.contents[0].uri, uri);
      assert.strictEqual((result.contents[0] as { text: string }).text, 'client resource read');
    });

    it('client.readResource() on a missing workspace file rejects as resource-not-found', async () => {
      const uri = buildFileResourceUri(join(clientTmpDir, 'does-not-exist.txt'));
      await assert.rejects(harness.client.readResource({ uri }), (err: unknown) => {
        // The SDK reconstructs ResourceNotFoundError client-side from the wire
        // code plus `data.uri`; its wire code is -32602 (spec MUST for
        // 2026-07-28), with -32002 accepted only for backwards compatibility.
        assert.ok(ResourceNotFoundError.isInstance(err), 'expected ResourceNotFoundError');
        assert.strictEqual(err.code, ProtocolErrorCode.InvalidParams);
        assert.strictEqual(err.uri, uri);
        return true;
      });
    });

    it('advertises resources.subscribe and resources.listChanged capabilities', async () => {
      const serverContext = await createServer({ cliAllowedDirs: [clientTmpDir] });
      const capabilities = serverContext.mcp.server.getCapabilities();
      assert.strictEqual(capabilities.resources?.subscribe, true);
      assert.strictEqual(capabilities.resources?.listChanged, true);
      await serverContext.close();
    });
  });

  it('legacy resource registration refuses to replace an existing request handler', async () => {
    const root = await createTestRoot();
    const pathGuard = await PathGuard.fromAllowedDirectories([root]);
    const server = new McpServer({ name: 'resource-collision-test', version: '1.0.0' });
    server.server.setRequestHandler('resources/subscribe', async () => ({}));

    try {
      assert.throws(
        () =>
          registerResources({
            server,
            pathGuard,
            resourceStore: new ResourceStore(),
            readOnly: false,
            era: 'legacy',
          }),
        /handler|registered|resources\/subscribe/iu,
      );
    } finally {
      await server.close();
      await cleanupTestRoot(root);
    }
  });
});
