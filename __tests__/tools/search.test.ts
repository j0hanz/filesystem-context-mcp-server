/**
 * Integration tests for search tools: grep (search_content), find (search_files),
 * and search_and_replace.
 */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  assertToolError,
  createTestEnv,
  getStructured,
  type TestEnv,
  type ToolResult,
} from '../helpers.js';

// ─── grep (search_content) ───────────────────────────────────────────────────

describe('grep tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(
      join(env.tmpDir, 'fruits.txt'),
      'apple\nbanana\ncherry\n',
      'utf8'
    );
    await writeFile(
      join(env.tmpDir, 'veggies.txt'),
      'carrot\napricot\ncucumber\n',
      'utf8'
    );
    const sub = join(env.tmpDir, 'sub');
    await mkdir(sub);
    await writeFile(join(sub, 'deep.txt'), 'another apple here\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('finds literal matches across files', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: { path: env.tmpDir, searchPattern: 'apple' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const matches = sc['matches'] as Record<string, unknown>[];
    assert.ok(
      Array.isArray(matches) && matches.length >= 2,
      'Should match apple in at least 2 files'
    );
  });

  it('finds regex matches', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: { path: env.tmpDir, searchPattern: '^a[a-z]+', isRegex: true },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const matches = sc['matches'] as Record<string, unknown>[];
    assert.ok(
      Array.isArray(matches) && matches.length > 0,
      'Should find lines starting with "a"'
    );
  });

  it('restricts search using filePattern', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: { path: env.tmpDir, searchPattern: 'a', pattern: '*.txt' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
  });

  it('rejects unsafe filePattern values before traversal', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: {
        path: env.tmpDir,
        searchPattern: 'apple',
        pattern: '../*.txt',
      },
    });
    assertToolError(raw);
    const result = raw as ToolResult;
    const textBlock = result.content.find(
      (block: {
        type: string;
        text?: string;
      }): block is { type: string; text: string } =>
        typeof block.text === 'string'
    );
    assert.ok(textBlock, 'Expected text response content');
    assert.match(
      textBlock.text,
      /Invalid glob or unsafe path \(absolute\/\.\. forbidden\)/u
    );
  });

  it('returns empty matches for a pattern that is not found', async () => {
    const raw = await env.client.callTool({
      name: 'grep',
      arguments: { path: env.tmpDir, searchPattern: 'ZZZNOMATCH' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const matches = sc['matches'] as Record<string, unknown>[];
    assert.equal(matches.length, 0, 'Should return empty matches array');
  });

  it('preserves UTF-8 match text in the rendered response body', async () => {
    const file = join(env.tmpDir, 'utf8.txt');
    await writeFile(file, 'rocket 🚀 line\n', 'utf8');

    const raw = await env.client.callTool({
      name: 'grep',
      arguments: { path: env.tmpDir, searchPattern: 'rocket' },
    });

    assertOk(raw);
    const result = raw as ToolResult;
    const textBlock = result.content.find(
      (block: {
        type: string;
        text?: string;
      }): block is { type: string; text: string } =>
        typeof block.text === 'string'
    );
    assert.ok(textBlock, 'Expected text response content');
    assert.match(textBlock.text, /utf8\.txt:\s+1: rocket 🚀 line/);
  });

  it('supports task-mode execution via the client tasks API', async () => {
    const taskFile = join(env.tmpDir, 'task-grep.txt');
    await writeFile(taskFile, 'needle here\nanother line\n', 'utf8');

    const events: string[] = [];
    const statuses: string[] = [];
    let taskId: string | undefined;
    let finalResult: ToolResult | undefined;

    const stream = env.client.experimental.tasks.callToolStream(
      {
        name: 'grep',
        arguments: {
          path: env.tmpDir,
          searchPattern: 'needle',
          pattern: '*.txt',
          maxResults: 10,
        },
      },
      { task: { ttl: 60_000 } }
    );

    for await (const message of stream) {
      events.push(message.type);
      if (message.type === 'taskCreated') {
        taskId = message.task.taskId;
      }
      if (message.type === 'taskStatus') {
        statuses.push(message.task.status);
      }
      if (message.type === 'result') {
        finalResult = message.result as ToolResult;
      }
    }

    assert.equal(events[0], 'taskCreated');
    assert.ok(taskId, 'Expected task-mode execution to return a task id');
    assert.ok(
      statuses.some((status) => status === 'working' || status === 'completed'),
      `Expected task status updates, got ${JSON.stringify(statuses)}`
    );
    assert.ok(finalResult, 'Expected a final task result');
    assertOk(finalResult);

    const sc = getStructured(finalResult);
    const matches = sc['matches'] as Record<string, unknown>[];
    assert.ok(Array.isArray(matches) && matches.length > 0);
    assert.equal(matches[0]?.['file'], 'task-grep.txt');

    const storedTask = await env.client.experimental.tasks.getTask(taskId);
    assert.equal(storedTask.status, 'completed');

    const storedResult =
      await env.client.experimental.tasks.getTaskResult(taskId);
    assert.equal(storedResult.isError, undefined);
  });
});

// ─── find (search_files) ─────────────────────────────────────────────────────

describe('find tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(join(env.tmpDir, 'match1.ts'), '', 'utf8');
    await writeFile(join(env.tmpDir, 'match2.ts'), '', 'utf8');
    await writeFile(join(env.tmpDir, 'other.json'), '{}', 'utf8');
    const sub = join(env.tmpDir, 'src');
    await mkdir(sub);
    await writeFile(join(sub, 'match3.ts'), '', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('finds files matching a glob pattern', async () => {
    const raw = await env.client.callTool({
      name: 'find',
      arguments: { path: env.tmpDir, pattern: '**/*.ts' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(results.length >= 3, 'Expected at least 3 .ts files');
  });

  it('excludes non-matching files', async () => {
    const raw = await env.client.callTool({
      name: 'find',
      arguments: { path: env.tmpDir, pattern: '**/*.json' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    assert.ok(results.every((r) => (r['path'] as string).endsWith('.json')));
  });

  it('returns empty results when no files match', async () => {
    const raw = await env.client.callTool({
      name: 'find',
      arguments: { path: env.tmpDir, pattern: '**/*.neverexists' },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    const results = sc['results'] as Record<string, unknown>[];
    assert.equal(results.length, 0);
  });
});

// ─── search_and_replace ──────────────────────────────────────────────────────

describe('search_and_replace tool', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
    await writeFile(
      join(env.tmpDir, 'file1.txt'),
      'hello world\nhello again\n',
      'utf8'
    );
    await writeFile(join(env.tmpDir, 'file2.txt'), 'goodbye world\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('replaces text in all matching files', async () => {
    const raw = await env.client.callTool({
      name: 'search_and_replace',
      arguments: {
        path: env.tmpDir,
        pattern: '*.txt',
        searchPattern: 'world',
        replacement: 'WORLD',
      },
    });
    const result = raw;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    const file1 = await readFile(join(env.tmpDir, 'file1.txt'), 'utf8');
    assert.ok(file1.includes('WORLD'), 'Expected replacement in file1');
    const file2 = await readFile(join(env.tmpDir, 'file2.txt'), 'utf8');
    assert.ok(file2.includes('WORLD'), 'Expected replacement in file2');
  });

  it('dryRun:true does not modify any files', async () => {
    await writeFile(join(env.tmpDir, 'dry.txt'), 'oldvalue\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'search_and_replace',
      arguments: {
        path: env.tmpDir,
        pattern: 'dry.txt',
        searchPattern: 'oldvalue',
        replacement: 'newvalue',
        dryRun: true,
      },
    });
    assertOk(raw);
    const actual = await readFile(join(env.tmpDir, 'dry.txt'), 'utf8');
    assert.equal(actual, 'oldvalue\n', 'File must be unchanged in dryRun');
  });

  it('supports regex replacement', async () => {
    const file = join(env.tmpDir, 'regex-test.txt');
    await writeFile(file, 'cat123\ndog456\n', 'utf8');
    const raw = await env.client.callTool({
      name: 'search_and_replace',
      arguments: {
        path: env.tmpDir,
        pattern: 'regex-test.txt',
        searchPattern: '\\d+',
        replacement: 'NUM',
        isRegex: true,
      },
    });
    assertOk(raw);
    const actual = await readFile(file, 'utf8');
    assert.ok(
      actual.includes('NUM'),
      'Regex replacement should have substituted digits'
    );
    assert.ok(!/\d/.exec(actual), 'No digits should remain');
  });

  it('returns ACCESS_DENIED when path escapes allowed root', async () => {
    const raw = await env.client.callTool({
      name: 'search_and_replace',
      arguments: {
        path: '/tmp',
        pattern: '*.txt',
        searchPattern: 'x',
        replacement: 'y',
      },
    });
    assertToolError(raw, 'ACCESS_DENIED');
  });
});
