import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import {
  getAllowedDirectories,
  setAllowedDirectoriesResolved,
} from '../../lib/path-validation.js';
import { registerDeleteFileTool } from '../../tools/delete-file.js';
import { createSingleToolCapture } from '../shared/diagnostics-env.js';

await it('rm deletes empty directories without recursive and rejects non-empty directories clearly', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-mcp-rm-test-'));
  const previousAllowed = getAllowedDirectories();
  await setAllowedDirectoriesResolved([tmpDir]);

  try {
    const emptyDir = path.join(tmpDir, 'empty-dir');
    const nonEmptyDir = path.join(tmpDir, 'non-empty-dir');
    await fs.mkdir(emptyDir, { recursive: true });
    await fs.mkdir(nonEmptyDir, { recursive: true });
    await fs.writeFile(path.join(nonEmptyDir, 'file.txt'), 'content', 'utf-8');

    const { fakeServer, getHandler } = createSingleToolCapture();
    registerDeleteFileTool(fakeServer);
    const handler = getHandler();

    const emptyResult = (await handler(
      { path: emptyDir, recursive: false, ignoreIfNotExists: false },
      {}
    )) as {
      isError?: boolean;
    };

    assert.equal(emptyResult.isError, undefined);
    await assert.rejects(() => fs.stat(emptyDir));

    const nonEmptyResult = (await handler(
      { path: nonEmptyDir, recursive: false, ignoreIfNotExists: false },
      {}
    )) as {
      isError?: boolean;
      content: Array<{ text?: string }>;
    };

    assert.equal(nonEmptyResult.isError, true);
    const nonEmptyText = nonEmptyResult.content[0]?.text ?? '';
    assert.match(nonEmptyText, /\[E_INVALID_INPUT\]/u);

    const stillExists = await fs.stat(nonEmptyDir);
    assert.ok(stillExists.isDirectory());
  } finally {
    await setAllowedDirectoriesResolved(previousAllowed);
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
