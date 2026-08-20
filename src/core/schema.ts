import * as z from 'zod/v4';

import { MIME_KINDS } from './mime.js';
import { isSafeGlobSyntax } from './path.js';
import { ENTRY_TYPES } from './primitives.js';
import { MAX_SEARCH_DEPTH } from './util.js';

// Runtime: full ISO-8601 UTC; format pattern stripped by post-processor on the wire.
export const IsoDateTime = z.iso.datetime().meta({
  id: 'IsoDateTime',
  title: 'ISO Date-Time',
  description: 'ISO 8601 UTC date-time string (e.g. 2024-01-15T12:00:00.000Z)',
});

export const Sha256Hex = z.hash('sha256').meta({
  id: 'Sha256Hex',
  title: 'SHA-256 Hash',
  description: 'SHA-256 digest as a 64-character lowercase hex string',
});

export const NonNegInt = z
  .int({ message: 'Must be integer' })
  .nonnegative({ message: 'Must be ≥ 0' })
  .meta({ id: 'NonNegInt', title: 'Non-Negative Integer' });

export const PositiveInt = z
  .int({ message: 'Must be integer' })
  .positive({ message: 'Must be > 0' })
  .meta({ id: 'PositiveInt', title: 'Positive Integer' });

export const FILE_TYPES = ENTRY_TYPES;
export type FileType = (typeof FILE_TYPES)[number];
export const FileType = z.enum(FILE_TYPES).meta({ id: 'FileType', title: 'File Type' });

export const FILE_KINDS = MIME_KINDS;
export type FileKind = (typeof FILE_KINDS)[number];
export const FileKind = z.enum(FILE_KINDS).meta({ id: 'FileKind', title: 'File Kind' });

const MAX_PATH_LENGTH = 4096;

export const SHELL_METACHAR_RE = /[\n\r;|`]/;

export function isBlank(val: string): boolean {
  return val.trim().length === 0;
}

const PathBase = z
  .string()
  .min(1, { message: 'Path required' })
  .max(MAX_PATH_LENGTH, { message: `Path too long (max ${MAX_PATH_LENGTH} chars)` })
  .superRefine((val, ctx) => {
    if (val.length === 0) {
      return;
    }
    if (val.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Path cannot be empty or whitespace-only',
        fatal: true,
      });
      return z.NEVER;
    }
    if (val.includes('\0')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Path cannot contain null bytes',
        fatal: true,
      });
      return z.NEVER;
    }
    if (val.includes('..')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Directory traversal sequences ("..") are forbidden',
        fatal: true,
      });
      return z.NEVER;
    }
    if (SHELL_METACHAR_RE.test(val)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Path contains prohibited characters (newlines or shell metacharacters)',
        fatal: true,
      });
      return z.NEVER;
    }
  })
  .describe(
    'Absolute or relative path within an allowed workspace root. Must not contain directory traversal sequences (e.g. "..") or shell metacharacters, and cannot be empty or whitespace-only.',
  )
  .meta({
    suggestion: 'Path must be inside an allowed root. Call list_roots to see allowed directories.',
  });

export const OptionalPath = PathBase.optional();
export const RequiredPath = PathBase;

export const SafeGlobPattern = z
  .string()
  .min(1, { message: 'Pattern required' })
  .max(1000, { message: 'Max 1000 chars' })
  .regex(/^(?![\\/])(?![a-zA-Z]:[\\/])(?!.*\.\.).*$/, {
    message: 'Invalid glob or unsafe path (absolute/.. forbidden)',
  })
  .superRefine((val, ctx) => {
    if (val.length === 0) {
      return;
    }
    if (val.trim().length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'Pattern cannot be empty or whitespace-only',
        fatal: true,
      });
      return z.NEVER;
    }
    if (val.includes('\0')) {
      ctx.addIssue({
        code: 'custom',
        message: 'Pattern cannot contain null bytes',
        fatal: true,
      });
      return z.NEVER;
    }
    if (!isSafeGlobSyntax(val)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Invalid glob or unsafe path (absolute/.. forbidden)',
        fatal: true,
      });
      return z.NEVER;
    }
    if (SHELL_METACHAR_RE.test(val)) {
      ctx.addIssue({
        code: 'custom',
        message: 'Pattern contains prohibited characters (newlines or shell metacharacters)',
        fatal: true,
      });
      return z.NEVER;
    }
  })
  .describe(
    'A strictly relative glob pattern matching files under the search root (e.g. "**/*.ts", "src/**/*.js"). Cannot start with a slash, must not be empty or whitespace-only, and must not contain directory traversal sequences like ".." or shell metacharacters.',
  )
  .meta({
    id: 'SafeGlobPattern',
    title: 'Glob Pattern',
    examples: ['**/*.ts', 'src/**/*.js', '*.{ts,tsx}'],
    suggestion: 'Use forward-slash globs; absolute paths and ".." are forbidden.',
  });

export const FileInfoSchema = z
  .strictObject({
    name: z.string().describe('Name'),
    path: z.string().describe('Absolute path'),
    type: FileType.describe('Type'),
    size: NonNegInt.describe('Size (bytes)'),
    tokenEstimate: NonNegInt.optional().describe(
      'Estimated token count (file size ÷ 4); use to pre-screen read cost',
    ),
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

// TODO(future): Wrap createReadRangeFields output in a typed Zod object with built-in
// cross-validation. Safe for now — the only caller (read.ts) calls validateReadRange in its own superRefine.
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
      .min(1, { message: 'Min: 1' })
      .max(100000, { message: 'Max: 100,000' })
      .optional()
      .describe(descs.head),
    tail: z
      .int32()
      .min(1, { message: 'Min: 1' })
      .max(100000, { message: 'Max: 100,000' })
      .optional()
      .describe(descs.tail),
    startLine: z
      .int32()
      .min(1, { message: 'Min: 1' })
      .max(100000, { message: 'Max: 100,000' })
      .optional()
      .describe(descs.startLine),
    endLine: z
      .int32()
      .min(1, { message: 'Min: 1' })
      .max(100000, { message: 'Max: 100,000' })
      .optional()
      .describe(descs.endLine),
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
  if (hasEnd && !hasStart) {
    ctx.addIssue({
      code: 'custom',
      path: ['endLine'],
      message: "'endLine' requires 'startLine' to be set",
      params: {
        rule: 'endLine_requires_startLine',
        suggestion: "Provide both 'startLine' and 'endLine' together.",
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
    const errorPath = value.offset !== undefined ? 'offset' : 'length';
    ctx.addIssue({
      code: 'custom',
      path: [errorPath],
      message: `Cannot use '${errorPath}' with line-based params (head/tail/startLine/endLine)`,
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
  return z.boolean().default(false).describe(description);
}

export const includeHiddenField = () =>
  defaultFalseBoolean('Include hidden items (starting with .)');
export const includeIgnoredField = () =>
  defaultFalseBoolean('Include ignored items (node_modules, .git, etc).');
export const maxDepthField = () =>
  z
    .uint32()
    .min(0)
    .max(MAX_SEARCH_DEPTH)
    .optional()
    .describe('Max directory depth to scan; 0 = base directory only, omit for unlimited');

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
  } & (TPerFile extends z.ZodRawShape
      ? {
          files: z.ZodOptional<z.ZodArray<z.ZodObject<{ path: typeof RequiredPath } & TPerFile>>>;
        }
      : object)
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
    path: RequiredPath.optional().describe(
      'Single file path; mutually exclusive with paths and files',
    ),
    paths: z
      .array(RequiredPath)
      .min(1)
      .max(maxBatch)
      .optional()
      .describe(
        `Array of file paths for batch mode (max ${String(maxBatch)}); mutually exclusive with path and files`,
      ),
    ...(filesSchema ? { files: filesSchema.optional() } : {}),
  };

  return z.strictObject(shape).superRefine((value, ctx) => {
    const hasPath = value['path'] !== undefined;
    const hasPaths = value['paths'] !== undefined;
    // Safety: z.strictObject above rejects unknown keys (including `files` when !triadic) before this runs.
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
  }) as unknown as ReturnType<typeof singleOrBatchPathsInput<TExtra, TPerFile>>;
}

export const ContinuationSchema = z
  .strictObject({
    tool: z.string().describe('Tool name to call for the next chunk'),
    args: z
      .record(z.string(), z.unknown())
      .describe('Ready-to-use arguments for the next call; pass verbatim'),
    hint: z.string().describe('One-sentence description of the data still remaining to be read'),
  })
  .meta({ id: 'Continuation', title: 'Continuation' });

export const CursorSchema = z
  .base64url()
  .optional()
  .describe(
    'Opaque pagination cursor from a prior response; pass unchanged to fetch the next page. ' +
      'list cursors expire after ~5 min or server restart; find_files cursors re-run the full query per page, ' +
      'so matches may shift (duplicate or skip) if files change between page requests.',
  );

export const NextCursorSchema = z
  .base64url()
  .optional()
  .describe('Cursor for the next page; omitted when this is the final page.');
