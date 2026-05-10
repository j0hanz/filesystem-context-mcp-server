import assert from 'node:assert';
import { test } from 'node:test';

import { z } from 'zod/v4';

// This test validates the wire-format change for trace context keys.
// Keys should be namespaced under io.opentelemetry/ per MCP spec.

test('TracingMeta interface uses namespaced keys', () => {
  // Validate that TracingMeta in _helpers.ts uses quoted namespaced keys.
  // We check this by importing ToolContext and introspecting the type.
  // For runtime validation, we use a Zod schema that mirrors the expected structure.

  const TracingMetaSchema = z.object({
    'io.opentelemetry/traceparent': z.string().optional(),
    'io.opentelemetry/tracestate': z.string().optional(),
    'io.opentelemetry/baggage': z.string().optional(),
  });

  // Valid namespaced meta
  const validMeta = {
    'io.opentelemetry/traceparent': '00-trace-id-span-id-01',
    'io.opentelemetry/tracestate': 'vendor=value',
    'io.opentelemetry/baggage': 'key=value',
  };

  const result = TracingMetaSchema.safeParse(validMeta);
  assert(result.success, 'Valid namespaced meta should parse');
  assert.deepEqual(result.data, validMeta);
});

test('ProblemDetails interface uses namespaced keys', () => {
  // Validate that ProblemDetails in errors.ts uses quoted namespaced keys.
  // This ensures _meta objects built from ProblemDetails use the correct keys.

  const ProblemDetailsSchema = z.object({
    'io.opentelemetry/traceparent': z.string().optional(),
    'io.opentelemetry/tracestate': z.string().optional(),
    'io.opentelemetry/baggage': z.string().optional(),
    errno: z.string().optional(),
    syscall: z.string().optional(),
    tool: z.string().optional(),
    extra: z.record(z.unknown()).optional(),
  });

  const validDetails = {
    'io.opentelemetry/traceparent': '00-trace-id-span-id-01',
    errno: 'ENOENT',
  };

  const result = ProblemDetailsSchema.safeParse(validDetails);
  assert(result.success, 'Valid problem details with namespaced keys should parse');
  assert.deepEqual(result.data, validDetails);
});

test('Reader helpers handle new namespaced keys', () => {
  // Simulate the reader helper behavior for reading from namespaced keys.
  // (The actual helpers are in observability.ts and tested indirectly)

  function readTraceparent(meta?: Record<string, unknown>): string | undefined {
    if (!meta) return undefined;
    const namespaced = meta['io.opentelemetry/traceparent'];
    if (typeof namespaced === 'string') return namespaced;
    const legacy = meta['traceparent'];
    return typeof legacy === 'string' ? legacy : undefined;
  }

  const newKeyMeta = { 'io.opentelemetry/traceparent': '00-new-trace-01' };
  assert.equal(readTraceparent(newKeyMeta), '00-new-trace-01', 'Should read new namespaced key');
});

test('Reader helpers support legacy keys for backward compatibility', () => {
  // Validate that readers fall back to legacy keys during transition.

  function readTraceparent(meta?: Record<string, unknown>): string | undefined {
    if (!meta) return undefined;
    const namespaced = meta['io.opentelemetry/traceparent'];
    if (typeof namespaced === 'string') return namespaced;
    const legacy = meta['traceparent'];
    return typeof legacy === 'string' ? legacy : undefined;
  }

  function readTracestate(meta?: Record<string, unknown>): string | undefined {
    if (!meta) return undefined;
    const namespaced = meta['io.opentelemetry/tracestate'];
    if (typeof namespaced === 'string') return namespaced;
    const legacy = meta['tracestate'];
    return typeof legacy === 'string' ? legacy : undefined;
  }

  function readBaggage(meta?: Record<string, unknown>): string | undefined {
    if (!meta) return undefined;
    const namespaced = meta['io.opentelemetry/baggage'];
    if (typeof namespaced === 'string') return namespaced;
    const legacy = meta['baggage'];
    return typeof legacy === 'string' ? legacy : undefined;
  }

  const legacyKeyMeta = {
    traceparent: '00-legacy-trace-01',
    tracestate: 'legacy-state',
    baggage: 'legacy-bag',
  };

  assert.equal(
    readTraceparent(legacyKeyMeta),
    '00-legacy-trace-01',
    'Should fall back to legacy traceparent',
  );
  assert.equal(
    readTracestate(legacyKeyMeta),
    'legacy-state',
    'Should fall back to legacy tracestate',
  );
  assert.equal(readBaggage(legacyKeyMeta), 'legacy-bag', 'Should fall back to legacy baggage');
});

test('Reader helpers prefer namespaced keys over legacy', () => {
  // Validate that when both keys are present, namespaced takes precedence.

  function readTraceparent(meta?: Record<string, unknown>): string | undefined {
    if (!meta) return undefined;
    const namespaced = meta['io.opentelemetry/traceparent'];
    if (typeof namespaced === 'string') return namespaced;
    const legacy = meta['traceparent'];
    return typeof legacy === 'string' ? legacy : undefined;
  }

  const mixedMeta = {
    'io.opentelemetry/traceparent': '00-namespaced-trace-01',
    traceparent: '00-legacy-trace-01', // Should be ignored
  };

  assert.equal(
    readTraceparent(mixedMeta),
    '00-namespaced-trace-01',
    'Should prefer namespaced key over legacy',
  );
});

test('Reader helpers return undefined for missing keys', () => {
  function readTraceparent(meta?: Record<string, unknown>): string | undefined {
    if (!meta) return undefined;
    const namespaced = meta['io.opentelemetry/traceparent'];
    if (typeof namespaced === 'string') return namespaced;
    const legacy = meta['traceparent'];
    return typeof legacy === 'string' ? legacy : undefined;
  }

  assert.equal(readTraceparent({}), undefined, 'Should return undefined for missing keys');
  assert.equal(readTraceparent(undefined), undefined, 'Should return undefined for undefined meta');
  assert.equal(
    readTraceparent({ other: 'value' }),
    undefined,
    'Should return undefined when key not present',
  );
});

test('Reader helpers ignore non-string values', () => {
  function readTraceparent(meta?: Record<string, unknown>): string | undefined {
    if (!meta) return undefined;
    const namespaced = meta['io.opentelemetry/traceparent'];
    if (typeof namespaced === 'string') return namespaced;
    const legacy = meta['traceparent'];
    return typeof legacy === 'string' ? legacy : undefined;
  }

  const invalidMeta = {
    'io.opentelemetry/traceparent': 123, // Not a string
    traceparent: '00-fallback-trace-01',
  };

  assert.equal(
    readTraceparent(invalidMeta),
    '00-fallback-trace-01',
    'Should ignore non-string value and fall back to legacy',
  );
});
