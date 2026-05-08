import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

import type { StructuredPatch } from 'diff';
import { test } from 'node:test';

const workerUrl = new URL('../../src/lib/worker.ts', import.meta.url);

interface SuccessResponse {
  id: number;
  ok: true;
  value: StructuredPatch;
}

function once<T>(w: Worker): Promise<T> {
  return new Promise((resolve, reject) => {
    w.once('message', (msg: T) => {
      resolve(msg);
    });
    w.once('error', reject);
  });
}

test('worker dispatch handles diff task', async () => {
  const w = new Worker(fileURLToPath(workerUrl), {
    execArgv: ['--import', 'tsx/esm'],
  });
  try {
    const msg = once<SuccessResponse>(w);
    w.postMessage({
      id: 1,
      name: 'diff',
      payload: {
        oldStr: 'a\nb\n',
        newStr: 'a\nc\n',
        oldHeader: 'old',
        newHeader: 'new',
      },
    });
    const response = await msg;
    assert.equal(response.ok, true);
    assert.equal(response.id, 1);
    assert.ok(Array.isArray(response.value.hunks));
    assert.ok(response.value.hunks.length > 0);
  } finally {
    await w.terminate();
  }
});

test('worker dispatch reports error for unknown task', async () => {
  const w = new Worker(fileURLToPath(workerUrl), {
    execArgv: ['--import', 'tsx/esm'],
  });
  try {
    const msg = once<{
      id: number;
      ok: false;
      error: { kind: string; message: string };
    }>(w);
    w.postMessage({ id: 2, name: 'nope', payload: {} });
    const response = await msg;
    assert.equal(response.ok, false);
    assert.equal(response.error.kind, 'generic');
    assert.match(response.error.message, /Unknown worker task/);
  } finally {
    await w.terminate();
  }
});
