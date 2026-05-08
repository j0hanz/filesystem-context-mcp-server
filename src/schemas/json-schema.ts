import { fromJsonSchema } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

type JsonSchema = Record<string, unknown>;

// Nonstandard format values that Zod emits but JSON Schema validators don't know.
// Keeping them when a `pattern` or `contentEncoding` key is also present just
// produces "unknown format" warnings in validators — strip them from the wire.
const NONSTANDARD_FORMATS = new Set(['base64url', 'sha256_hex']);

// Recursively clean up JSON Schema output produced by z.toJSONSchema():
// - Strip `pattern` from `format: "date-time"` nodes (eliminates the 340-char Zod datetime regex)
// - Strip `maximum: Number.MAX_SAFE_INTEGER` from integer nodes (implicit, just noise)
// - Remove fields with `default` from `required` (Zod marks defaulted fields required, but
//   clients omit them legitimately and Zod fills in the default at parse time)
// - Strip nonstandard `format` values when a concrete `pattern` already encodes the constraint
// - Strip `contentEncoding` when a concrete `pattern` already encodes the constraint
function walk(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema))
    return schema;
  const obj = schema as JsonSchema;
  const result: JsonSchema = {};
  for (const [key, value] of Object.entries(obj)) {
    result[key] = walk(value);
  }
  if (result.format === 'date-time' && 'pattern' in result) {
    delete result.pattern;
  }
  if (result.maximum === Number.MAX_SAFE_INTEGER && result.type === 'integer') {
    delete result.maximum;
  }
  // Remove from `required` any property that has a `default` value — it's optional at input.
  if (
    Array.isArray(result.required) &&
    result.properties &&
    typeof result.properties === 'object'
  ) {
    const props = result.properties as Record<string, JsonSchema>;
    const required = (result.required as string[]).filter(
      (name) => !('default' in (props[name] ?? {}))
    );
    if (required.length === 0) {
      delete result.required;
    } else {
      result.required = required;
    }
  }
  // Strip nonstandard formats when a concrete `pattern` already validates the shape.
  if (
    typeof result.format === 'string' &&
    NONSTANDARD_FORMATS.has(result.format) &&
    'pattern' in result
  ) {
    delete result.format;
  }
  // Strip `contentEncoding` when a concrete `pattern` already validates the shape.
  if ('contentEncoding' in result && 'pattern' in result) {
    delete result.contentEncoding;
  }
  return result;
}

// Remove root-level `$schema` key that Zod v4 injects into every top-level conversion.
function stripRootSchema(schema: JsonSchema): JsonSchema {
  if ('$schema' in schema) {
    const { $schema: _removed, ...rest } = schema;
    return rest;
  }
  return schema;
}

// --- Augmentation helpers ---

// Returns allOf items that enforce read-range mutual exclusion constraints.
// head and tail cannot be combined with each other or with startLine/endLine.
// These express the same invariants as validateReadRange() in the wire schema.
export function readRangeConstraints(): JsonSchema[] {
  return [
    // head and tail are mutually exclusive
    { not: { required: ['head', 'tail'] } },
    // tail cannot be combined with startLine or endLine
    { not: { required: ['tail', 'startLine'] } },
    { not: { required: ['tail', 'endLine'] } },
    // head cannot be combined with startLine or endLine
    { not: { required: ['head', 'startLine'] } },
    { not: { required: ['head', 'endLine'] } },
    // byte range is mutually exclusive with all line params
    { not: { required: ['offset', 'head'] } },
    { not: { required: ['offset', 'tail'] } },
    { not: { required: ['offset', 'startLine'] } },
    { not: { required: ['offset', 'endLine'] } },
    { not: { required: ['length', 'head'] } },
    { not: { required: ['length', 'tail'] } },
    { not: { required: ['length', 'startLine'] } },
    { not: { required: ['length', 'endLine'] } },
  ];
}

// Returns an allOf entry that rejects absolute paths and traversal patterns in
// the named optional glob property. Uses if/required so the constraint only
// fires when the property is actually present in the input.
export function safeGlobConstraint(propertyName: string): JsonSchema {
  return {
    if: { required: [propertyName] },
    then: {
      properties: {
        [propertyName]: {
          not: {
            anyOf: [
              // Absolute POSIX paths
              { pattern: '^/' },
              // Windows absolute paths (drive letter)
              { pattern: '^[A-Za-z]:' },
              // Traversal sequences
              { pattern: '\\.\\.' },
            ],
          },
        },
      },
    },
  };
}

// Convert a Zod schema to a Standard Schema suitable for MCP tool registration.
// Applies the walk cleanup and strips the root $schema key.
// Pass an optional `augment` function to inject JSON Schema constructs
// (e.g. `allOf` oneOf constraints) that Zod can't express natively.
export function toToolJsonSchema(
  zodSchema: z.ZodType,
  augment?: (schema: JsonSchema) => JsonSchema
): ReturnType<typeof fromJsonSchema> {
  const raw = z.toJSONSchema(zodSchema) as JsonSchema;
  const cleaned = stripRootSchema(walk(raw) as JsonSchema);
  const final = augment ? augment(cleaned) : cleaned;
  return fromJsonSchema(final);
}
