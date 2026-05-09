import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

type JsonSchema = Record<string, unknown>;

const NONSTANDARD_FORMATS = new Set(['base64url', 'sha256_hex']);

// Zod 4 `override` callback fires per-node and mutates `ctx.jsonSchema` in-place.
// Replaces the old hand-rolled `walk()` recursion for per-node cleanup.
const JSON_SCHEMA_OVERRIDE: NonNullable<
  NonNullable<Parameters<typeof z.toJSONSchema>[1]>['override']
> = (ctx) => {
  const out = ctx.jsonSchema as JsonSchema;
  // Strip `pattern` from date-time nodes — eliminates the 340-char Zod regex
  if (out.format === 'date-time' && 'pattern' in out) delete out.pattern;
  // Strip implicit `maximum: MAX_SAFE_INTEGER` from integer nodes
  if (out.type === 'integer' && out.maximum === Number.MAX_SAFE_INTEGER) {
    delete out.maximum;
  }
  // Strip nonstandard format values when a concrete pattern already encodes the constraint
  if (typeof out.format === 'string' && NONSTANDARD_FORMATS.has(out.format) && 'pattern' in out) {
    delete out.format;
  }
  // Strip contentEncoding when a concrete pattern already encodes the constraint
  if ('contentEncoding' in out && 'pattern' in out) delete out.contentEncoding;
  // Strip suggestion — runtime metadata only, must not appear in JSON Schema
  if ('suggestion' in out) delete out.suggestion;
};

// Remove from `required` any property that has a `default` value.
// Zod marks defaulted fields required, but clients omit them and Zod fills in the default.
// This is a cross-property concern, so it runs as a post-pass after toJSONSchema.
function removeDefaultedFromRequired(schema: unknown): unknown {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(removeDefaultedFromRequired);
  const out: JsonSchema = {};
  for (const [k, v] of Object.entries(schema as JsonSchema)) {
    out[k] = removeDefaultedFromRequired(v);
  }
  if (Array.isArray(out.required) && out.properties && typeof out.properties === 'object') {
    const props = out.properties as Record<string, JsonSchema>;
    const filtered = (out.required as string[]).filter((n) => !('default' in (props[n] ?? {})));
    if (filtered.length === 0) delete out.required;
    else out.required = filtered;
  }
  return out;
}

function stripRootSchema(schema: JsonSchema): JsonSchema {
  if ('$schema' in schema) {
    const { $schema: _removed, ...rest } = schema;
    return rest;
  }
  return schema;
}

export function toToolJsonSchema(
  zodSchema: z.ZodType,
  augment?: (schema: JsonSchema) => JsonSchema,
): StandardSchemaWithJSON {
  const raw = z.toJSONSchema(zodSchema, {
    io: 'input',
    unrepresentable: 'any',
    override: JSON_SCHEMA_OVERRIDE,
  }) as JsonSchema;
  const cleaned = removeDefaultedFromRequired(stripRootSchema(raw)) as JsonSchema;
  const final = augment ? augment(cleaned) : cleaned;
  const std = { ...zodSchema['~standard'] } as Record<string, unknown>;
  std.jsonSchema = {
    input: () => final,
    output: () => final,
  };

  return {
    '~standard': std,
    jsonSchema: final,
  } as unknown as StandardSchemaWithJSON;
}
