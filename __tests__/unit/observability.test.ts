import assert from 'node:assert/strict';
import { channel, tracingChannel } from 'node:diagnostics_channel';
import process from 'node:process';
import test, { before } from 'node:test';

import {
  emitWideEvent,
  logRuntimeFailure,
  startPerfMeasure,
  withOpsTrace,
  withToolDiagnostics,
} from '../../src/core/observability.js';

before(() => {
  process.env.FS_CONTEXT_DIAGNOSTICS = '1';
});

test('tool context flows into ops trace events', async () => {
  const opsChannel = tracingChannel('filesystem-mcp:ops');
  let startEvent: Record<string, unknown> | undefined;
  opsChannel.start.subscribe((msg: unknown) => {
    startEvent = msg as Record<string, unknown>;
  });

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
  toolChannel.subscribe((msg: unknown) => {
    lastEvent = msg as Record<string, unknown>;
  });

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
});

test('withOpsTrace emits start, end, and error events', async () => {
  const opsChannel = tracingChannel('filesystem-mcp:ops');

  let startEvent: Record<string, unknown> | undefined;
  let endEvent: Record<string, unknown> | undefined;
  let errEvent: Record<string, unknown> | undefined;

  opsChannel.start.subscribe((msg: unknown) => {
    startEvent = msg as Record<string, unknown>;
  });
  opsChannel.end.subscribe((msg: unknown) => {
    endEvent = msg as Record<string, unknown>;
  });
  opsChannel.error.subscribe((msg: unknown) => {
    errEvent = msg as Record<string, unknown>;
  });

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
});

test('emitWideEvent emits canonical JSON with environment metadata', () => {
  const logChannel = channel('filesystem-mcp:log');
  let lastEvent: { message?: string; level?: string } | undefined;

  logChannel.subscribe((msg: unknown) => {
    lastEvent = msg as { message?: string; level?: string };
  });

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
  // Note: static context (service, runtime, etc.) is omitted from logfmt emission
});

test('logRuntimeFailure emits a wide event with error details', () => {
  const logChannel = channel('filesystem-mcp:log');
  let lastEvent: { message?: string; level?: string } | undefined;

  logChannel.subscribe((msg: unknown) => {
    lastEvent = msg as { message?: string; level?: string };
  });

  logRuntimeFailure('fatal', 'startup', 'parseArgs', new Error('boom'));

  assert.equal(lastEvent?.level, 'error');
  const msg = lastEvent?.message ?? '';
  assert.ok(msg.includes('event=runtime_failure'));
  assert.ok(msg.includes('reason=fatal'));
  assert.ok(msg.includes('scope=startup'));
  assert.ok(msg.includes('operation=parseArgs'));
  assert.ok(msg.includes('error_message=boom'));
});
