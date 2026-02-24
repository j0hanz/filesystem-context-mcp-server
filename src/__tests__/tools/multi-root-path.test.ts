import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { afterEach, it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import {
  getAllowedDirectories,
  setAllowedDirectoriesResolved,
} from '../../lib/path-validation.js';
import { registerListDirectoryTool } from '../../tools/list-directory.js';
import { registerReadFileTool } from '../../tools/read.js';
import { createSingleToolCapture } from '../shared/diagnostics-env.js';

const createdDirs: string[] = [];
const originalAllowed = getAllowedDirectories();

async function createTempDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await setAllowedDirectoriesResolved(originalAllowed);
  await Promise.all(
    createdDirs
      .splice(0)
      .map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
});

await it('ls requires explicit path when multiple roots are configured', async () => {
  const dir1 = await createTempDir('mcp-root-1-');
  const dir2 = await createTempDir('mcp-root-2-');
  await setAllowedDirectoriesResolved([dir1, dir2]);

  const { fakeServer, getHandler } = createSingleToolCapture();
  registerListDirectoryTool(fakeServer);
  const handler = getHandler();

  const result = (await handler({}, {})) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /\[E_INVALID_INPUT\]/u);
});

await it('relative paths are rejected when multiple roots are configured', async () => {
  const dir1 = await createTempDir('mcp-root-1-');
  const dir2 = await createTempDir('mcp-root-2-');
  const filePath = path.join(dir1, 'example.txt');
  await fs.writeFile(filePath, 'hello');
  await setAllowedDirectoriesResolved([dir1, dir2]);

  const { fakeServer, getHandler } = createSingleToolCapture();
  registerReadFileTool(fakeServer);
  const handler = getHandler();

  const result = (await handler({ path: 'example.txt' }, {})) as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };

  assert.strictEqual(result.isError, true);
  assert.match(result.content[0]?.text ?? '', /\[E_INVALID_INPUT\]/u);
});
