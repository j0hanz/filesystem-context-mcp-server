import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import { registerListDirectoryTool } from '../../tools/list-directory.js';
import { createSingleToolCapture } from '../shared/diagnostics-env.js';

void it('rejects tool calls before notifications/initialized', async () => {
  const { fakeServer, getHandler } = createSingleToolCapture();
  registerListDirectoryTool(fakeServer, { isInitialized: () => false });

  const handler = getHandler();
  const result = await handler({});

  const typed = result as {
    isError?: boolean;
    content: Array<{ text?: string }>;
  };

  assert.strictEqual(typed.isError, true);
  const errorText = typed.content[0]?.text ?? '';
  assert.match(errorText, /\[E_INVALID_INPUT\]/u);
  assert.match(errorText, /notifications\/initialized/i);
});
