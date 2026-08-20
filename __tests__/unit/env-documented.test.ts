import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { ENV_HELP } from '../../src/cli.js';

/** Read by the test harness, not by an operator. */
const NOT_OPERATOR_FACING = new Set(['NODE_ENV']);

const DIRECT = /process\.env\['([A-Za-z0-9_]+)'\]/g;
const HELPER = /parseEnv(?:Int|DirList)\(\s*'([A-Za-z0-9_]+)'/g;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (entry.name.endsWith('.ts')) out.push(full);
  }
  return out;
}

test('every environment variable read by src/ has a --help row', async () => {
  // Resolve src/ from this test file so the walk is not cwd-dependent: a bare
  // `walk('src')` returns [] from elsewhere and the assertion passes vacuously.
  const srcDir = join(import.meta.dirname, '..', '..', 'src');
  const found = new Set<string>();
  for (const file of await walk(srcDir)) {
    const source = await readFile(file, 'utf-8');
    for (const [, name] of source.matchAll(DIRECT)) found.add(name);
    for (const [, name] of source.matchAll(HELPER)) found.add(name);
  }

  const documented = new Set(ENV_HELP.map((row) => row.flags));
  const undocumented = [...found]
    .filter((name) => !NOT_OPERATOR_FACING.has(name) && !documented.has(name))
    .sort();

  assert.deepEqual(
    undocumented,
    [],
    `Add a row to ENV_HELP in src/cli.ts for: ${undocumented.join(', ')}`,
  );
});

test('every ENV_HELP row is documented in the README env table', async () => {
  const readme = await readFile(join(import.meta.dirname, '..', '..', 'README.md'), 'utf-8');
  const missing = ENV_HELP.map((row) => row.flags)
    .filter((name) => !readme.includes(`\`${name}\``))
    .sort();
  assert.deepEqual(
    missing,
    [],
    `Add these env vars to the README "Environment variables" table: ${missing.join(', ')}`,
  );
});
