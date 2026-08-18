import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode } from '../../src/core/errors.js';
import { runOverPaths } from '../../src/tools/batch.js';
import type { ToolCtx } from '../../src/tools/define.js';

function fakeCtx(overrides: Partial<ToolCtx> = {}): ToolCtx {
  const ctx: ToolCtx = {
    signal: new AbortController().signal,
    pathGuard: {} as ToolCtx['pathGuard'],
    resourceStore: undefined,
    ...overrides,
  };
  return ctx;
}

describe('runOverPaths', () => {
  it('dispatches { path } mode -> one result with no override', async () => {
    const seen: { path: string; override: unknown }[] = [];
    const out = await runOverPaths<undefined, string>({ path: '/x' }, fakeCtx(), async (item) => {
      seen.push({ path: item.path, override: item.override });
      return `read:${item.path}`;
    });
    assert.deepEqual(seen, [{ path: '/x', override: undefined }]);
    assert.equal(out.results.length, 1);
    assert.equal(out.results[0]?.path, '/x');
    assert.equal(out.results[0]?.value, 'read:/x');
    assert.equal(out.results[0]?.error, undefined);
    assert.deepEqual(out.summary, { total: 1, succeeded: 1, failed: 0 });
  });

  it('dispatches { paths } mode -> N results in input order', async () => {
    const out = await runOverPaths<undefined, string>(
      { paths: ['/a', '/b', '/c'] },
      fakeCtx(),
      async (item) => `r:${item.path}`,
    );
    assert.equal(out.results.length, 3);
    assert.equal(out.results[0]?.path, '/a');
    assert.equal(out.results[1]?.path, '/b');
    assert.equal(out.results[2]?.path, '/c');
    assert.deepEqual(out.summary, { total: 3, succeeded: 3, failed: 0 });
  });

  it('dispatches { files } mode -> passes per-path overrides', async () => {
    interface Override {
      tag: string;
    }
    const seen: { path: string; tag: string | undefined }[] = [];
    const out = await runOverPaths<Override, string>(
      {
        files: [
          { path: '/a', tag: 'A' },
          { path: '/b', tag: 'B' },
        ],
      },
      fakeCtx(),
      async (item) => {
        seen.push({ path: item.path, tag: item.override?.tag });
        return `r:${item.path}`;
      },
    );
    assert.deepEqual(seen, [
      { path: '/a', tag: 'A' },
      { path: '/b', tag: 'B' },
    ]);
    assert.equal(out.results[0]?.path, '/a');
    assert.equal(out.results[1]?.path, '/b');
  });

  it('catches per-path throw and classifies via Problem.fromUnknown', async () => {
    const out = await runOverPaths<undefined, string>(
      { paths: ['/ok', '/bad'] },
      fakeCtx(),
      async (item) => {
        if (item.path === '/bad') {
          const err: NodeJS.ErrnoException = Object.assign(new Error('not found'), {
            code: 'ENOENT',
          });
          throw err;
        }
        return 'ok';
      },
      { defaultErrorCode: ErrorCode.NOT_FOUND },
    );
    assert.equal(out.results[0]?.value, 'ok');
    assert.equal(out.results[1]?.value, undefined);
    assert.equal(out.results[1]?.error?.code, ErrorCode.NOT_FOUND);
    assert.deepEqual(out.summary, { total: 2, succeeded: 1, failed: 1 });
  });

  it('fires onProgress per completed path with running counter', async () => {
    const ticks: { current: number; total: number | undefined }[] = [];
    await runOverPaths<undefined, string>(
      { paths: ['/a', '/b', '/c'] },
      fakeCtx({ onProgress: (p) => ticks.push({ current: p.current, total: p.total }) }),
      async () => 'ok',
    );
    assert.equal(ticks.length, 3);
    assert.equal(ticks[ticks.length - 1]?.current, 3);
    assert.equal(ticks[ticks.length - 1]?.total, 3);
  });

  it('throws when none of path/paths/files is provided', async () => {
    await assert.rejects(
      runOverPaths<undefined, string>({}, fakeCtx(), async () => 'ok'),
      /at least one of/i,
    );
  });
});
