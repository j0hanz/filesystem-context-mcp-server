import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod';

import { ErrorCode } from '../../lib/errors.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
} from '../../tools/shared.js';

describe('tool output validation', () => {
  it('converts invalid structuredContent into a tool error response', async () => {
    const outputSchema = z.strictObject({
      ok: z.literal(true),
      value: z.string(),
    });

    const result = await executeToolWithDiagnostics({
      toolName: 'example',
      extra: {},
      outputSchema,
      run: () =>
        buildToolResponse('ok', { ok: true, value: 42 } as unknown as z.infer<
          typeof outputSchema
        >),
      onError: (error) => buildToolErrorResponse(error, ErrorCode.E_UNKNOWN),
    });

    if (result.isError !== true) {
      assert.fail('Expected tool error result');
    }
    assert.equal(result.errorCode, ErrorCode.E_UNKNOWN);

    const first = result.content[0];
    assert.ok(
      first?.type === 'text' && typeof first.text === 'string',
      'Expected a text error block'
    );
    assert.match(
      first.text,
      /returned invalid structuredContent/u,
      'Expected invalid structuredContent message'
    );
  });
});
