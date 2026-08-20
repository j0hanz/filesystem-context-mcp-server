import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

describe('--print-config (TASK-006/007)', () => {
  let originalArgv: string[];

  before(() => {
    originalArgv = process.argv.slice();
  });

  after(() => {
    process.argv = originalArgv;
  });

  it('parseArgs returns printConfig:false by default', async () => {
    process.argv = ['node', 'index.js'];
    const { parseArgs } = await import('../../src/cli.js');
    const result = await parseArgs();
    assert.equal(result.printConfig, false);
  });

  it('parseArgs returns printConfig:true for --print-config', async () => {
    process.argv = ['node', 'index.js', '--print-config'];
    const { parseArgs } = await import('../../src/cli.js');
    const result = await parseArgs();
    assert.equal(result.printConfig, true);
  });

  it('parseArgs returns json:false by default', async () => {
    process.argv = ['node', 'index.js'];
    const { parseArgs } = await import('../../src/cli.js');
    const result = await parseArgs();
    assert.equal(result.json, false);
  });

  it('parseArgs returns json:true for --json', async () => {
    process.argv = ['node', 'index.js', '--json'];
    const { parseArgs } = await import('../../src/cli.js');
    const result = await parseArgs();
    assert.equal(result.json, true);
  });

  it('printConfig resolves config and exits 0 without starting transport', async () => {
    const { runPrintConfig } = await import('../../src/cli.js');
    const lines: string[] = [];
    const capture = (s: string) => lines.push(s);

    // Should resolve without throwing and return a non-null config object
    const cfg = await runPrintConfig({
      allowedDirs: [],
      allowCwd: false,
      readOnly: false,
      json: false,
      stdout: capture,
    });

    assert.ok(cfg !== null && typeof cfg === 'object', 'runPrintConfig must return config object');
    assert.ok(lines.length > 0, 'runPrintConfig must write at least one line');
  });

  it('--json mode emits a parseable JSON object', async () => {
    const { runPrintConfig } = await import('../../src/cli.js');
    const chunks: string[] = [];

    await runPrintConfig({
      allowedDirs: [],
      allowCwd: false,
      readOnly: false,
      json: true,
      stdout: (s) => chunks.push(s),
    });

    const output = chunks.join('');
    const parsed = JSON.parse(output);
    assert.ok(typeof parsed === 'object' && parsed !== null);
    assert.ok('transport' in parsed, 'JSON config must include transport');
    assert.ok('readOnly' in parsed, 'JSON config must include readOnly');
    assert.ok('tools' in parsed, 'JSON config must include tools');
  });

  it('--json mode with readOnly:true shows no mutating tools in tools list', async () => {
    const { runPrintConfig } = await import('../../src/cli.js');
    const chunks: string[] = [];

    await runPrintConfig({
      allowedDirs: [],
      allowCwd: false,
      readOnly: true,
      json: true,
      stdout: (s) => chunks.push(s),
    });

    const cfg = JSON.parse(chunks.join(''));
    assert.equal(cfg.readOnly, true);
    const mutating = ['create', 'edit', 'delete', 'move', 'replace_text'];
    for (const name of mutating) {
      assert.ok(
        !cfg.tools.includes(name),
        `Mutating tool '${name}' must not appear in print-config tools when readOnly:true`,
      );
    }
  });

  it('api-key is redacted in --json output', async () => {
    const { runPrintConfig } = await import('../../src/cli.js');
    const chunks: string[] = [];

    await runPrintConfig({
      allowedDirs: [],
      allowCwd: false,
      readOnly: false,
      json: true,
      apiKey: 'super-secret',
      stdout: (s) => chunks.push(s),
    });

    const output = chunks.join('');
    assert.ok(!output.includes('super-secret'), 'Raw api-key must not appear in output');
    const cfg = JSON.parse(output);
    assert.equal(cfg.apiKey, '***', 'api-key must be redacted to ***');
  });

  it('text mode emits key: value lines', async () => {
    const { runPrintConfig } = await import('../../src/cli.js');
    const lines: string[] = [];

    await runPrintConfig({
      allowedDirs: [],
      allowCwd: false,
      readOnly: false,
      json: false,
      stdout: (s) => lines.push(s),
    });

    // At minimum there must be a transport line and a readOnly line
    const joined = lines.join('\n');
    assert.ok(joined.includes('transport'), 'text output must include transport');
    assert.ok(joined.includes('readOnly'), 'text output must include readOnly');
  });

  it('parseArgs supports log-level and other bridged options without throwing', async () => {
    process.argv = ['node', 'index.js', '--log-level', 'debug', '--max-file-size', '1048576'];
    const { parseArgs } = await import('../../src/cli.js');
    const result = await parseArgs();
    assert.equal(result.printConfig, false);
  });

  it('parseArgs with --walk-cwd implies --allow-cwd', async () => {
    process.argv = ['node', 'index.js', '--walk-cwd'];
    const { parseArgs } = await import('../../src/cli.js');
    const result = await parseArgs();
    assert.equal(result.allowCwd, true);
  });

  it('parseArgs supports multiple --deny flags', async () => {
    process.argv = ['node', 'index.js', '--deny', 'node_modules', '--deny', 'dist'];
    const { parseArgs } = await import('../../src/cli.js');
    const result = await parseArgs();
    assert.ok(result !== null);
  });

  it('parseArgs supports --allow-missing-roots', async () => {
    process.argv = ['node', 'index.js', '--allow-missing-roots', '/nonexistent/path/here'];
    const { parseArgs } = await import('../../src/cli.js');
    const result = await parseArgs();
    // --allow-missing-roots is consumed via ALLOW_MISSING_ROOTS (lifted in
    // cli-env.ts); its effect here is that a nonexistent root is still accepted.
    assert.ok(result.allowedDirs.length === 1);
  });
});
