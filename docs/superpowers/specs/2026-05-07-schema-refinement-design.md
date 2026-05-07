# Schema Refinement & Modernization — Design Spec

**Date:** 2026-05-07
**Status:** Approved for implementation planning
**Scope:** `src/schemas.ts` and the tool registration layer (`src/tools/`)

## Goals

Modernize and optimize the schema layer behind the 18 MCP tools. Four targets:

1. **Wire-size & perf** — eliminate the duplicated ISO-datetime regex and shared shape repetition in `tools/list`.
2. **Client UX & accuracy** — fix `ok` discriminator inconsistencies, model mutual exclusion in JSON Schema, tighten always-set output fields to required, add targeted `examples`.
3. **Cross-tool consistency** — unify `stoppedReason` enums, share field builders for repeated inputs (`includeHidden`, `maxDepth`, etc.).
4. **API contract cleanup** — remove the legacy singular `source` (mv) and `path` (mkdir) inputs in favor of the array forms.

The package version is **not** bumped as part of this work.

## Non-goals

- No tool renames (e.g., `read_many` → `read_files`). Names are stable contract.
- No new pagination on `grep` / `search_and_replace`. Their streaming semantics don't fit an offset-cursor model cleanly.
- No discriminated-union rework of output schemas (`{ ok: true, ... } | { ok: false, error: ... }`). Larger break than is justified here.
- No schema versioning meta. No client uses it today.
- No removal of `tokenEstimate` — derivable but cheap and useful.

## Architecture

### File/module layout

```text
src/schemas/
  index.ts          barrel re-exports of tool input/output schemas
  fields.ts         primitive builders: Path, Sha256Hex, IsoDateTime,
                    NonNegInt, PositiveInt, FileType, ErrorCodeEnum,
                    StoppedReason
  shared.ts         composite shapes: FileInfo, Error, OperationSummary,
                    SearchSummary, ReadResult, ReadRange (head/tail/range)
  pagination.ts     cursor + nextCursor primitives + format docs
  inputs/           one file per tool input schema (read.ts, ls.ts, ...)
  outputs/          one file per tool output schema
  json-schema.ts    toToolJsonSchema(zodSchema): post-processor
                    - strips `pattern` from date-time formats
                    - injects oneOf where Zod can't natively express it
                    - returns Standard Schema for registerTool

src/schemas.ts      legacy barrel — re-exports from src/schemas/index.ts
                    until step 3 of rollout completes, then deleted
```

### Why this shape

- `fields.ts` and `shared.ts` get `.meta({ id: '...' })` registered so Zod v4 emits them as `$defs/$ref` in JSON Schema. FileInfo/Error/datetime stop duplicating within each tool's schema.
- Per-tool `inputs/` / `outputs/` files keep each schema ~20–60 lines and self-contained. Adding a tool touches 2 small files, not a 900-line monolith.
- `json-schema.ts` is the only place doing post-processing. Tools don't call it; the registration helper does.
- The transitional re-export shim in `src/schemas.ts` means we don't churn ~20 import sites in a single commit.

### MCP-protocol caveat

Zod v4's `$defs` lives inside each individual JSON Schema (per tool), not globally across `tools/list`. Cross-tool repetition (FileInfo appearing in both `stat.outputSchema` and `stat_many.outputSchema`) is unavoidable without a protocol-level shared `$defs`, which MCP doesn't define. The within-tool dedup is still the dominant win — `stat_many.results[]` repeats FileInfo on every element.

## Field & shared-shape builders

### `src/schemas/fields.ts`

```ts
// Replaces z.iso.datetime() — keeps `format: date-time`, drops the
// 340-char regex Zod v4 emits by default. Validators that honor `format`
// still work; strict-pattern validators stop bloating tools/list.
export const IsoDateTime = z
  .string()
  .meta({ id: 'IsoDateTime', format: 'date-time' });

export const Sha256Hex = z
  .string()
  .regex(/^[a-f0-9]{64}$/u)
  .meta({ id: 'Sha256Hex' });

export const NonNegInt = z.int().min(0).meta({ id: 'NonNegInt' });
export const PositiveInt = z.int().min(1).meta({ id: 'PositiveInt' });

export const FileType = z
  .enum(['file', 'directory', 'symlink', 'other'])
  .meta({ id: 'FileType' });

export const StoppedReason = z
  .enum(['maxResults', 'maxFiles', 'maxEntries', 'timeout', 'aborted'])
  .meta({ id: 'StoppedReason' }); // unified across ls/find/grep/s&r

export const ErrorCodeEnum = z.enum(ErrorCode).meta({ id: 'ErrorCodeEnum' });
```

### `src/schemas/shared.ts`

```ts
export const FileInfo = z
  .strictObject({
    /* ... */
  })
  .meta({ id: 'FileInfo' });
export const Error = z
  .strictObject({
    code: ErrorCodeEnum,
    message: z.string(),
    path: z.string().optional(),
    suggestion: z.string().optional(),
  })
  .meta({ id: 'Error' });
export const OperationSummary = z
  .strictObject({
    /* ... */
  })
  .meta({ id: 'OperationSummary' });
export const SearchSummary = z
  .strictObject({
    /* ... */
  })
  .meta({ id: 'SearchSummary' });
export const ReadResult = z
  .strictObject({
    /* ... */
  })
  .meta({ id: 'ReadResult' });
```

## Concrete refinement catalog

### Wire-size & dedup

| #   | Change                                                                                                                    | Rationale                                                                                     |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | Replace `z.iso.datetime()` with `IsoDateTime` field (format-only)                                                         | Strips ~340-char pattern × 9+ occurrences                                                     |
| 2   | Drop `maximum: 9007199254740991` from count fields by overriding meta                                                     | `Number.MAX_SAFE_INTEGER` cap is implicit; emitting it on every counter is noise              |
| 3   | Hoist `FileInfo`, `Error`, `ErrorCodeEnum`, `ReadResult`, `OperationSummary`, `SearchSummary` to `$defs` via registry IDs | Within-tool dedup; meaningful size reduction on `stat_many`, `read_many`, `mv`, `s&r` outputs |
| 4   | Unified `StoppedReason` enum across `ls`/`find`/`grep`/`s&r`                                                              | Three enums collapse to one `$ref`                                                            |

### Client UX & accuracy

| #   | Change                                                                                                                                                                       | Rationale                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 5   | `ok: z.literal(true)` everywhere on success-only output schemas (currently inconsistent on `edit`/`mv`/`apply_patch`)                                                        | Fixes the discriminator — clients can rely on `ok === true`                                  |
| 6   | `oneOf` on `read`/`read_many` for read-mode (`head` ⊕ `tail` ⊕ `range`)                                                                                                      | Clients can validate before submit; `superRefine` stays as belt-and-suspenders runtime check |
| 7   | `examples` on ~12 high-value fields: glob patterns (`pattern`, `filePattern`), `path`, `paths`, `searchPattern`, `replacement`, `edits[].oldText`, `cursor`                  | Discoverable idiomatic usage                                                                 |
| 8   | Tighten "always-set" output fields to required: `read.path`, `write.path`, `mkdir.paths`, `mv.destination`, `rm.path`, `stat.info`, `read_many.results`, `stat_many.results` | Eliminates pointless null-checks on the client                                               |
| 9   | Validate `grep.pattern` as a parsable RE2 regex when `isRegex=true` (via `.refine`)                                                                                          | Catch bad regex at parse time, not midway through scanning                                   |

### Cross-tool consistency

| #   | Change                                                                                                                    | Rationale                                           |
| --- | ------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| 10  | Centralize `includeHidden` / `includeIgnored` / `includeSymlinkTargets` defaults & descriptions in `shared.ts`            | Used in 6 schemas; descriptions currently drift     |
| 11  | Centralize `maxDepth` / `maxEntries` / `maxResults` field builders with validators                                        | Bounds & messages currently re-typed in each schema |
| 12  | Pagination contract documented: `cursor` + `nextCursor` get a shared description ("opaque base-64 JSON; treat as opaque") | Removes the implicit-format issue                   |

### API contract cleanup (breaking)

| #   | Change                                                        | Rationale                                         |
| --- | ------------------------------------------------------------- | ------------------------------------------------- |
| 13  | `mv`: drop `source`. `sources: array, min:1` becomes required | Removes dual-path superRefine, simplifies handler |
| 14  | `mkdir`: drop `path`. `paths: array, min:1` becomes required  | Same as above                                     |

The package version is intentionally not bumped.

## Migration mechanics for breaking changes

### Handler-side

- `src/tools/move-file.ts`: drop the `superRefine` mutual-exclusion logic. Schema is flat — `sources: array.min(1)`, `destination: string`. Always iterate `sources`. Single-path callers send `[path]`; the array form already handles N=1 correctly today.
- `src/tools/create-directory.ts`: same pattern. Drop the dual-path branch. Always iterate `paths`.

### Output schemas

- `MoveFileOutputSchema`: drop `source` (string), keep `sources` (array). `destination` becomes required.
- `CreateDirectoryOutputSchema`: drop `path`, keep `paths` (always present, always an array).

### Tests

- Extend `__tests__/contract.test.ts` to assert: schemas no longer contain `source` / `path` singulars on `mv` / `mkdir`, and `oneOf` is present on `read` / `read_many`.
- Grep for any test that calls `mv` with `source:` or `mkdir` with `path:` and rewrite to array form.

### Docs

The autogenerated tool docs (`internal://` resources) pick up new descriptions automatically since they're driven by `ToolContract.description` / `nuances` / `gotchas`. No separate doc fix needed.

## Testing strategy

Three layers — first two are existing, third is new:

1. **Existing contract test** (`__tests__/contract.test.ts`) — extend with assertions for: `ok` literal true on success outputs, `oneOf` on read modes, `deprecated` removed (post-cleanup), `$defs` keys present on tools that share types.
2. **Existing tool tests** — most should pass unchanged. `mv` / `mkdir` tests need rewrites (covered above).
3. **NEW: schema snapshot test** (`__tests__/schemas-snapshot.test.ts`) — for each tool in `ALL_TOOLS`, run `z.toJSONSchema(...)` through `toToolJsonSchema(...)` and snapshot the output. Catches accidental wire-format regressions, and makes the size win measurable for the PR description.

### Verification before declaring done

- `node scripts/tasks.mjs` (full lint + type-check + knip + test + build).
- `npm run inspector` and pull `tools/list`. Eyeball that `$defs` look right, datetime regex is gone, `oneOf` renders on `read`.
- Diff inspector output against the original `tools-schema.md` reference paste to confirm bytes-saved is real and shape changes are only the intended ones.

## Rollout order

Land as **one PR** but in a commit sequence that reads top-to-bottom:

1. Create `src/schemas/{fields,shared,enums,pagination}.ts`. No tool changes — pure additive.
2. Add `src/schemas/json-schema.ts` post-processor + plumb into `registerStandardTool`. Schemas still come from old `schemas.ts`. Build passes; snapshots stabilize.
3. Migrate tool input/output schemas to the new builders, file-by-file under `src/schemas/inputs/` and `src/schemas/outputs/`. `schemas.ts` becomes a thin re-export shim.
4. Land breaking changes (`mv` source removal, `mkdir` path removal). Update handlers, tests, contract test.
5. Delete `src/schemas.ts` once all import sites are updated.

Steps 1–3 are non-breaking and can ship independently if split is preferred. Step 4 is the only behavior-affecting commit.
