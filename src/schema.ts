// src/schema.ts
// Centralized schema layer consolidating primitives, domain composites, and MCP JSON-Schema adapter
import { z } from 'zod/v4';

import { isSafeGlobSyntax } from './core/path.js';

export type ZodInfer<T> = T extends z.ZodType ? z.infer<T> : never;

export interface SchemaAndInfer<T extends z.ZodType> {
  schema: T;
  inferred: z.infer<T>;
}

// ============ Primitives (from fields.ts) ============

// Runtime: full ISO-8601 UTC validation. Wire: format only (pattern stripped by post-processor).
export const IsoDateTime = z.iso.datetime().meta({
  id: 'IsoDateTime',
  title: 'ISO Date-Time',
  description: 'ISO 8601 date-time (UTC)',
});

export const Sha256Hex = z.hash('sha256').meta({
  id: 'Sha256Hex',
  title: 'SHA-256 Hash',
  description: 'SHA-256 hex digest',
});

export const NonNegInt = z
  .int({ error: 'Must be integer' })
  .nonnegative({ error: 'Must be ≥ 0' })
  .meta({ id: 'NonNegInt', title: 'Non-Negative Integer' });

export const PositiveInt = z
  .int({ error: 'Must be integer' })
  .positive({ error: 'Must be > 0' })
  .meta({ id: 'PositiveInt', title: 'Positive Integer' });

export const FILE_TYPES = ['file', 'directory', 'symlink', 'other'] as const;
export type FileType = (typeof FILE_TYPES)[number];
export const FileType = z.enum(FILE_TYPES).meta({ id: 'FileType', title: 'File Type' });

const MAX_PATH_LENGTH = 4096;

const PathBase = z
  .string()
  .min(1, { error: 'Path required' })
  .max(MAX_PATH_LENGTH, { error: `Path too long (max ${MAX_PATH_LENGTH} chars)` })
  .describe('Path inside an allowed root')
  .meta({
    suggestion:
      'Path must be inside an allowed root. Run the roots tool to list allowed directories.',
  });

export const OptionalPath = PathBase.optional();
export const RequiredPath = PathBase;

export const SafeGlobPattern = z
  .string()
  .min(1, { error: 'Pattern required' })
  .max(1000, { error: 'Max 1000 chars' })
  .regex(/^(?!\/)(?![a-zA-Z]:[\\/])(?!.*\.\.).+$/, {
    error: 'Invalid glob or unsafe path (absolute/.. forbidden)',
    abort: true,
  })
  .refine((val) => isSafeGlobSyntax(val), {
    message: 'Invalid glob or unsafe path (absolute/.. forbidden)',
  })
  .describe('Glob pattern (e.g. "**/*.ts", "src/**/*.js")')
  .meta({
    id: 'SafeGlobPattern',
    title: 'Glob Pattern',
    examples: ['**/*.ts', 'src/**/*.js', '*.{ts,tsx}'],
    suggestion: 'Use forward-slash globs; absolute paths and ".." are forbidden.',
  });

// ============ Schemas from schemas/shared.ts ============

export const FileInfoSchema = z
  .strictObject({
    name: z.string().describe('Name'),
    path: z.string().describe('Absolute path'),
    type: FileType.describe('Type'),
    size: NonNegInt.describe('Size (bytes)'),
    tokenEstimate: NonNegInt.optional().describe('Est. tokens (size÷4)'),
    created: IsoDateTime.describe('Created'),
    modified: IsoDateTime.describe('Modified'),
    accessed: IsoDateTime.describe('Accessed'),
    permissions: z.string().describe('Permissions'),
    isHidden: z.boolean().describe('Hidden?'),
    mimeType: z.string().optional().describe('MIME type'),
    symlinkTarget: z.string().optional().describe('Target (symlink)'),
  })
  .meta({ id: 'FileInfo', title: 'File Info' });

export const OperationSummarySchema = z
  .strictObject({
    total: NonNegInt.describe('Total'),
    succeeded: NonNegInt.describe('Succeeded'),
    failed: NonNegInt.describe('Failed'),
  })
  .meta({ id: 'OperationSummary', title: 'Operation Summary' });

export const PerFileErrorSchema = z
  .strictObject({
    code: z.string().describe('Error code'),
    message: z.string().describe('Error message'),
    path: z.string().optional().describe('Path involved'),
    suggestion: z.string().optional().describe('Suggested fix'),
  })
  .meta({ id: 'PerFileError', title: 'Per-File Error' });

interface ReadRangeDescriptions {
  head: string;
  tail: string;
  startLine: string;
  endLine: string;
}

export function createReadRangeFields(descs: ReadRangeDescriptions) {
  return {
    head: z
      .int32()
      .min(1, { error: 'Min: 1' })
      .max(100000, { error: 'Max: 100,000' })
      .optional()
      .describe(descs.head),
    tail: z
      .int32()
      .min(1, { error: 'Min: 1' })
      .max(100000, { error: 'Max: 100,000' })
      .optional()
      .describe(descs.tail),
    startLine: z.int32().min(1, { error: 'Min: 1' }).optional().describe(descs.startLine),
    endLine: z.int32().min(1, { error: 'Min: 1' }).optional().describe(descs.endLine),
  };
}

export function validateReadRange(
  value: {
    head?: number | undefined;
    tail?: number | undefined;
    startLine?: number | undefined;
    endLine?: number | undefined;
    offset?: number | undefined;
    length?: number | undefined;
  },
  ctx: z.RefinementCtx,
): void {
  const hasHead = value.head !== undefined;
  const hasTail = value.tail !== undefined;
  const hasStart = value.startLine !== undefined;
  const hasEnd = value.endLine !== undefined;
  const hasByteRange = value.offset !== undefined || value.length !== undefined;

  if (hasHead && (hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['head'],
      message: "Cannot use 'head' with 'startLine'/'endLine'",
      params: {
        rule: 'head_no_line_range',
        conflictsWith: ['startLine', 'endLine'],
        suggestion: "Use either 'head' alone or 'startLine'/'endLine' together.",
      },
      input: value,
    });
  }
  if (hasTail && (hasHead || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['tail'],
      message: "Cannot use 'tail' with 'head'/'startLine'/'endLine'",
      params: {
        rule: 'tail_exclusive',
        conflictsWith: ['head', 'startLine', 'endLine'],
        suggestion: "Use 'tail' alone or use 'startLine'/'endLine' without 'tail'.",
      },
      input: value,
    });
  }
  const effectiveStart = value.startLine ?? 1;
  if (value.endLine !== undefined && value.endLine < effectiveStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: "'endLine' must be >= 'startLine'",
      params: {
        rule: 'endLine_gte_startLine',
        conflictsWith: ['startLine'],
        suggestion: 'Set endLine to a value greater than or equal to startLine.',
      },
      input: value,
    });
  }
  if (hasByteRange && (hasHead || hasTail || hasStart || hasEnd)) {
    ctx.addIssue({
      code: 'custom',
      path: ['offset'],
      message: "Cannot use 'offset'/'length' with line-based params (head/tail/startLine/endLine)",
      params: {
        rule: 'byte_range_no_line_params',
        conflictsWith: ['head', 'tail', 'startLine', 'endLine'],
        suggestion: "Use 'offset'/'length' alone; do not combine with line-based params.",
      },
      input: value,
    });
  }
}

export function defaultFalseBoolean(description: string) {
  return z.boolean().optional().default(false).describe(description);
}

export const includeHiddenField = () =>
  defaultFalseBoolean('Include hidden items (starting with .)');
export const includeIgnoredField = () =>
  defaultFalseBoolean('Include ignored items (node_modules, .git, etc).');

const DEFAULT_MAX_BATCH = 1000;

export function singleOrBatchPathsInput<
  TExtra extends z.ZodRawShape,
  TPerFile extends z.ZodRawShape | undefined = undefined,
>(opts: {
  extra: TExtra;
  perFile?: TPerFile;
  maxBatch?: number;
}): z.ZodObject<
  TExtra & {
    path: z.ZodOptional<typeof RequiredPath>;
    paths: z.ZodOptional<z.ZodArray<typeof RequiredPath>>;
    files: z.ZodOptional<
      z.ZodArray<z.ZodObject<{ path: typeof RequiredPath } & NonNullable<TPerFile>>>
    >;
  }
> {
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;
  const perFileShape = opts.perFile;
  const triadic = perFileShape !== undefined;

  const filesSchema =
    perFileShape === undefined
      ? undefined
      : z
          .array(z.strictObject({ path: RequiredPath, ...perFileShape }))
          .min(1)
          .max(maxBatch)
          .describe(`Per-file entries (batch mode; max ${String(maxBatch)})`);

  const shape: z.ZodRawShape = {
    ...opts.extra,
    path: RequiredPath.optional().describe('File path (single-path mode)'),
    paths: z
      .array(RequiredPath)
      .min(1)
      .max(maxBatch)
      .optional()
      .describe(`File paths (batch mode; max ${String(maxBatch)})`),
    ...(filesSchema ? { files: filesSchema.optional() } : {}),
  };

  return z.strictObject(shape).superRefine((value, ctx) => {
    const hasPath = value['path'] !== undefined;
    const hasPaths = value['paths'] !== undefined;
    const hasFiles = triadic && value['files'] !== undefined;
    const provided = [hasPath, hasPaths, hasFiles].filter(Boolean).length;

    if (provided === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: triadic
          ? "Provide exactly one of 'path', 'paths', or 'files'"
          : "Either 'path' or 'paths' must be provided",
        input: value,
      });
      return;
    }
    if (provided > 1) {
      ctx.addIssue({
        code: 'custom',
        path: triadic ? ['path'] : ['paths'],
        message: triadic
          ? "Provide exactly one of 'path', 'paths', or 'files'"
          : "Cannot use both 'path' and 'paths'",
        input: value,
      });
    }
  }) as never;
}

export const ContinuationSchema = z
  .strictObject({
    tool: z.string().describe('Tool name to call'),
    args: z.record(z.string(), z.unknown()).describe('Ready-to-use arguments'),
    hint: z.string().describe('One sentence: what data remains'),
  })
  .meta({ id: 'Continuation', title: 'Continuation' });

export const CursorSchema = z
  .base64url()
  .optional()
  .describe(
    'Pagination cursor from a previous response. Treat as opaque. ' +
      '`ls` cursors are snapshot-backed (expire after ~5 min or restart); ' +
      '`find` cursors are offset-based and re-run the query each page.',
  );

export const NextCursorSchema = z
  .base64url()
  .optional()
  .describe('Cursor for the next page; absent on the final page.');
