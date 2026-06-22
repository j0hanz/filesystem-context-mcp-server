import assert from 'node:assert/strict';
import { channel } from 'node:diagnostics_channel';
import test from 'node:test';

import {
  emitWideEvent,
  formatTransportError,
  logRuntimeFailure,
  toLogfmt,
} from '../../src/core/observability.js';

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
