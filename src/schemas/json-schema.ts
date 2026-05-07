import { fromJsonSchema } from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

type JsonSchema = Record<string, unknown>;

// Recursively clean up JSON Schema output produced by z.toJSONSchema():
// - Strip `pattern` from `format: "date-time"` nodes (eliminates the 340-char Zod datetime regex)
// - Strip `maximum: Number.MAX_SAFE_INTEGER` from integer nodes (implicit, just noise)
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
  return result;
}

// Convert a Zod schema to a Standard Schema suitable for MCP tool registration.
// Applies the walk cleanup. Pass an optional `augment` function to inject
// JSON Schema constructs (e.g. `allOf` oneOf constraints) that Zod can't express natively.
export function toToolJsonSchema(
  zodSchema: z.ZodType,
  augment?: (schema: JsonSchema) => JsonSchema
): ReturnType<typeof fromJsonSchema> {
  const raw = z.toJSONSchema(zodSchema) as JsonSchema;
  const cleaned = walk(raw) as JsonSchema;
  const final = augment ? augment(cleaned) : cleaned;
  return fromJsonSchema(final);
}
