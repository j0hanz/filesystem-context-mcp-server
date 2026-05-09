// src/schema.ts
// Centralized schema layer consolidating primitives, domain composites, and MCP JSON-Schema adapter
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';

import { z } from 'zod';

// ============ JSON-Schema Adapter ============

const STRIP_FORMATS = new Set(['base64url', 'sha256_hex']);

const override: NonNullable<Parameters<typeof z.toJSONSchema>[1]>['override'] = (ctx) => {
  const s = ctx.jsonSchema as Record<string, unknown>;
  if (s.format === 'date-time' && 'pattern' in s) delete s.pattern;
  if (s.type === 'integer' && s.maximum === Number.MAX_SAFE_INTEGER) delete s.maximum;
  if (typeof s.format === 'string' && STRIP_FORMATS.has(s.format) && 'pattern' in s)
    delete s.format;
  if ('contentEncoding' in s && 'pattern' in s) delete s.contentEncoding;
};

/**
 * Convert a Zod schema to MCP-compatible StandardSchemaWithJSON.
 * Removes $schema, cleans up redundant format/pattern combinations,
 * and ensures both input() and output() callables are present.
 */
export function toMcpSchema(schema: z.ZodType): StandardSchemaWithJSON {
  const json = z.toJSONSchema(schema, {
    io: 'input',
    unrepresentable: 'any',
    reused: 'ref',
    ...(override ? { override } : {}),
  });
  delete (json as Record<string, unknown>).$schema;
  return Object.assign({}, schema['~standard'], {
    jsonSchema: { input: () => json, output: () => json },
  }) as never;
}

// ============ Primitives ============

/** ISO 8601 DateTime string (e.g., "2026-05-09T12:30:45Z") */
export const IsoDateTime = z.iso.datetime().meta({ id: 'IsoDateTime' });

/** SHA-256 hex digest (64 lowercase hex characters) */
export const Sha256Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/)
  .meta({ id: 'Sha256Hex' });

/** Non-negative integer (0, 1, 2, ...) */
export const NonNegInt = z.number().int().min(0).meta({ id: 'NonNegInt' });

/** Positive integer (1, 2, 3, ...) */
export const PositiveInt = z.number().int().min(1).meta({ id: 'PositiveInt' });

/** 32-bit unsigned integer (0 to 4,294,967,295) */
export const Uint32 = z.number().int().min(0).max(4294967295).meta({ id: 'Uint32' });

/** File type enumeration */
export const FileType = z.enum(['file', 'directory', 'symlink', 'other']).meta({ id: 'FileType' });

/** Filesystem path (1-4096 characters) */
export const Path = z.string().min(1).max(4096).meta({ id: 'Path' });

/** Array of filesystem paths (1-1000 items) */
export const Paths = z.array(Path).min(1).max(1000).meta({ id: 'Paths' });

/** Glob pattern (1-1000 characters) */
export const Glob = z.string().min(1).max(1000).meta({ id: 'Glob' });

/** Base64-URL-encoded opaque cursor for pagination */
export const CursorOpaque = z.base64url().optional().meta({ id: 'Cursor' });

// ============ Domain Composites ============

/**
 * File or directory metadata.
 * Includes name, path, type, size, timestamps, MIME type, and symlink target.
 */
export const FileInfo = z
  .strictObject({
    name: z.string(),
    path: Path,
    type: FileType,
    size: NonNegInt,
    created: IsoDateTime.optional(),
    modified: IsoDateTime.optional(),
    accessed: IsoDateTime.optional(),
    mimeType: z.string().optional(),
    symlinkTarget: z.string().optional(),
  })
  .meta({ id: 'FileInfo' });

/**
 * Error information for a single batch item.
 * Contains error code, message, and optional suggestion.
 */
export const BatchItemError = z
  .strictObject({
    code: z.string(),
    message: z.string(),
    suggestion: z.string().optional(),
  })
  .meta({ id: 'BatchItemError' });

/**
 * Discriminated union representing success or failure of a single batch item.
 * Discriminator: 'ok' (true = success, false = failure)
 *
 * @example
 * const itemResult = batchResult(z.string());
 * type ItemResult = z.infer<typeof itemResult>;
 * // ItemResult: { ok: true; path: string; data: string } | { ok: false; path: string; error: BatchItemError }
 */
export const batchResult = <T extends z.ZodType>(payload: T) =>
  z.discriminatedUnion('ok', [
    z.strictObject({ ok: z.literal(true), path: Path, data: payload }),
    z.strictObject({ ok: z.literal(false), path: Path, error: BatchItemError }),
  ]);

/**
 * Summary statistics for a batch operation.
 * Tracks total items, successes, and failures.
 */
export const BatchSummary = z
  .strictObject({
    total: NonNegInt,
    succeeded: NonNegInt,
    failed: NonNegInt,
  })
  .meta({ id: 'BatchSummary' });

/**
 * Discriminated union for paginated response.
 * Discriminator: 'hasMore' (true if more items exist, false if final page)
 *
 * When hasMore=false: only items array.
 * When hasMore=true: items array + nextCursor for resumption.
 *
 * @example
 * const page = paginated(z.string());
 * type Page = z.infer<typeof page>;
 * // Page: { hasMore: false; items: string[] } | { hasMore: true; items: string[]; nextCursor: string }
 */
export const paginated = <T extends z.ZodType>(
  payload: T,
  extraFalse: z.ZodRawShape = {},
  extraTrue: z.ZodRawShape = {},
) =>
  z.discriminatedUnion('hasMore', [
    z.strictObject({ hasMore: z.literal(false), items: z.array(payload), ...extraFalse }),
    z.strictObject({
      hasMore: z.literal(true),
      items: z.array(payload),
      nextCursor: z.string(),
      ...extraTrue,
    }),
  ]);

/**
 * Continuation token for resuming a multi-step operation.
 * Encodes the tool, arguments, and a user-facing hint.
 */
export const Continuation = z
  .strictObject({
    tool: z.string(),
    args: z.record(z.string(), z.unknown()),
    hint: z.string(),
  })
  .meta({ id: 'Continuation' });
