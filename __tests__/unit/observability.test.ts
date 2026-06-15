import assert from 'node:assert/strict';
import { channel, tracingChannel } from 'node:diagnostics_channel';
import process from 'node:process';
import test, { before } from 'node:test';

import {
  emitWideEvent,
  extractOutcome,
  formatTransportError,
  logRuntimeFailure,
  sanitizePathForDiagnostics,
  startPerfMeasure,
  toLogfmt,
  withOpsTrace,
  withToolDiagnostics,
} from '../../src/core/observability.js';

before(() => {
  process.env.FS_CONTEXT_DIAGNOSTICS = '1';
});

test('tool context flows into ops trace events', async () => {
  const opsChannel = tracingChannel('filesystem-mcp:ops');
  let startEvent: Record<string, unknown> | undefined;
  const sub = (msg: unknown) => {
    startEvent = msg as Record<string, unknown>;
  };
  opsChannel.start.subscribe(sub);

  try {
    await withToolDiagnostics('test-tool', async () => {
      const consume = async () => {
        for await (const _ of withOpsTrace({ op: 'inner-op' }, async function* () {
          yield 1;
        })) {
          // drain
        }
      };
      await consume();
    });

    assert.equal(startEvent?.tool, 'test-tool');
    assert.equal(startEvent?.op, 'inner-op');
  } finally {
    opsChannel.start.unsubscribe(sub);
  }
});

test('startPerfMeasure does not crash without subscribers', () => {
  const finish = startPerfMeasure('test-measure', { some: 'detail' });
  if (finish) finish(true);
});

test('withToolDiagnostics returns correct value and catches errors', async () => {
  const res = await withToolDiagnostics('test-tool', async () => 'success');
  assert.equal(res, 'success');

  await assert.rejects(
    () =>
      withToolDiagnostics('test-tool', async () => {
        throw new Error('fail');
      }),
    /fail/,
  );
});

test('extracts error from structured outcome', async () => {
  const toolChannel = channel('filesystem-mcp:tool');
  let lastEvent: Record<string, unknown> | undefined;
  const sub = (msg: unknown) => {
    lastEvent = msg as Record<string, unknown>;
  };
  toolChannel.subscribe(sub);

  try {
    await withToolDiagnostics('test-tool', async () => {
      return { ok: false, error: 'test error' };
    });

    assert.equal(lastEvent?.ok, false);
    assert.equal(lastEvent?.error, 'test error');

    await withToolDiagnostics('test-tool', async () => {
      return {
        structuredContent: { ok: false, error: { message: 'nested error' } },
      };
    });

    assert.equal(lastEvent?.ok, false);
    assert.equal(lastEvent?.error, 'nested error');

    // MCP error response shape (what ToolExecutor.failProgress actually returns)
    await withToolDiagnostics('test-tool', async () => {
      return { isError: true, content: [{ type: 'text', text: 'content error message' }] };
    });

    assert.equal(lastEvent?.ok, false);
    assert.equal(lastEvent?.error, 'content error message');

    await withToolDiagnostics('test-tool', async () => {
      return {
        isError: true,
        structuredContent: { error: { message: 'struct isError msg' } },
      };
    });

    assert.equal(lastEvent?.ok, false);
    assert.equal(lastEvent?.error, 'struct isError msg');
  } finally {
    toolChannel.unsubscribe(sub);
  }
});

test('withOpsTrace emits start, end, and error events', async () => {
  const opsChannel = tracingChannel('filesystem-mcp:ops');

  let startEvent: Record<string, unknown> | undefined;
  let endEvent: Record<string, unknown> | undefined;
  let errEvent: Record<string, unknown> | undefined;

  const subStart = (msg: unknown) => {
    startEvent = msg as Record<string, unknown>;
  };
  const subEnd = (msg: unknown) => {
    endEvent = msg as Record<string, unknown>;
  };
  const subErr = (msg: unknown) => {
    errEvent = msg as Record<string, unknown>;
  };

  opsChannel.start.subscribe(subStart);
  opsChannel.end.subscribe(subEnd);
  opsChannel.error.subscribe(subErr);

  try {
    for await (const _ of withOpsTrace({ op: 'happy' }, async function* () {
      yield 1;
      yield 2;
    })) {
      // drain
    }

    assert.equal(startEvent?.op, 'happy');
    assert.equal(endEvent?.op, 'happy');
    assert.equal(errEvent, undefined);

    await assert.rejects(
      (async () => {
        for await (const _ of withOpsTrace({ op: 'sad' }, async function* () {
          yield 1;
          throw new Error('boom');
        })) {
          // drain
        }
      })(),
      /boom/,
    );

    assert.equal(errEvent?.op, 'sad');
    assert.equal((errEvent?.error as Error).message, 'boom');
  } finally {
    opsChannel.start.unsubscribe(subStart);
    opsChannel.end.unsubscribe(subEnd);
    opsChannel.error.unsubscribe(subErr);
  }
});

test('emitWideEvent emits canonical JSON with environment metadata', () => {
  const logChannel = channel('filesystem-mcp:log');
  let lastEvent: { message?: string; level?: string } | undefined;

  const sub = (msg: unknown) => {
    lastEvent = msg as { message?: string; level?: string };
  };
  logChannel.subscribe(sub);

  try {
    emitWideEvent('info', {
      event: 'http_request_complete',
      transport: 'http',
      outcome: 'success',
      duration_ms: 12,
      session_id: 's-123',
      http_status: 200,
    });

    assert.equal(lastEvent?.level, 'info');
    const msg = lastEvent?.message ?? '';
    assert.ok(msg.includes('event=http_request_complete'));
    assert.ok(msg.includes('transport=http'));
    assert.ok(msg.includes('outcome=success'));
    assert.ok(msg.includes('session_id=s-123'));
    assert.ok(msg.includes('http_status=200'));
    assert.ok(msg.includes('timestamp='));
  } finally {
    logChannel.unsubscribe(sub);
  }
});

test('logRuntimeFailure emits a wide event with error details', () => {
  const logChannel = channel('filesystem-mcp:log');
  let lastEvent: { message?: string; level?: string } | undefined;

  const sub = (msg: unknown) => {
    lastEvent = msg as { message?: string; level?: string };
  };
  logChannel.subscribe(sub);

  try {
    logRuntimeFailure('fatal', 'startup', 'parseArgs', new Error('boom'));

    assert.equal(lastEvent?.level, 'error');
    const msg = lastEvent?.message ?? '';
    assert.ok(msg.includes('event=runtime_failure'));
    assert.ok(msg.includes('reason=fatal'));
    assert.ok(msg.includes('scope=startup'));
    assert.ok(msg.includes('operation=parseArgs'));
    assert.ok(msg.includes('error_message=') && msg.includes('boom'));
  } finally {
    logChannel.unsubscribe(sub);
  }
});

test('formatTransportError handles circular structures and stack traces', () => {
  const circular: { self?: unknown } = {};
  circular.self = circular;
  const res = formatTransportError(circular);
  assert.ok(res.includes('self'));

  const err = new Error('boom');
  const resErr = formatTransportError(err);
  assert.ok(resErr.includes('boom'));
  assert.ok(resErr.includes('Error: boom'));
});

test('extractOutcome handles Error objects and JSON-RPC errors', () => {
  const resErr = extractOutcome(new Error('direct error'));
  assert.deepEqual(resErr, { ok: false, error: 'direct error' });

  const resJsonRpc = extractOutcome({ error: { message: 'jsonrpc error' } });
  assert.deepEqual(resJsonRpc, { ok: false, error: 'jsonrpc error' });

  const resSuccess = extractOutcome({ ok: true });
  assert.deepEqual(resSuccess, { ok: true });
});

test('toLogfmt serializes bigints, errors, and escapes key names', () => {
  const err = new Error('error message');
  const res = toLogfmt({
    'my key': 'val',
    big: 100n,
    err: err,
  });
  assert.ok(res.includes('"my key"'));
  assert.ok(res.includes('big=100'));
  assert.ok(res.includes('err='));
  assert.ok(res.includes('error message'));
});

test('sanitizePathForDiagnostics checks non-string paths', () => {
  const res = sanitizePathForDiagnostics({} as unknown as string);
  assert.equal(res, undefined);
});
