import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { FLAG_TO_ENV, liftFlagsToEnv, SPECIAL_FLAG_TO_ENV } from '../../src/cli-env.js';
import { CLI_PARSER_CONFIG } from '../../src/cli.js';

function lift(argv: string[]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  liftFlagsToEnv(argv, env);
  return env;
}

describe('liftFlagsToEnv / CLI_PARSER_CONFIG agreement', () => {
  it('every env-backed flag is a declared CLI option', () => {
    const declared = Object.keys(CLI_PARSER_CONFIG.options);
    for (const flag of [...Object.keys(FLAG_TO_ENV), ...Object.keys(SPECIAL_FLAG_TO_ENV)]) {
      assert.ok(declared.includes(flag), `--${flag} is lifted to env but not declared in cli.ts`);
    }
  });

  it('every documented flag/env pair is actually lifted', () => {
    // Guards the original defect: a flag parsed, documented, and then dropped.
    const env = lift([
      '--http-host',
      '0.0.0.0',
      '--api-key',
      'super-secret-key-1234',
      '--log-level',
      'debug',
      '--max-file-size',
      '2097152',
      '--root-boundary',
      '/srv/projects',
      '--allow-sensitive',
      '--walk-cwd',
      '--allow-missing-roots',
      '--deny',
      '*.pem',
      '--deny',
      'secrets/**',
    ]);

    assert.deepEqual(env, {
      HTTP_HOST: '0.0.0.0',
      API_KEY: 'super-secret-key-1234',
      LOG_LEVEL: 'debug',
      MAX_FILE_SIZE: '2097152',
      ROOT_BOUNDARY: '/srv/projects',
      ALLOW_SENSITIVE: '1',
      ALLOW_CWD_WALK: '1',
      ALLOW_MISSING_ROOTS: '1',
      DENYLIST: '*.pem,secrets/**',
    });
  });

  it('--walk-cwd reaches the env var PathGuard actually reads', () => {
    // Guards the half-wired flag: --walk-cwd set allowCwd but never enabled the
    // project-root walk, which recomputeAllowedDirectories gates on ALLOW_CWD_WALK.
    assert.equal(lift(['--walk-cwd'])['ALLOW_CWD_WALK'], '1');
  });

  it('--allow-missing-roots reaches the env var FS_ALLOWED_DIRS validation reads', () => {
    assert.equal(lift(['--allow-missing-roots'])['ALLOW_MISSING_ROOTS'], '1');
  });
});

describe('liftFlagsToEnv --deny layering', () => {
  it('extends an existing DENYLIST rather than replacing it', () => {
    const env: NodeJS.ProcessEnv = { DENYLIST: '*.env' };
    liftFlagsToEnv(['--deny', '*.pem'], env);
    assert.equal(env['DENYLIST'], '*.env,*.pem');
  });

  it('is idempotent — lifting the same argv twice does not duplicate entries', () => {
    // Every other flag here overwrites, so a repeated lift is a no-op. Append
    // without dedup would grow the denylist on each call.
    const env: NodeJS.ProcessEnv = {};
    liftFlagsToEnv(['--deny', '*.pem', '--deny', 'secrets/**'], env);
    liftFlagsToEnv(['--deny', '*.pem', '--deny', 'secrets/**'], env);
    assert.equal(env['DENYLIST'], '*.pem,secrets/**');
  });
});

describe('liftFlagsToEnv edge cases', () => {
  it('leaves env untouched when no flags are passed', () => {
    assert.deepEqual(lift(['/some/dir', '--allow-cwd', '--port', '3000']), {});
  });

  it('does not clobber a pre-set env var when the flag is absent', () => {
    const env: NodeJS.ProcessEnv = { API_KEY: 'from-environment' };
    liftFlagsToEnv(['--allow-cwd'], env);
    assert.equal(env['API_KEY'], 'from-environment');
  });

  it('lets the flag win over a pre-set env var', () => {
    const env: NodeJS.ProcessEnv = { API_KEY: 'from-environment' };
    liftFlagsToEnv(['--api-key', 'from-flag'], env);
    assert.equal(env['API_KEY'], 'from-flag');
  });

  it('accepts the --flag=value form', () => {
    assert.equal(lift(['--http-host=127.0.0.1'])['HTTP_HOST'], '127.0.0.1');
  });

  it('ignores unknown flags and subcommands rather than throwing', () => {
    assert.deepEqual(lift(['config', 'set', 'key', 'value', '--not-a-real-flag']), {});
  });

  it('omits ALLOW_SENSITIVE unless the flag is present', () => {
    assert.equal(lift(['--api-key', 'x'])['ALLOW_SENSITIVE'], undefined);
  });
});
