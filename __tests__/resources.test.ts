import { ProtocolErrorCode } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { ErrorCode, isFsError } from '../src/core/errors.js';
import { buildFileResourceUri } from '../src/core/file-uri.js';
import { PathGuard } from '../src/core/path.js';
import { createInMemoryResourceStore } from '../src/core/store.js';
import { createWatcherRegistry } from '../src/core/watcher-registry.js';
import {
  buildSectionsRecord,
  getResourceContracts,
  INSTRUCTIONS_URI,
  renderSections,
} from '../src/resources.js';
import { MUTATING_TOOL_NAMES } from '../src/tools/index.js';
import { cleanupTestRoot, createTestClientPair, createTestRoot, writeTestFile } from './helpers.js';

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
      const store = createInMemoryResourceStore();
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
    it('TC-FUNC-058: Store a text entry in ResourceStore and verify text, hash, mimeType', () => {
      const store = createInMemoryResourceStore();
      const content = 'Sample calculation result content\nLine 2';
      const expectedHash = createHash('sha256').update(content).digest('hex');

      const entry = store.putText({
        name: 'test_calc',
        mimeType: 'text/plain',
        text: content,
      });

      assert.ok(entry.uri.startsWith('filesystem-mcp://result/'));
      assert.strictEqual(entry.name, 'test_calc');
      assert.strictEqual(entry.mimeType, 'text/plain');
      assert.strictEqual(entry.text, content);
      assert.strictEqual(entry.hash, expectedHash);
      assert.strictEqual(entry.kind, 'text');

      // Retrieve via getText
      const retrievedText = store.getText(entry.uri);
      assert.strictEqual(retrievedText.text, content);
      assert.strictEqual(retrievedText.hash, expectedHash);
      assert.strictEqual(retrievedText.mimeType, 'text/plain');

      // Retrieve via getEntry
      const retrievedEntry = store.getEntry(entry.uri);
      assert.strictEqual(retrievedEntry.kind, 'text');
      assert.strictEqual(retrievedEntry.uri, entry.uri);
      assert.strictEqual(retrievedEntry.hash, expectedHash);
    });

    it('TC-FUNC-059: Read cached result via resource contract', async () => {
      const store = createInMemoryResourceStore();
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

      // Test binary cached result
      const binaryData = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
      const blobEntry = store.putBlob({
        name: 'bin_result',
        mimeType: 'application/octet-stream',
        data: binaryData,
      });
      const blobUrl = new URL(blobEntry.uri);
      const blobId = blobUrl.pathname.replace(/^\//, '');

      const blobRead = await resultContract.read(blobUrl, { id: blobId }, dummyContext);
      assert.strictEqual(blobRead.contents.length, 1);
      assert.strictEqual(blobRead.contents[0].uri, blobEntry.uri);
      assert.strictEqual(blobRead.contents[0].mimeType, 'application/octet-stream');
      assert.strictEqual(blobRead.contents[0].blob, binaryData.toString('base64'));
    });

    it('TC-FUNC-060: Missing entry throws NOT_FOUND / ResourceNotFoundError', async () => {
      const store = createInMemoryResourceStore();
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

      assert.throws(
        () => store.getText(nonExistentUri),
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
  });

  describe('filesystem-mcp://file/{+path} (TC-FUNC-061–066)', () => {
    let tmpDir: string;
    let pathGuard: PathGuard;
    let store: ReturnType<typeof createInMemoryResourceStore>;

    before(async () => {
      tmpDir = await createTestRoot();
      pathGuard = await PathGuard.fromAllowedDirectories([tmpDir]);
      store = createInMemoryResourceStore();
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
      const deadline = Date.now() + 1000;
      while (notifications.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      assert.ok(notifications.length >= 1, 'Watcher callback should have received notification');
      assert.strictEqual(notifications[0], testUri);

      registry.destroy();
    });

    it('TC-FUNC-064: WatcherRegistry - remove watcher and desired state', async () => {
      const registry = createWatcherRegistry();
      const testFile = await writeTestFile(tmpDir, 'remove_test.txt', 'content');
      const testUri = buildFileResourceUri(testFile);

      registry.addCallback(testUri, () => {});
      registry.attach(testUri, testFile);
      assert.strictEqual(registry.hasWatcher(testUri), true);

      registry.remove(testUri);
      assert.strictEqual(registry.hasWatcher(testUri), false);
      assert.strictEqual(registry.isStale(testUri), true);

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

    it('TC-FUNC-067: WatcherRegistry - re-subscription clears stale state', async () => {
      const registry = createWatcherRegistry();
      const file = await writeTestFile(tmpDir, 'resub.txt', 'content');
      const uri = buildFileResourceUri(file);

      registry.startSubscribe(uri);
      assert.strictEqual(registry.isStale(uri), false);
      registry.addCallback(uri, () => {});
      registry.attach(uri, file);

      registry.remove(uri);
      assert.strictEqual(registry.isStale(uri), true);

      registry.startSubscribe(uri);
      assert.strictEqual(registry.isStale(uri), false);
      registry.addCallback(uri, () => {});
      assert.strictEqual(registry.isStale(uri), false);

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

    it('client.listResources() returns static instructions resource', async () => {
      const result = await harness.client.listResources();
      const instructions = result.resources.find((r) => r.uri === INSTRUCTIONS_URI);
      assert.ok(instructions, 'instructions resource should be present');
      assert.strictEqual(instructions.mimeType, 'text/markdown');
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
  });
});
