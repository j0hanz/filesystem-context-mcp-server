/**
 * Integration tests for diff_files and apply_patch in task mode
 * (tasks/create + tasks/get + tasks/result lifecycle).
 */
import {
  type CallToolResult,
  type CreateTaskResult,
  type GetTaskResult,
} from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import {
  assertOk,
  createTestEnv,
  getStructured,
  type TestEnv,
} from '../helpers.js';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);
const POLL_INTERVAL_MS = 50;
const MAX_POLLS = 40;

async function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Poll tasks/get until the task reaches a terminal status. */
async function pollUntilDone(
  client: TestEnv['client'],
  taskId: string
): Promise<{ status: string }> {
  for (let i = 0; i < MAX_POLLS; i++) {
    await delay(POLL_INTERVAL_MS);
    const got = (await client.request({
      method: 'tasks/get' as const,
      params: { taskId },
    }));
    if (TERMINAL_STATUSES.has(got.status)) return { status: got.status };
  }
  assert.fail(
    `Task ${taskId} did not reach terminal status after ${MAX_POLLS} polls`
  );
}

// ─── diff_files (task mode) ──────────────────────────────────────────────────

describe('task mode: diff_files', () => {
  let env: TestEnv;
  let fileA: string;
  let fileB: string;

  before(async () => {
    env = await createTestEnv();
    fileA = join(env.tmpDir, 'a.txt');
    fileB = join(env.tmpDir, 'b.txt');
    await writeFile(fileA, 'line1\nline2\nline3\n', 'utf8');
    await writeFile(fileB, 'line1\nline2-changed\nline3\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('creates a task and completes with diff result', async () => {
    const createResult = (await env.client.request(
      {
        method: 'tools/call' as const,
        params: {
          name: 'diff_files',
          arguments: { original: fileA, modified: fileB },
        },
      },
      { task: {} }
    )) as CreateTaskResult;

    const { taskId } = createResult.task;
    assert.ok(taskId, 'taskId must be non-empty');
    assert.ok(
      ['working', 'completed'].includes(createResult.task.status),
      `unexpected initial status: ${createResult.task.status}`
    );

    const taskState = await pollUntilDone(env.client, taskId);
    assert.equal(taskState.status, 'completed', 'task must complete');

    const result = (await env.client.request({
      method: 'tasks/result' as const,
      params: { taskId },
    })) as CallToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(sc['isIdentical'], false);
  });

  it('tasks/get returns valid task metadata', async () => {
    const createResult = (await env.client.request(
      {
        method: 'tools/call' as const,
        params: {
          name: 'diff_files',
          arguments: { original: fileA, modified: fileB },
        },
      },
      { task: {} }
    )) as CreateTaskResult;

    const { taskId } = createResult.task;
    const taskState = await pollUntilDone(env.client, taskId);

    assert.equal(typeof taskState.status, 'string');
    assert.ok(
      TERMINAL_STATUSES.has(taskState.status),
      `expected terminal status, got: ${taskState.status}`
    );
  });
});

// ─── apply_patch (task mode) ─────────────────────────────────────────────────

describe('task mode: apply_patch', () => {
  let env: TestEnv;
  let target: string;

  before(async () => {
    env = await createTestEnv();
    target = join(env.tmpDir, 'target.txt');
    await writeFile(target, 'hello\nworld\n', 'utf8');
  });

  after(async () => {
    await env.cleanup();
  });

  it('creates a task and completes with patch result', async () => {
    const patch = [
      '--- a/target.txt',
      '+++ b/target.txt',
      '@@ -1,2 +1,2 @@',
      '-hello',
      '+goodbye',
      ' world',
      '',
    ].join('\n');

    const createResult = (await env.client.request(
      {
        method: 'tools/call' as const,
        params: {
          name: 'apply_patch',
          arguments: { path: target, patch },
        },
      },
      { task: {} }
    )) as CreateTaskResult;

    const { taskId } = createResult.task;
    assert.ok(taskId, 'taskId must be non-empty');

    const taskState = await pollUntilDone(env.client, taskId);
    assert.equal(taskState.status, 'completed', 'task must complete');

    const result = (await env.client.request({
      method: 'tasks/result' as const,
      params: { taskId },
    })) as CallToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(sc['applied'], true);
  });

  it('dry run task completes without modifying file', async () => {
    const original = 'goodbye\nworld\n';
    await writeFile(target, original, 'utf8');

    const patch = [
      '--- a/target.txt',
      '+++ b/target.txt',
      '@@ -1,2 +1,2 @@',
      '-goodbye',
      '+farewell',
      ' world',
      '',
    ].join('\n');

    const createResult = (await env.client.request(
      {
        method: 'tools/call' as const,
        params: {
          name: 'apply_patch',
          arguments: { path: target, patch, dryRun: true },
        },
      },
      { task: {} }
    )) as CreateTaskResult;

    const { taskId } = createResult.task;
    const taskState = await pollUntilDone(env.client, taskId);
    assert.equal(taskState.status, 'completed', 'dry run task must complete');

    const result = (await env.client.request({
      method: 'tasks/result' as const,
      params: { taskId },
    })) as CallToolResult;
    assertOk(result);
    const sc = getStructured(result);
    assert.equal(sc['ok'], true);
    assert.equal(sc['applied'], true);

    // Verify file was not modified
    const { readFile } = await import('node:fs/promises');
    const contents = await readFile(target, 'utf8');
    assert.equal(contents, original, 'file should not be modified in dry run');
  });
});
