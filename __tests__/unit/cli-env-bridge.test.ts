import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

// applyBridgeFlags has no project imports so it is safe to import statically
import { applyBridgeFlags, BRIDGE_MAP } from '../../src/core/bridge.js';

describe('applyBridgeFlags — flag→env mapping (TASK-004/005)', () => {
  const origEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    for (const [, envVar] of BRIDGE_MAP) {
      if (origEnv[envVar] === undefined) {
        Reflect.deleteProperty(process.env, envVar);
      } else {
        process.env[envVar] = origEnv[envVar];
      }
    }
    Object.keys(origEnv).forEach((k) => Reflect.deleteProperty(origEnv, k));
  });

  function snapshot() {
    for (const [, envVar] of BRIDGE_MAP) {
      origEnv[envVar] = process.env[envVar];
      Reflect.deleteProperty(process.env, envVar);
    }
  }

  it('maps --max-file-size to MAX_FILE_SIZE', () => {
    snapshot();
    applyBridgeFlags(['--max-file-size', '1048576']);
    assert.equal(process.env['MAX_FILE_SIZE'], '1048576');
  });

  it('maps --log-level to LOG_LEVEL', () => {
    snapshot();
    applyBridgeFlags(['--log-level', 'debug']);
    assert.equal(process.env['LOG_LEVEL'], 'debug');
  });

  it('maps --http-host to HTTP_HOST', () => {
    snapshot();
    applyBridgeFlags(['--http-host', '0.0.0.0']);
    assert.equal(process.env['HTTP_HOST'], '0.0.0.0');
  });

  it('maps --api-key to API_KEY', () => {
    snapshot();
    applyBridgeFlags(['--api-key', 'secret123']);
    assert.equal(process.env['API_KEY'], 'secret123');
  });

  it('maps --allow-sensitive (boolean) to ALLOW_SENSITIVE=1', () => {
    snapshot();
    applyBridgeFlags(['--allow-sensitive']);
    assert.equal(process.env['ALLOW_SENSITIVE'], '1');
  });

  it('maps --root-boundary to ROOT_BOUNDARY', () => {
    snapshot();
    applyBridgeFlags(['--root-boundary', '/tmp/safe']);
    assert.equal(process.env['ROOT_BOUNDARY'], '/tmp/safe');
  });

  it('flag overrides env var already set (flag wins)', () => {
    snapshot();
    process.env['MAX_FILE_SIZE'] = '99999';
    applyBridgeFlags(['--max-file-size', '1048576']);
    assert.equal(process.env['MAX_FILE_SIZE'], '1048576');
  });

  it('flag with no following value is ignored', () => {
    snapshot();
    applyBridgeFlags(['--max-file-size']);
    assert.equal(process.env['MAX_FILE_SIZE'], undefined);
  });

  it('unrecognised flags are silently ignored', () => {
    snapshot();
    applyBridgeFlags(['--unknown-flag', 'value']);
    for (const [, envVar] of BRIDGE_MAP) {
      assert.equal(process.env[envVar], undefined);
    }
  });

  it('bridge covers all nine expected mappings', () => {
    const expectedFlags = new Set([
      '--log-level',
      '--http-host',
      '--api-key',
      '--allow-sensitive',
      '--root-boundary',
      '--max-file-size',
      '--walk-cwd',
      '--allow-missing-roots',
      '--deny',
    ]);
    const actualFlags = new Set(BRIDGE_MAP.map(([flag]) => flag));
    for (const f of expectedFlags) {
      assert.ok(actualFlags.has(f), `BRIDGE_MAP must include flag '${f}'`);
    }
  });

  it('maps multiple --deny flags to comma-separated list', () => {
    snapshot();
    applyBridgeFlags(['--deny', 'node_modules', '--deny', 'dist']);
    assert.equal(process.env['DENYLIST'], 'node_modules,dist');
  });
});
