# `edit` Tool Redesign — Unified Single & Multi-File Edits

**Status:** Approved design
**Date:** 2026-05-11
**Scope:** `src/tools/edit-file.ts` → `src/tools/edit.ts`; removal of `diff_files` and `apply_patch`.

---

## 1. Motivation

The current `edit` tool only handles a single file per call. The `diff_files` + `apply_patch` pair was added to fill the multi-file gap, but the unified-diff round-trip is lossy (whitespace/context drift causes hunk rejection) and the format is awkward for LLMs to generate reliably.

Goals:

1. Give `edit` the same single/multi-file ergonomics that `read` already has.
2. Replace the `diff_files` → `apply_patch` workflow with structured `{oldText, newText}` edits across multiple files.
3. Cap the multi-file batch at a size the LLM can reason about reliably.
4. Remove the now-redundant `diff_files` and `apply_patch` tools.

Breaking changes are acceptable.

## 2. Tool Shape

### 2.1 Input — exactly one of `path` / `paths` / `files`

```jsonc
// Single file
{ "path": "src/foo.ts", "edits": [{ "oldText": "...", "newText": "..." }] }

// Multi-file, same edits applied to every file (max 5)
{ "paths": ["src/a.ts", "src/b.ts"], "edits": [...] }

// Multi-file, independent edits per file (max 5) — replaces apply_patch
{ "files": [
    { "path": "src/a.ts", "edits": [...] },
    { "path": "src/b.ts", "edits": [...] }
] }
```

Shared top-level options: `dryRun`, `ignoreWhitespace`.

Validation (Zod `superRefine`):

- Exactly one of `path` / `paths` / `files` must be present.
- `paths.max(5)` and `files.max(5)` enforced at schema level — invalid requests fail validation, not mid-execution.
- `edits.min(1)` for single and shared-edit modes; each entry in `files[]` independently requires `edits.min(1)`.

### 2.2 Output

```jsonc
{
  "ok": true,

  // Single-file fields — populated when `path` was used (or single result from paths/files):
  "path", "size", "lineCount", "mimeType", "kind", "resourceUri", "modified",
  "appliedEdits", "linesAdded", "linesRemoved", "diff", "unmatchedEdits", "lineRange",

  // Multi-file fields — populated when `paths`/`files` was used:
  "results": [ /* per-file struct, same shape as single-file output minus `ok` */ ],
  "failures": [{ "path": "…", "error": { "code", "message", "suggestion" } }],
  "summary": { "total": 3, "succeeded": 2, "failed": 1 }
}
```

`results[]` preserves input order. `failures[]` carries hard errors (denied path, file too large, I/O failure). A file with edits applied but some `oldText` strings missing appears in `results[]` with `unmatchedEdits` populated — it is **not** a failure.

### 2.3 Summary line (text content)

Multi-file, basename only, input order:

```text
edit: index.ts +120 -87 · server.ts +1 -50 · README.md +50 -0
```

With mixed outcomes:

```text
edit: a.ts +5 -2 · b.ts NO MATCH · c.ts FAILED (1/3 ok)
```

Markers:

- `+A -B` — file modified, A lines added, B removed.
- `NO MATCH` — file loaded successfully but every `oldText` failed to match (file unchanged on disk).
- `FAILED` — hard error (invalid path, too large, I/O, etc.); see `failures[]` for details.
- `(n/N ok)` — appended only when at least one entry is not `+A -B`.

Single-file summary (unchanged convention):

```text
edit: foo.ts +12 -3 · 1.4 KB · 87 lines
```

## 3. Semantics

### 3.1 Per-file processing

For each file:

1. Validate path + check size limit (`MAX_TEXT_FILE_SIZE`).
2. Load content; detect MIME / kind.
3. Apply `edits[]` sequentially — each operates on the previous edit's output.
4. For each edit, find first match (`indexOf`, or whitespace-tolerant regex when `ignoreWhitespace=true`); unmatched entries collected into `unmatchedEdits[]` without aborting later edits.
5. If `appliedEdits > 0` and not `dryRun`: `atomicWriteFile`.
6. Build per-file result, including unified diff (jsdiff `createTwoFilesPatch`, worker-offloaded above threshold) and store edited content in resource store.

### 3.2 Failure isolation

Files are processed in parallel via `processInParallel(files, runOne, PARALLEL_CONCURRENCY, signal)`. A failure in one file never affects another. Each per-file runner catches its own errors and returns a tagged result (`{kind: 'ok' | 'failed', ...}`); the dispatcher aggregates.

### 3.3 Match modes

Only two — same as today:

- Exact `indexOf` (default).
- `ignoreWhitespace: true` — escape regex, collapse `\s+`, RE2 cached per `oldText`.

No fuzz factor, no `replaceAll`, no patch-format input. Callers needing bulk regex replacement use `replace-in-files`.

### 3.4 `dryRun`

Applies to every file in the batch. No writes occur. Each `results[]` entry contains a `diff` field. Resource store still receives the hypothetical edited content (callers can inspect it via `resourceUri`).

### 3.5 Resource store

- Single-file success → top-level `resourceUri` + one resource link.
- Multi-file success → each entry in `results[]` carries its own `resourceUri`; the tool response includes a `resources[]` array (via `buildResourceResponse`) with one link per modified file.

## 4. File Layout

Single file: [src/tools/edit.ts](src/tools/edit.ts) (renamed from `src/tools/edit-file.ts`). Logical sections, top to bottom:

1. Imports.
2. Zod input + output schemas, `EditInput` / `EditOutput` types.
3. Match helpers — `escapeRegExp`, `findEditMatch`, `replaceEditMatch`, `mergeLineRange`, line counters.
4. `applyEdits()` — pure sequential edit application.
5. `buildDiff()` — jsdiff with worker offload above size threshold.
6. `runOneFile()` — load → apply → write → build per-file result (used by both single and multi-file dispatch).
7. Dispatch helpers — `dispatchSingle`, `dispatchMulti` (handles both `paths[]` and `files[]` by normalizing into a list of `{path, edits}` jobs).
8. Summary formatters — `formatSingleSummary`, `formatMultiSummary`, `formatFileToken` (`+A -B` / `NO MATCH` / `FAILED`).
9. `progressLabel()`.
10. `export const EDIT = defineTool({...})`.

Tool `name` stays `edit`. `defineTool.title` updated to `Edit Files`.

## 5. Removals

Delete the following:

- `src/tools/diff-files.ts`
- `src/tools/apply-patch.ts`
- `__tests__/tools/diff.test.ts` (the `apply_patch` half) — split or remove as needed; pure `structuredPatch` coverage in `__tests__` is keepable if it tests the diff library directly.
- Import lines in `src/tools.ts` for `apply-patch` and `diff-files`.
- Schema entries for `apply_patch` and `diff_files` in `__tests__/schemas/__snapshots__/tool-schemas.json`.
- Any references in `src/resources/` instructions, `src/prompts.ts`, `README.md`, and `AGENTS.md` / `CLAUDE.md`.

`replace-in-files` stays — distinct niche (glob-driven regex bulk replacement).

## 6. Migration Path

Callers using `diff_files` + `apply_patch` translate to one `edit` call:

```jsonc
// Before
diff_files({ original: "a.ts.orig", modified: "a.ts" }) → patch
apply_patch({ patch })

// After
edit({
  files: [{ path: "a.ts", edits: [{ oldText: "…", newText: "…" }] }]
})
```

For multi-file patches with `a/`/`b/` headers:

```jsonc
edit({
  files: [
    { path: "a.ts", edits: [...] },
    { path: "b.ts", edits: [...] }
  ]
})
```

Documented in the tool description and in instructions.

## 7. Testing

- Reuse and rename `__tests__/tools/read-write.test.ts` edit cases (no rename needed — the file covers both).
- Add multi-file tests:
  - `paths[]` shared edits — success, partial unmatched, mixed success/fail.
  - `files[]` per-file edits — independent failures don't affect siblings.
  - Cap enforcement — `paths` / `files` with 6 entries rejected at validation.
  - Mutually exclusive — `{path, paths}`, `{path, files}`, `{paths, files}` rejected.
  - `dryRun` across multi-file — no writes occur, diffs populated.
- Update schema snapshot for `edit` and remove `apply_patch` + `diff_files` entries.

## 8. Out of Scope

- Fuzzy matching / context tolerance.
- `replaceAll` per edit.
- Patch-format input (unified diff).
- Cross-file transactional rollback.
- Concurrency tuning beyond the existing `processInParallel` semantics.

## 9. Open Questions

None at design-approval time.
