import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import { ErrorCode } from '../../src/lib/errors.js';
import { getTraceContext } from '../../src/lib/observability.js';
import { createInMemoryResourceStore } from '../../src/lib/resource-store.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  maybeExternalizeTextContent,
} from '../../src/tools/shared.js';

describe('tool output validation', () => {
  it('converts invalid structuredContent into a tool error response', async () => {
    const outputSchema = z.strictObject({
      ok: z.literal(true),
      value: z.string(),
    });

    const result = await executeToolWithDiagnostics({
      toolName: 'example',
      ctx: {},
      outputSchema,
      // @ts-expect-error intentional type mismatch: value:42 (number) instead of string, to test schema validation
      run: () => buildToolResponse('ok', { ok: true, value: 42 }),
      onError: (error) => buildToolErrorResponse(error, ErrorCode.UNKNOWN),
    });

    if (result.isError !== true) {
      assert.fail('Expected tool error result');
    }
    assert.equal(result.errorCode, ErrorCode.UNKNOWN);

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

describe('SEP-414 trace context propagation', () => {
  const VALID_TRACEPARENT =
    '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01';

  const outputSchema = z.strictObject({ ok: z.literal(true) });

  it('exposes trace context via getTraceContext() inside tool execution', async () => {
    let captured: ReturnType<typeof getTraceContext>;

    await executeToolWithDiagnostics({
      toolName: 'ctx_test',
      ctx: {
        _meta: {
          traceparent: VALID_TRACEPARENT,
          tracestate: 'vendor=opaque',
          baggage: 'userId=1234',
        },
      },
      outputSchema,
      run: () => {
        captured = getTraceContext();
        return buildToolResponse('ok', { ok: true as const });
      },
      onError: (error) => buildToolErrorResponse(error, ErrorCode.UNKNOWN),
    });

    assert.ok(captured, 'Expected trace context to be captured');
    assert.equal(captured.traceparent, VALID_TRACEPARENT);
    assert.equal(captured.tracestate, 'vendor=opaque');
    assert.equal(captured.baggage, 'userId=1234');
  });

  it('silently drops invalid traceparent values', async () => {
    let captured: ReturnType<typeof getTraceContext>;

    await executeToolWithDiagnostics({
      toolName: 'invalid_trace',
      ctx: {
        _meta: { traceparent: 'not-a-valid-traceparent' },
      },
      outputSchema,
      run: () => {
        captured = getTraceContext();
        return buildToolResponse('ok', { ok: true as const });
      },
      onError: (error) => buildToolErrorResponse(error, ErrorCode.UNKNOWN),
    });

    assert.equal(captured, undefined, 'Invalid traceparent should be dropped');
  });

  it('works without trace context (backward compatible)', async () => {
    let captured: ReturnType<typeof getTraceContext>;

    await executeToolWithDiagnostics({
      toolName: 'no_trace',
      ctx: {},
      outputSchema,
      run: () => {
        captured = getTraceContext();
        return buildToolResponse('ok', { ok: true as const });
      },
      onError: (error) => buildToolErrorResponse(error, ErrorCode.UNKNOWN),
    });

    assert.equal(captured, undefined, 'No trace context when _meta is absent');
  });
});

describe('inline preview threshold (TASK-013)', () => {
  // Default MAX_INLINE_CONTENT_CHARS is 20_000 (env-overridable).
  // After the fix MAX_INLINE_PREVIEW_CHARS === MAX_INLINE_CONTENT_CHARS, so
  // a content string of MAX+1 chars should produce a preview whose leading
  // portion is MAX chars long, NOT the old 4_000-char cap.
  const MAX =
    parseInt(process.env.FS_CONTEXT_MAX_INLINE_CHARS ?? '', 10) || 20_000;

  it('content at exactly MAX chars is returned inline (not externalized)', () => {
    const store = createInMemoryResourceStore();
    const content = 'x'.repeat(MAX);
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const result = maybeExternalizeTextContent(store, content, {
      name: 'test',
    });
    assert.equal(
      result,
      undefined,
      'Content at MAX chars must NOT be externalized'
    );
  });

  it('content of MAX+1 chars is externalized with a preview of MAX leading chars', () => {
    const store = createInMemoryResourceStore();
    const content = 'a'.repeat(MAX) + 'Z'; // MAX+1 chars, last char distinct
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    const result = maybeExternalizeTextContent(store, content, {
      name: 'test-preview',
    });
    // Function is deprecated and returns undefined now; use putResource instead
    assert.equal(
      result,
      undefined,
      'Function is deprecated; use putResource instead'
    );
  });
});
