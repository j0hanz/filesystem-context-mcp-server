import type { ResourceLink, TextContent } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { PROMPT_ENTRIES } from '../src/prompts.js';
import { buildSectionsRecord, INSTRUCTIONS_URI, renderSections } from '../src/resources.js';
import {
  cleanupTestRoot,
  createTestClientPair,
  createTestRoot,
  type TestClientContext,
  writeTestFile,
} from './helpers.js';

describe('MCP Prompts Tests (MCP Client)', () => {
  let tmpDir: string;
  let harness: TestClientContext;
  let sections: Record<string, string>;
  let fullInstructions: string;

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createTestClientPair([tmpDir]);
    sections = buildSectionsRecord(false);
    fullInstructions = renderSections(sections);
  });

  after(async () => {
    if (harness) {
      await harness.close();
    }
    if (tmpDir) {
      await cleanupTestRoot(tmpDir);
    }
  });

  describe('Prompt Definitions & Registration', () => {
    it('TC-FUNC-067: PROMPT_ENTRIES and client.listPrompts() return all 4 prompts', async () => {
      assert.equal(PROMPT_ENTRIES.length, 4);

      const promptsList = await harness.client.listPrompts();
      const promptNames = promptsList.prompts.map((p) => p.name);
      assert.deepEqual(promptNames, [
        'get-help',
        'analyze-path',
        'find-in-tree',
        'summarize-directory',
      ]);

      for (const entry of promptsList.prompts) {
        assert.ok((entry.title?.length ?? 0) > 0, `Title should be defined for ${entry.name}`);
        assert.ok(
          (entry.description?.length ?? 0) > 0,
          `Description should be defined for ${entry.name}`,
        );
      }
    });
  });

  describe('Prompt: get-help', () => {
    it('TC-FUNC-068: Returns all instructions when no topic is provided', async () => {
      const result = await harness.client.getPrompt({ name: 'get-help', arguments: {} });

      assert.equal(result.messages.length, 1);
      assert.equal(result.messages[0].role, 'user');
      const textContent = result.messages[0].content as TextContent;
      assert.equal(textContent.type, 'text');
      assert.equal(textContent.text, fullInstructions);
      assert.ok(textContent.text.includes('Guidelines:'));
      assert.ok(textContent.text.includes('Tools Overview:'));
      assert.ok(textContent.text.includes('Constraints:'));
      assert.ok(textContent.text.includes('Error Recovery:'));
    });

    it('TC-FUNC-069: Returns filtered section for specific topic and fallback for unknown topic', async () => {
      // Specific known topic
      const guidelinesResult = await harness.client.getPrompt({
        name: 'get-help',
        arguments: { topic: 'guidelines' },
      });
      assert.equal(guidelinesResult.messages.length, 1);
      const guidelinesText = (guidelinesResult.messages[0].content as TextContent).text;
      assert.equal(guidelinesText, sections['guidelines']);
      assert.ok(guidelinesText.includes('root_access:'));
      assert.ok(!guidelinesText.includes('Error Recovery:'));

      // Another known topic (case-insensitive)
      const errorResult = await harness.client.getPrompt({
        name: 'get-help',
        arguments: { topic: 'ERROR_RECOVERY' },
      });
      const errorText = (errorResult.messages[0].content as TextContent).text;
      assert.equal(errorText, sections['error_recovery']);
      assert.ok(errorText.includes('ACCESS_DENIED:'));

      // Unknown topic
      const unknownResult = await harness.client.getPrompt({
        name: 'get-help',
        arguments: { topic: 'unknown_topic_name' },
      });
      const unknownText = (unknownResult.messages[0].content as TextContent).text;
      assert.ok(unknownText.startsWith("Section 'unknown_topic_name' not found. Available:"));
      assert.ok(unknownText.includes('guidelines, tools_overview, constraints, error_recovery'));
      assert.ok(unknownText.includes(fullInstructions));
    });
  });

  describe('Prompt: analyze-path', () => {
    it('TC-FUNC-070: Analyzes a file and mentions stat and read', async () => {
      const filePath = await writeTestFile(tmpDir, 'sample.txt', 'Sample file content');
      const result = await harness.client.getPrompt({
        name: 'analyze-path',
        arguments: { path: filePath },
      });
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
      const result = await harness.client.getPrompt({
        name: 'analyze-path',
        arguments: { path: tmpDir },
      });
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
      const missingPath = join(tmpDir, 'non_existent_file.txt');
      await assert.rejects(async () => {
        await harness.client.getPrompt({
          name: 'analyze-path',
          arguments: { path: missingPath },
        });
      });
    });
  });

  describe('Prompt: find-in-tree', () => {
    it('TC-FUNC-073: mode: name mentions find_files only', async () => {
      const result = await harness.client.getPrompt({
        name: 'find-in-tree',
        arguments: { query: '*.ts', root: tmpDir, mode: 'name' },
      });
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
      const result = await harness.client.getPrompt({
        name: 'find-in-tree',
        arguments: { query: 'TODO', root: tmpDir, mode: 'content' },
      });
      assert.equal(result.messages.length, 2);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('mode=content'));
      assert.ok(textMsg.text.includes('`search_text` with pattern "TODO"'));
      assert.ok(!textMsg.text.includes('`find_files`'));
    });

    it('TC-FUNC-075: mode: both mentions both find_files and search_text', async () => {
      const result = await harness.client.getPrompt({
        name: 'find-in-tree',
        arguments: { query: 'export', root: tmpDir, mode: 'both' },
      });
      assert.equal(result.messages.length, 2);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('mode=both'));
      assert.ok(textMsg.text.includes('`find_files` with pattern "export"'));
      assert.ok(textMsg.text.includes('`search_text` with pattern "export"'));
    });

    it('TC-FUNC-076: Defaults root to first allowed directory when omitted', async () => {
      const result = await harness.client.getPrompt({
        name: 'find-in-tree',
        arguments: { query: 'main', mode: 'both' },
      });
      const textMsg = result.messages[0].content as TextContent;
      assert.ok(textMsg.text.includes('Find "main" in'));
      assert.ok(textMsg.text.includes('`find_files`'));
      assert.ok(textMsg.text.includes('`search_text`'));
    });
  });

  describe('Prompt: summarize-directory', () => {
    it('TC-FUNC-077: Summarizes valid directory with default depth', async () => {
      const result = await harness.client.getPrompt({
        name: 'summarize-directory',
        arguments: { path: tmpDir, depth: '3' },
      });
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
      const result = await harness.client.getPrompt({
        name: 'summarize-directory',
        arguments: { path: tmpDir, depth: '5' },
      });
      assert.equal(result.messages.length, 2);

      const textMsg = result.messages[0].content as TextContent;
      assert.equal(textMsg.type, 'text');
      assert.ok(textMsg.text.includes('`list` with maxDepth=5'));
    });

    it('TC-FUNC-079: Throws error for non-existent directory', async () => {
      const missingDir = join(tmpDir, 'missing_sub_directory');
      await assert.rejects(async () => {
        await harness.client.getPrompt({
          name: 'summarize-directory',
          arguments: { path: missingDir, depth: '3' },
        });
      });
    });
  });
});
