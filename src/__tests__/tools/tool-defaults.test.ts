import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import {
  getAllowedDirectories,
  setAllowedDirectoriesResolved,
} from '../../lib/path-validation.js';
import {
  ListDirectoryInputSchema,
  SearchContentInputSchema,
  SearchFilesInputSchema,
} from '../../schemas.js';
import { registerListDirectoryTool } from '../../tools/list-directory.js';
import { createSingleToolCapture } from '../shared/diagnostics-env.js';

void it('grep includes includeHidden=false by default', () => {
  const parsed = SearchContentInputSchema.parse({ pattern: 'console.log' });
  assert.strictEqual(parsed.includeHidden, false);
  assert.strictEqual(parsed.includeIgnored, false);
  assert.strictEqual(parsed.caseSensitive, false);
  assert.strictEqual(parsed.wholeWord, false);
  assert.strictEqual(parsed.contextLines, 0);
  assert.strictEqual(parsed.maxResults, 500);
  assert.strictEqual(parsed.filePattern, '**/*');
});

void it('grep rejects unknown parameters', () => {
  assert.throws(
    () => SearchContentInputSchema.parse({ pattern: 'x', isLiteral: false }),
    /Unrecognized key/i
  );
});

void it('find includes includeIgnored=false by default', () => {
  const parsed = SearchFilesInputSchema.parse({ pattern: '**/*.ts' });
  assert.strictEqual(parsed.includeIgnored, false);
  assert.strictEqual(parsed.includeHidden, false);
  assert.strictEqual(parsed.sortBy, 'path');
});

void it('ls includes includeHidden=false by default', () => {
  const parsed = ListDirectoryInputSchema.parse({});
  assert.strictEqual(parsed.includeHidden, false);
  assert.strictEqual(parsed.sortBy, 'name');
  assert.strictEqual(parsed.includeSymlinkTargets, false);
});

void it('ls includes includeIgnored=false by default', () => {
  const parsed = ListDirectoryInputSchema.parse({});
  assert.strictEqual(parsed.includeIgnored, false);
});

void it('ls rejects unknown parameters', () => {
  assert.throws(
    () => ListDirectoryInputSchema.parse({ unknownField: true }),
    /Unrecognized key/i
  );
});

await it('ls returns E_ACCESS_DENIED when no roots configured', async () => {
  const previousAllowed = getAllowedDirectories();
  await setAllowedDirectoriesResolved([]);

  try {
    const { fakeServer, getHandler } = createSingleToolCapture();
    registerListDirectoryTool(fakeServer);
    const handler = getHandler();

    const result = (await handler({}, {})) as {
      isError?: unknown;
      content: Array<{ text?: string }>;
    };

    assert.strictEqual(result.isError, true);
    assert.match(result.content[0]?.text ?? '', /\[E_ACCESS_DENIED\]/u);
  } finally {
    await setAllowedDirectoriesResolved(previousAllowed);
  }
});
