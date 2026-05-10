import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { z } from 'zod/v4';

import { ErrorCode } from '../../src/core/errors.js';
import { getTraceContext } from '../../src/core/observability.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';
import {
  buildToolErrorResponse,
  buildToolResponse,
  executeToolWithDiagnostics,
  putResource,
} from '../../src/tools/_helpers.js';
import { readResourceLink } from '../helpers.js';

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
      'Expected a text error block',
    );
    assert.match(
      first.text,
      /returned invalid structuredContent/u,
      'Expected invalid structuredContent message',
    );
  });
});

describe('SEP-414 trace context propagation', () => {
  const VALID_TRACEPARENT = '00-0af7651916cd43dd8448eb211c80319c-00f067aa0ba902b7-01';

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

describe('readResourceLink helper', () => {
  it('fetches text resource from store', async () => {
    const store = createInMemoryResourceStore();
    const { link } = putResource({
      store,
      name: 'test.txt',
      mimeType: 'text/plain',
      kind: 'text',
      content: 'hello world',
    });

    const result = await readResourceLink(store, {
      content: [link],
    });

    assert.equal(result?.text, 'hello world');
    assert.equal(result?.mimeType, 'text/plain');
    assert.equal(result?.size, 11);
    assert.equal(result?.blob, undefined);
  });

  it('fetches blob resource from store', async () => {
    const store = createInMemoryResourceStore();
    const testData = Buffer.from('binary data');
    const { link } = putResource({
      store,
      name: 'test.bin',
      mimeType: 'application/octet-stream',
      kind: 'blob',
      content: testData,
    });

    const result = await readResourceLink(store, {
      content: [link],
    });

    assert.deepEqual(result?.blob, testData);
    assert.equal(result?.mimeType, 'application/octet-stream');
    assert.equal(result?.size, testData.length);
    assert.equal(result?.text, undefined);
  });

  it('returns null when no resource_link found', async () => {
    const store = createInMemoryResourceStore();
    const result = await readResourceLink(store, {
      content: [{ type: 'text', text: 'some text' }],
    });

    assert.equal(result, null);
  });

  it('returns null when result has no content', async () => {
    const store = createInMemoryResourceStore();
    const result = await readResourceLink(store, {});

    assert.equal(result, null);
  });

  it('returns null when resource_link uri is not found in store', async () => {
    const store = createInMemoryResourceStore();
    const result = await readResourceLink(store, {
      content: [{ type: 'resource_link', uri: 'filesystem-mcp://resource/notfound' }],
    });

    assert.equal(result, null);
  });
});
