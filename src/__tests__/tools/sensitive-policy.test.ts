import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, beforeEach, it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import { isSensitivePath } from '../../lib/path-policy.js';
import { withAllToolsFixture } from '../shared/diagnostics-env.js';

type EnvKey =
  | 'FS_CONTEXT_ALLOW_SENSITIVE'
  | 'FS_CONTEXT_ALLOWLIST'
  | 'FS_CONTEXT_DENYLIST';

function clearSensitiveEnv(): void {
  delete process.env.FS_CONTEXT_ALLOW_SENSITIVE;
  delete process.env.FS_CONTEXT_ALLOWLIST;
  delete process.env.FS_CONTEXT_DENYLIST;
}

function restoreEnv(key: EnvKey, value: string | undefined): void {
  switch (key) {
    case 'FS_CONTEXT_ALLOW_SENSITIVE':
      if (value === undefined) {
        delete process.env.FS_CONTEXT_ALLOW_SENSITIVE;
      } else {
        process.env.FS_CONTEXT_ALLOW_SENSITIVE = value;
      }
      break;
    case 'FS_CONTEXT_ALLOWLIST':
      if (value === undefined) {
        delete process.env.FS_CONTEXT_ALLOWLIST;
      } else {
        process.env.FS_CONTEXT_ALLOWLIST = value;
      }
      break;
    case 'FS_CONTEXT_DENYLIST':
      if (value === undefined) {
        delete process.env.FS_CONTEXT_DENYLIST;
      } else {
        process.env.FS_CONTEXT_DENYLIST = value;
      }
      break;
  }
}

withAllToolsFixture((getHandler, getTestDir) => {
  const previous = {
    allowSensitive: process.env.FS_CONTEXT_ALLOW_SENSITIVE,
    allowlist: process.env.FS_CONTEXT_ALLOWLIST,
    denylist: process.env.FS_CONTEXT_DENYLIST,
  };

  beforeEach(() => {
    clearSensitiveEnv();
  });

  afterEach(() => {
    restoreEnv('FS_CONTEXT_ALLOW_SENSITIVE', previous.allowSensitive);
    restoreEnv('FS_CONTEXT_ALLOWLIST', previous.allowlist);
    restoreEnv('FS_CONTEXT_DENYLIST', previous.denylist);
  });

  void it('filters sensitive entries from ls/find/tree and blocks stat', async () => {
    if (!isSensitivePath('id_rsa_test')) {
      return;
    }
    const root = getTestDir();
    await fs.writeFile(path.join(root, '.env'), 'SECRET=1');
    await fs.mkdir(path.join(root, '.aws'), { recursive: true });
    await fs.writeFile(path.join(root, '.aws', 'credentials'), 'token=abc');
    await fs.writeFile(path.join(root, 'id_rsa_test'), 'PRIVATE KEY');

    const ls = getHandler('ls');
    const lsResult = (await ls({}, {})) as {
      structuredContent?: { entries?: { name?: string }[] };
    };
    const lsNames =
      lsResult.structuredContent?.entries?.map((entry) => entry.name) ?? [];
    assert.ok(!lsNames.includes('id_rsa_test'));

    const find = getHandler('find');
    const findResult = (await find(
      { path: root, pattern: '*id_rsa*', includeIgnored: true },
      {}
    )) as { structuredContent?: { results?: { path?: string }[] } };
    const findPaths =
      findResult.structuredContent?.results?.map((entry) => entry.path) ?? [];
    assert.deepStrictEqual(findPaths, []);

    const tree = getHandler('tree');
    const treeResult = (await tree(
      { path: root, includeHidden: true, includeIgnored: true },
      {}
    )) as { structuredContent?: { ascii?: string } };
    const ascii = treeResult.structuredContent?.ascii;
    assert.ok(ascii);
    assert.ok(!ascii.includes('id_rsa_test'));

    const stat = getHandler('stat');
    const statResult = (await stat(
      { path: path.join(root, 'id_rsa_test') },
      {}
    )) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };
    assert.strictEqual(statResult.isError, true);
    assert.match(statResult.content[0]?.text ?? '', /\[E_ACCESS_DENIED\]/u);
  });
});
