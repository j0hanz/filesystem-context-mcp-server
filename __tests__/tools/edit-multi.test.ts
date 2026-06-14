/**
 * Integration tests for the unified edit tool: single, paths[], files[].
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { assertOk, createTestEnv, getStructured, type TestEnv } from '../helpers.js';

describe('edit tool — input validation', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('rejects when none of path/paths/files is provided', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: { edits: [{ oldText: 'a', newText: 'b' }] },
    });
    assert.equal(res.isError, true);
  });

  it('rejects when both path and paths are provided', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: join(env.tmpDir, 'x.txt'),
        paths: [join(env.tmpDir, 'y.txt')],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });

  it('rejects when both path and files are provided', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: join(env.tmpDir, 'x.txt'),
        files: [{ path: join(env.tmpDir, 'y.txt'), edits: [{ oldText: 'a', newText: 'b' }] }],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });

  it('rejects paths[] with more than 5 entries', async () => {
    const paths = Array.from({ length: 6 }, (_, i) => join(env.tmpDir, `f${i}.txt`));
    const res = await env.client.callTool({
      name: 'edit',
      arguments: { paths, edits: [{ oldText: 'a', newText: 'b' }] },
    });
    assert.equal(res.isError, true);
  });

  it('rejects files[] with more than 5 entries', async () => {
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: join(env.tmpDir, `f${i}.txt`),
      edits: [{ oldText: 'a', newText: 'b' }],
    }));
    const res = await env.client.callTool({ name: 'edit', arguments: { files } });
    assert.equal(res.isError, true);
  });

  it('rejects paths[] without edits', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: { paths: [join(env.tmpDir, 'x.txt')] },
    });
    assert.equal(res.isError, true);
  });

  it('rejects files[] with top-level edits', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        files: [{ path: join(env.tmpDir, 'x.txt'), edits: [{ oldText: 'a', newText: 'b' }] }],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });

  it('rejects when both paths and files are provided', async () => {
    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        paths: [join(env.tmpDir, 'x.txt')],
        files: [{ path: join(env.tmpDir, 'y.txt'), edits: [{ oldText: 'a', newText: 'b' }] }],
        edits: [{ oldText: 'a', newText: 'b' }],
      },
    });
    assert.equal(res.isError, true);
  });
});

describe('edit tool — paths[] mode', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('applies same edits to multiple files', async () => {
    const a = join(env.tmpDir, 'a.ts');
    const b = join(env.tmpDir, 'b.ts');
    await writeFile(a, 'const x = 1;\nconst y = 2;\n', 'utf8');
    await writeFile(b, 'const x = 1;\nconst z = 3;\n', 'utf8');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        paths: [a, b],
        edits: [{ oldText: 'const x = 1;', newText: 'const x = 42;' }],
      },
    });

    assertOk(res);
    const s = getStructured(res);
    assert.ok(Array.isArray(s['results']));
    const results = s['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);
    const value0 = results[0]?.['value'] as Record<string, unknown> | undefined;
    const value1 = results[1]?.['value'] as Record<string, unknown> | undefined;
    assert.equal(value0?.['appliedEdits'], 1);
    assert.equal(value1?.['appliedEdits'], 1);
    const contA = await readFile(a, 'utf8');
    const contB = await readFile(b, 'utf8');
    assert.ok(contA.includes('const x = 42;'));
    assert.ok(contB.includes('const x = 42;'));
  });

  it('isolates failures — other files succeed', async () => {
    const a = join(env.tmpDir, 'good.ts');
    const b = join(env.tmpDir, 'bad-missing.ts'); // does not exist
    await writeFile(a, 'hello world\n', 'utf8');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        paths: [a, b],
        edits: [{ oldText: 'hello world', newText: 'goodbye world' }],
      },
    });

    assertOk(res);
    const s = getStructured(res);
    const results = s['results'] as Record<string, unknown>[];
    const successCount = results.filter((r) => r['value'] !== undefined).length;
    const failureCount = results.filter((r) => r['error'] !== undefined).length;
    assert.equal(successCount, 1, 'one success');
    assert.equal(failureCount, 1, 'one failure');
    const contA = await readFile(a, 'utf8');
    assert.ok(contA.includes('goodbye world'));
  });

  it('summary string format matches design (n/N ok only when some failed)', async () => {
    const a = join(env.tmpDir, 'sum.ts');
    const b = join(env.tmpDir, 'sum-missing.ts'); // does not exist
    await writeFile(a, 'const v = 0;\n', 'utf8');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        paths: [a, b],
        edits: [{ oldText: 'const v = 0;', newText: 'const v = 1;' }],
      },
    });

    assertOk(res);
    const text = (res.content as { type: string; text?: string }[])
      .filter((c) => c.type === 'text')
      .map((c) => c.text)
      .join('');
    assert.ok(text.startsWith('edit:'), `summary should start with 'edit:': ${text}`);
    assert.ok(text.includes('(1/2 ok)'), `should contain '(1/2 ok)': ${text}`);
  });
});

describe('edit tool — files[] mode', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('applies per-file edits', async () => {
    const a = join(env.tmpDir, 'fa.ts');
    const b = join(env.tmpDir, 'fb.ts');
    await writeFile(a, 'const a = 1;\n', 'utf8');
    await writeFile(b, 'const b = 2;\n', 'utf8');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        files: [
          { path: a, edits: [{ oldText: 'const a = 1;', newText: 'const a = 99;' }] },
          { path: b, edits: [{ oldText: 'const b = 2;', newText: 'const b = 88;' }] },
        ],
      },
    });

    assertOk(res);
    const s = getStructured(res);
    const results = s['results'] as Record<string, unknown>[];
    assert.equal(results.length, 2);
    const contA = await readFile(a, 'utf8');
    const contB = await readFile(b, 'utf8');
    assert.ok(contA.includes('const a = 99;'));
    assert.ok(contB.includes('const b = 88;'));
  });

  it('dryRun: does not write files, returns diff', async () => {
    const a = join(env.tmpDir, 'dry.ts');
    await writeFile(a, 'const x = 0;\n', 'utf8');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        files: [{ path: a, edits: [{ oldText: 'const x = 0;', newText: 'const x = 99;' }] }],
        dryRun: true,
      },
    });

    assertOk(res);
    const s = getStructured(res);
    const results2 = s['results'] as Record<string, unknown>[];
    assert.ok(results2?.length === 1);
    const value = results2[0]?.['value'] as Record<string, unknown> | undefined;
    assert.ok(value?.['diff'], 'dryRun should include diff');
    const cont = await readFile(a, 'utf8');
    assert.ok(cont.includes('const x = 0;'), 'file should not be modified in dryRun');
  });
});

describe('edit tool — ignoreWhitespace matching', () => {
  let env: TestEnv;

  before(async () => {
    env = await createTestEnv();
  });

  after(async () => {
    await env.cleanup();
  });

  it('tolerates horizontal whitespace differences on the same line', async () => {
    const a = join(env.tmpDir, 'ws-flex.ts');
    await writeFile(a, 'const   x    =   1;\n', 'utf8');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: a,
        edits: [{ oldText: 'const x = 1;', newText: 'const x = 2;' }],
        ignoreWhitespace: true,
      },
    });

    assertOk(res);
    const cont = await readFile(a, 'utf8');
    assert.ok(cont.includes('const x = 2;'), 'flexible horizontal whitespace should match');
  });

  it('does not let a single-line oldText match across a newline boundary', async () => {
    const a = join(env.tmpDir, 'ws-boundary.ts');
    // The two statements live on separate lines; a single-line oldText must not
    // collapse the newline and match across the boundary.
    await writeFile(a, 'x = 1;\ny = 2;\n', 'utf8');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: a,
        edits: [{ oldText: 'x = 1; y = 2;', newText: 'z = 0;' }],
        ignoreWhitespace: true,
      },
    });

    // A no-match is surfaced as a per-path failure in the batch envelope.
    const s = getStructured(res);
    const results = s['results'] as Record<string, unknown>[];
    assert.equal(results.length, 1);
    assert.ok(results[0]?.['error'], 'single-line oldText must not match across the newline');
    const cont = await readFile(a, 'utf8');
    assert.equal(cont, 'x = 1;\ny = 2;\n', 'file must be unchanged when no real match exists');
  });

  it('matches a multi-line oldText against the same multi-line block', async () => {
    const a = join(env.tmpDir, 'ws-multiline.ts');
    await writeFile(a, 'if (a) {\n    return 1;\n}\n', 'utf8');

    const res = await env.client.callTool({
      name: 'edit',
      arguments: {
        path: a,
        // Differing indentation but the same line structure must still match.
        edits: [{ oldText: 'if (a) {\nreturn 1;\n}', newText: 'if (a) {\n  return 2;\n}' }],
        ignoreWhitespace: true,
      },
    });

    assertOk(res);
    const cont = await readFile(a, 'utf8');
    assert.ok(cont.includes('return 2;'), 'multi-line block should match across real newlines');
  });
});
