import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
} from '../../tools/tool-response.js';

void it('buildToolResponse includes JSON content matching structuredContent', () => {
  const structured = { ok: true, value: 123 };
  const result = buildToolResponse('human text', structured);

  assert.ok(result.content.length >= 2);
  const jsonContent = result.content[1];
  assert.ok(jsonContent);
  assert.deepStrictEqual(JSON.parse(jsonContent.text), structured);
  assert.deepStrictEqual(result.structuredContent, structured);
});

void it('buildToolErrorResponse includes JSON content matching structuredContent', () => {
  const result = buildToolErrorResponse(
    new Error('boom'),
    ErrorCode.E_UNKNOWN,
    '/path'
  );

  assert.strictEqual(result.isError, true);
  assert.ok(result.content.length >= 2);

  const jsonContent = result.content[1];
  assert.ok(jsonContent);
  const parsed = JSON.parse(jsonContent.text) as unknown;
  assert.deepStrictEqual(parsed, result.structuredContent);
});
