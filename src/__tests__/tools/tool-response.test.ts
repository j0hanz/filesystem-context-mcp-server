import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ErrorCode } from '../../lib/errors.js';
import { buildToolErrorResponse, buildToolResponse } from '../../tools.js';

void it('buildToolResponse returns human text in content and structuredContent', () => {
  const structured = { ok: true, value: 123 };
  const result = buildToolResponse('human text', structured);

  assert.strictEqual(result.content.length, 1);
  const textContent = result.content[0];
  assert.ok(textContent);
  assert.strictEqual((textContent as { text: string }).text, 'human text');
  assert.deepStrictEqual(result.structuredContent, structured);
});

void it('buildToolErrorResponse returns error text in content, isError flag, and no structuredContent', () => {
  const result = buildToolErrorResponse(
    new Error('boom'),
    ErrorCode.E_UNKNOWN,
    '/path'
  );

  assert.strictEqual(result.isError, true);
  assert.ok(result.content.length >= 1);

  const textContent = result.content[0];
  assert.ok(textContent);
  assert.ok(typeof (textContent as { text: string }).text === 'string');

  // Error responses must NOT include structuredContent (MCP SDK contract).
  assert.strictEqual(
    Object.hasOwn(result, 'structuredContent'),
    false,
    'Error responses must not include structuredContent'
  );
});
