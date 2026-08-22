import type {
  GetPromptResult,
  McpServer,
  ResourceLink,
  TextContent,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PathGuard } from '../src/core/path.js';
import type { ResourceStore } from '../src/core/store.js';
import { PROMPT_ENTRIES, promptsRegistrar } from '../src/prompts.js';
import { buildSectionsRecord, INSTRUCTIONS_URI, renderSections } from '../src/resources.js';
import { cleanupTestRoot, createTestRoot, writeTestFile } from './helpers.js';

type PromptHandler = (args: Record<string, unknown>) => Promise<GetPromptResult> | GetPromptResult;

describe('MCP Prompts Tests', () => {
  let tmpDir: string;
  let pathGuard: PathGuard;
  let promptOptions: {
    pathGuard: PathGuard;
    sections: Record<string, string>;
    instructions: string;
    instructionsUri: string;
    isInitialized: () => boolean;
  };
  const handlers = new Map<string, PromptHandler>();
  const getPromptHandler = (name: string): PromptHandler => {
    const h = handlers.get(name);
    assert.ok(h, `Handler not found for ${name}`);
    return h;
  };

  before(async () => {
    tmpDir = await createTestRoot();
    pathGuard = new PathGuard({ cliAllowedDirs: [tmpDir] }, true);
    await pathGuard.recomputeAllowedDirectories();

    const sections = buildSectionsRecord(false);
    promptOptions = {
      pathGuard,
      sections,
      instructions: renderSections(sections),
      instructionsUri: INSTRUCTIONS_URI,
      isInitialized: () => true,
    };

    const mockServer = {
      registerPrompt: (name: string, _config: unknown, handler: PromptHandler) => {
        handlers.set(name, handler);
      },
    } as unknown as McpServer;

    for (const entry of PROMPT_ENTRIES) {
      entry.register(mockServer, promptOptions);
    }
  });

  after(async () => {
    await cleanupTestRoot(tmpDir);
  });

  describe('Prompt Definitions & Registration', () => {
    it('TC-FUNC-067: PROMPT_ENTRIES defines all expected prompts', () => {
      assert.equal(PROMPT_ENTRIES.length, 4);

      const promptNames = PROMPT_ENTRIES.map((p) => p.contract.name);
      assert.deepEqual(promptNames, [
        'get-help',
        'analyze-path',
        'find-in-tree',
        'summarize-directory',
      ]);

      for (const entry of PROMPT_ENTRIES) {
        assert.ok(
          entry.contract.title.length > 0,
          `Title should be defined for ${entry.contract.name}`,
        );
        assert.ok(
          entry.contract.description.length > 0,
          `Description should be defined for ${entry.contract.name}`,
        );
        assert.equal(typeof entry.register, 'function');
      }
    });

    it('promptsRegistrar registers all prompts via registrar interface', () => {
      const registeredNames: string[] = [];
      const mockServer = {
        registerPrompt: (name: string) => {
          registeredNames.push(name);
        },
      } as unknown as McpServer;

      promptsRegistrar.register({
        server: mockServer,
        pathGuard,
        resourceStore: {} as unknown as ResourceStore,
        isInitialized: () => true,
        readOnly: false,
      });

      assert.deepEqual(registeredNames, [
        'get-help',
        'analyze-path',
        'find-in-tree',
        'summarize-directory',
      ]);
    });
  });

  describe('Prompt: get-help', () => {
    it('TC-FUNC-068: Returns all instructions when no topic is provided', async () => {
      const handler = getPromptHandler('get-help', promptOptions);
      const result = await handler({});

      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].role, 'user');
      const textContent = result.messages[0].content as TextContent;
      assert.equal(textContent.type, 'text');
      assert.equal(textContent.text, promptOptions.instructions);
      assert.ok(textContent.text.includes('Guidelines:'));
      assert.ok(textContent.text.includes('Tools Overview:'));
      assert.ok(textContent.text.includes('Constraints:'));
      assert.ok(textContent.text.includes('Error Recovery:'));
    });

    it('TC-FUNC-069: Returns filtered section for specific topic and fallback for unknown topic', async () => {
      const handler = getPromptHandler('get-help', promptOptions);

      // Specific known topic
      const guidelinesResult = await handler({ topic: 'guidelines' });
      assert.equal(guidelinesResult.messages.length, 1);
      const guidelinesText = (guidelinesResult.messages[0].content as TextContent).text;
      assert.equal(guidelinesText, promptOptions.sections['guidelines']);
      assert.ok(guidelinesText.includes('root_access:'));
      assert.ok(!guidelinesText.includes('Error Recovery:'));

      // Another known topic (case-insensitive)
      const errorResult = await handler({ topic: 'ERROR_RECOVERY' });
      const errorText = (errorResult.messages[0].content as TextContent).text;
      assert.equal(errorText, promptOptions.sections['error_recovery']);
      assert.ok(errorText.includes('ACCESS_DENIED:'));

      // Unknown topic
      const unknownResult = await handler({ topic: 'unknown_topic_name' });
      const unknownText = (unknownResult.messages[0].content as TextContent).text;
      assert.ok(unknownText.startsWith("Section 'unknown_topic_name' not found. Available:"));
      assert.ok(unknownText.includes('guidelines, tools_overview, constraints, error_recovery'));
      assert.ok(unknownText.includes(promptOptions.instructions));
    });
  });

  describe('Prompt: analyze-path', () => {
    it('TC-FUNC-070: Analyzes a file and mentions stat and read', async () => {
      const filePath = await writeTestFile(tmpDir, 'sample.txt', 'Sample file content');
      const handler = getPromptHandler('analyze-path', promptOptions);

      const result = await handler({ path: filePath });
      assert.equal(result.messages.length, 3);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('Analyze this file:'));
      assert.ok(textMsg.text.includes('`stat`'));
      assert.ok(textMsg.text.includes('`read`'));
      assert.ok(textMsg.text.includes('includeHash: true'));

      const pathLink = result.messages[1].content as ResourceLink;
      assert.equal(pathLink.type, 'resource_link');
      assert.ok(pathLink.uri.includes('sample.txt'));

      const instructionsLink = result.messages[2].content as ResourceLink;
      assert.equal(instructionsLink.type, 'resource_link');
      assert.equal(instructionsLink.uri, INSTRUCTIONS_URI);
    });

    it('TC-FUNC-071: Analyzes a directory and mentions list', async () => {
      const handler = getPromptHandler('analyze-path', promptOptions);

      const result = await handler({ path: tmpDir });
      assert.equal(result.messages.length, 3);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('Analyze this directory:'));
      assert.ok(textMsg.text.includes('`list`'));
      assert.ok(textMsg.text.includes('maxDepth: 3'));

      const pathLink = result.messages[1].content as ResourceLink;
      assert.equal(pathLink.type, 'resource_link');

      const instructionsLink = result.messages[2].content as ResourceLink;
      assert.equal(instructionsLink.type, 'resource_link');
      assert.equal(instructionsLink.uri, INSTRUCTIONS_URI);
    });

    it('TC-FUNC-072: Throws error for non-existent path', async () => {
      const handler = getPromptHandler('analyze-path', promptOptions);
      const missingPath = join(tmpDir, 'non_existent_file.txt');

      await assert.rejects(async () => {
        await handler({ path: missingPath });
      });
    });
  });

  describe('Prompt: find-in-tree', () => {
    it('TC-FUNC-073: mode: name mentions find_files only', async () => {
      const handler = getPromptHandler('find-in-tree', promptOptions);

      const result = await handler({ query: '*.ts', root: tmpDir, mode: 'name' });
      assert.equal(result.messages.length, 2);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('mode=name'));
      assert.ok(textMsg.text.includes('`find_files` with pattern "*.ts"'));
      assert.ok(!textMsg.text.includes('`search_text`'));

      const instructionsLink = result.messages[1].content as ResourceLink;
      assert.equal(instructionsLink.type, 'resource_link');
      assert.equal(instructionsLink.uri, INSTRUCTIONS_URI);
    });

    it('TC-FUNC-074: mode: content mentions search_text only', async () => {
      const handler = getPromptHandler('find-in-tree', promptOptions);

      const result = await handler({ query: 'TODO', root: tmpDir, mode: 'content' });
      assert.equal(result.messages.length, 2);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('mode=content'));
      assert.ok(textMsg.text.includes('`search_text` with pattern "TODO"'));
      assert.ok(!textMsg.text.includes('`find_files`'));
    });

    it('TC-FUNC-075: mode: both mentions both find_files and search_text', async () => {
      const handler = getPromptHandler('find-in-tree', promptOptions);

      const result = await handler({ query: 'export', root: tmpDir, mode: 'both' });
      assert.equal(result.messages.length, 2);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('mode=both'));
      assert.ok(textMsg.text.includes('`find_files` with pattern "export"'));
      assert.ok(textMsg.text.includes('`search_text` with pattern "export"'));
    });

    it('TC-FUNC-076: Defaults root to first allowed directory when omitted', async () => {
      const handler = getPromptHandler('find-in-tree', promptOptions);

      const result = await handler({ query: 'main', mode: 'both' });
      const textMsg = result.messages[0].content as TextContent;
      assert.ok(textMsg.text.includes('Find "main" in'));
      assert.ok(textMsg.text.includes('`find_files`'));
      assert.ok(textMsg.text.includes('`search_text`'));
    });
  });

  describe('Prompt: summarize-directory', () => {
    it('TC-FUNC-077: Summarizes valid directory with default depth', async () => {
      const handler = getPromptHandler('summarize-directory', promptOptions);

      const result = await handler({ path: tmpDir, depth: 3 });
      assert.equal(result.messages.length, 2);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('Summarize this project at'));
      assert.ok(textMsg.text.includes('`list` with maxDepth=3'));
      assert.ok(textMsg.text.includes('README.md, package.json'));

      const pathLink = result.messages[1].content as ResourceLink;
      assert.equal(pathLink.type, 'resource_link');
    });

    it('TC-FUNC-078: Summarizes valid directory with custom depth', async () => {
      const handler = getPromptHandler('summarize-directory', promptOptions);

      const result = await handler({ path: tmpDir, depth: 5 });
      assert.equal(result.messages.length, 2);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('`list` with maxDepth=5'));
    });

    it('TC-FUNC-079: Throws error for non-existent directory', async () => {
      const handler = getPromptHandler('summarize-directory', promptOptions);
      const missingDir = join(tmpDir, 'missing_sub_directory');

      await assert.rejects(async () => {
        await handler({ path: missingDir, depth: 3 });
      });
    });
  });
});
