import * as z from 'zod/v4';

import { isSafeGlobSyntax } from './glob.js';
import { MIME_KINDS } from './mime.js';
import { ENTRY_TYPES } from './primitives.js';
import { MAX_SEARCH_DEPTH } from './util.js';

// Runtime: full ISO-8601 UTC; emits the standard `date-time` format on the wire
// (no AJV warning — it is a known format, unlike sha256_hex / base64url).
// No `id` on this or any other shared schema below: an `id` hoists the schema
// into `$defs` and leaves a `$ref` at every use site, which is exactly the wire
// weight `toDraft202012` (tools/define.ts) publishes without.
export const IsoDateTime = z.iso.datetime().meta({
  description: 'ISO 8601 UTC date-time string (e.g. 2024-01-15T12:00:00.000Z)',
  // `format: "date-time"` already pins the value; zod's ~330-char calendar
  // regex is pure wire weight. Runtime validation still runs it — this
  // suppresses the emitted keyword only.
  pattern: undefined,
});

// pattern (not z.hash('sha256')) so no `format: "sha256_hex"` keyword is emitted;
// the SDK's AJV validator warns on that unknown format at every server start.
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({ description: 'SHA-256 digest as a 64-character lowercase hex string' });

export const NonNegInt = z
  .int({ message: 'Must be integer' })
  .nonnegative({ message: 'Must be ≥ 0' });

export const PositiveInt = z
  .int({ message: 'Must be integer' })
  .positive({ message: 'Must be > 0' });

const FILE_TYPES = ENTRY_TYPES;
export type FileType = (typeof FILE_TYPES)[number];
export const FileType = z.enum(FILE_TYPES);

const FILE_KINDS = MIME_KINDS;
export type FileKind = (typeof FILE_KINDS)[number];
export const FileKind = z.enum(FILE_KINDS);

const MAX_PATH_LENGTH = 4096;

export const SHELL_METACHAR_RE = /[\n\r;|`]/;

export const isBlank = (val: string): boolean => val.trim().length === 0;

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
  .describe('File or directory path inside an allowed workspace root.');

export const OptionalPath = PathBase.optional();
export const RequiredPath = PathBase;

export const SafeGlobPattern = z
  .string()
  .min(1, { message: 'Pattern required' })
  .max(1000, { message: 'Max 1000 chars' })
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
  .describe('Relative glob pattern under the search root (e.g. "**/*.ts", "src/**/*.js").')
  .meta({ examples: ['**/*.ts', 'src/**/*.js', '*.{ts,tsx}'] });

// Only the fields whose key does not already say what they hold carry a
// description. A `.describe('Name')` on `name` costs every client tokens to
// learn nothing.
export const FileInfoSchema = z.strictObject({
  name: z.string(),
  path: z.string(),
  type: FileType,
  size: NonNegInt,
  tokenEstimate: NonNegInt.optional().describe('Rough token estimate; use to pre-screen read cost'),
  created: IsoDateTime,
  modified: IsoDateTime,
  accessed: IsoDateTime,
  permissions: z.string(),
  isHidden: z.boolean(),
  mimeType: z.string().optional(),
  symlinkTarget: z.string().optional().describe('Target (symlink)'),
});

export const OperationSummarySchema = z.strictObject({
  total: NonNegInt,
  succeeded: NonNegInt,
  failed: NonNegInt,
});

export const PerFileErrorSchema = z.strictObject({
  code: z.string(),
  message: z.string(),
  path: z.string().optional(),
  suggestion: z.string().optional(),
});

/** One entry of a tool's `failures[]`: the path that failed and why. */
export const PathFailureSchema = z.strictObject({
  path: z.string(),
  error: PerFileErrorSchema,
});

/**
 * One entry of a source→destination tool's `failures[]`. The verb and noun stay
 * per-op so the `.describe()` text reads correctly for each caller.
 */
export function pairFailureSchema(verb: 'copied' | 'moved', noun: 'copy' | 'move') {
  return z.strictObject({
    source: z.string().describe(`Source path that could not be ${verb}`),
    destination: z.string().describe(`Intended destination path for the failed ${noun}`),
    error: PerFileErrorSchema,
  });
}

/** Wire shape of a `pairFailureSchema` entry — the runtime twin of the schema. */
export type PairFailureItem = z.infer<ReturnType<typeof pairFailureSchema>>;

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
  },
  ctx: z.RefinementCtx,
): void {
  const hasHead = value.head !== undefined;
  const hasTail = value.tail !== undefined;
  const hasStart = value.startLine !== undefined;
  const hasEnd = value.endLine !== undefined;

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
}

export function defaultFalseBoolean(description: string): z.ZodDefault<z.ZodBoolean> {
  return z.boolean().default(false).describe(description);
}

export const includeHiddenField = (): z.ZodDefault<z.ZodBoolean> =>
  defaultFalseBoolean('Include hidden items (starting with .)');
export const includeIgnoredField = (): z.ZodDefault<z.ZodBoolean> =>
  defaultFalseBoolean('Include ignored items (node_modules, .git, etc).');
export const maxDepthField = (): z.ZodOptional<z.ZodNumber> =>
  z
    .uint32()
    .min(0)
    .max(MAX_SEARCH_DEPTH)
    .optional()
    .describe('Max directory depth to scan; 0 = base directory only, omit for unlimited');

const DEFAULT_MAX_BATCH = 1000;

export type SingleOrBatchShape<TExtra extends z.ZodRawShape> = TExtra & {
  path: z.ZodOptional<typeof RequiredPath>;
  paths: z.ZodOptional<z.ZodArray<typeof RequiredPath>>;
};

export function singleOrBatchPathsInput<TExtra extends z.ZodRawShape>(opts: {
  extra: TExtra;
  maxBatch?: number;
}): z.ZodObject<SingleOrBatchShape<TExtra>> {
  const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;

  const shape: z.ZodRawShape = {
    ...opts.extra,
    path: RequiredPath.optional().describe('Single file path; mutually exclusive with paths'),
    paths: z
      .array(RequiredPath)
      .min(1)
      .max(maxBatch)
      .optional()
      .describe(
        `Array of file paths for batch mode (max ${String(maxBatch)}); mutually exclusive with path`,
      ),
  };

  const base = z.strictObject(shape).superRefine((value, ctx) => {
    const hasPath = value['path'] !== undefined;
    const hasPaths = value['paths'] !== undefined;

    if (!hasPath && !hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['path'],
        message: "Either 'path' or 'paths' must be provided",
        input: value,
      });
      return;
    }
    if (hasPath && hasPaths) {
      ctx.addIssue({
        code: 'custom',
        path: ['paths'],
        message: "Cannot use both 'path' and 'paths'",
        input: value,
      });
    }
  });

  // Mirror the superRefine above on the wire: exactly one input mode. `{}` and
  // `path`+`paths` both fail this oneOf, matching the runtime rule.
  return base.meta({
    oneOf: [{ required: ['path'] }, { required: ['paths'] }],
  }) as z.ZodObject<SingleOrBatchShape<TExtra>>;
}

/**
 * Extract the filesystem paths from a {@link singleOrBatchPathsInput} shape
 * (`{ path?, paths?, files?[{path}] }`) for the executor's access-grant
 * pre-check. Exactly one of the three is set (enforced by the schema's
 * superRefine), so they are checked in priority order.
 */
export function singleOrBatchAccessPaths(args: {
  path?: string | undefined;
  paths?: string[] | undefined;
  files?: readonly { path: string }[] | undefined;
}): string[] {
  if (args.path) return [args.path];
  if (args.paths) return [...args.paths];
  if (args.files) return args.files.map((f) => f.path);
  return [];
}

// `args` is the exact argument object the one producer (read's
// buildReadContinuation) emits, not a free-form record: a bare
// `z.record(z.string(), z.unknown())` renders as `additionalProperties: {}`,
// which carries no validation keyword and constrains nothing — the Inspector's
// portability check flags it, and a client cannot tell what to pass. Widen this
// (to a union) only when a second tool starts emitting continuations.
export const ContinuationSchema = z.strictObject({
  tool: z.string().describe('Tool name to call for the next chunk'),
  args: z
    .strictObject({ path: z.string(), startLine: PositiveInt, endLine: PositiveInt })
    .describe('Ready-to-use arguments for the next call; pass verbatim'),
  hint: z.string().describe('One-sentence description of the data still remaining to be read'),
});

// ponytail: charset regex, not z.base64url() — the SDK's AJV warns on the
// unknown `base64url` format; the server's own decode (cursor.ts) is the real
// validation, so loosening the client-facing schema to the alphabet is safe.
const base64urlCursor = z.string().regex(/^[A-Za-z0-9_-]+$/);

// Ships once per paginated tool — wording is budgeted (TOOL-SURFACE-002).
export const CursorSchema = base64urlCursor
  .optional()
  .describe(
    'Opaque pagination cursor; pass unchanged for the next page. Pages slice one snapshot ' +
      'taken on the first call; it expires after ~60s — re-request without a cursor if rejected.',
  );

export const NextCursorSchema = base64urlCursor
  .optional()
  .describe('Cursor for the next page; omitted when this is the final page.');
