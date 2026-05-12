# Design: Smoke Test UX Fixes

**Date:** 2026-05-12
**Status:** Approved
**Scope:** Four targeted fixes to `replace_text`, `search_text`, and `delete` tools based on smoke test findings.

---

## Context

A smoke test run surfaced four UX issues where tool behavior diverged from reasonable caller expectations:

1. `replace_text` defaults `dryRun=true` — callers must pass `dryRun=false` explicitly to apply changes.
2. `search_text` (and `replace_text`) glob `pattern` doesn't recurse — `*.ts` matches only the root directory, not subdirectories.
3. `delete` partial failure returns `ok: true` with a `failures[]` array — callers checking `ok` alone miss per-path errors.
4. `replace_text` passed a file path finds 0 matches — `globEntries` is called with the file as `cwd`, returning nothing.

No backwards compatibility constraints apply. Breaking changes are acceptable.

---

## Change 1 — `replace_text`: flip `dryRun` default to `false`

**File:** `src/tools/replace-in-files.ts`

### Problem

`dryRun` defaults to `true`, so `replace_text` never writes by default. The summary text says `[dry run]` but callers often miss this and wonder why nothing changed.

### Solution

- Change `dryRun: z.boolean().optional().default(true)` → `.default(false)`.
- Remove the "Always `dryRun:true` first" sentence from the tool description.
- Add a note that `returnDiff: true` can be used to get a preview diff without blocking writes.

### Invariant preserved

`dryRun: true` continues to work identically for callers who opt in explicitly.

---

## Change 2 — Glob pattern recursion: `baseNameMatch: true`

**Files:** `src/tools/replace-in-files.ts`, `src/tools/search-content.ts`

### Problem

Both tools use `baseNameMatch: false` in their `globEntries` call. In fast-glob, a pattern like `*.ts` without `baseNameMatch` only matches files directly in the root directory — it does not recurse. Callers writing `*.ts` expect all `.ts` files in the tree.

### Solution

Set `baseNameMatch: true` in both tools' glob calls:

- `replace-in-files.ts`: change `baseNameMatch: false` → `true` in the `globEntries` options.
- `search-content.ts`: change `baseNameMatch: false` → `true` in `SEARCH_CONTENT_DEFAULTS`.

With `baseNameMatch: true`, fast-glob tests patterns that contain no `/` against each file's **basename** rather than its full path. Effect: `*.ts` matches any `.ts` file at any depth. Patterns with a `/` (e.g. `src/*.ts`, `**/*.test.ts`) are unaffected.

No schema change — `pattern` field is unchanged; normalization happens inside the glob call.

### Gotcha to add (both tools)

> Patterns without `/` match by filename anywhere in the tree (e.g. `*.ts` finds all `.ts` files). Add a path prefix like `src/*.ts` to restrict to a subtree.

---

## Change 3 — `delete`: `ok: false` on total failure

**File:** `src/tools/delete-file.ts`

### Problem

`DeleteOutputSchema` declares `ok: z.literal(true)`, so the field is always `true` even when paths fail. Callers checking `ok` alone cannot detect failure.

### Solution

- Change `ok: z.literal(true)` → `ok: z.boolean()` in `DeleteOutputSchema`.
- In `handleDelete`, compute `ok` as: `successPaths.length > 0 || (args.paths.length === 0)`.
  - At least one path succeeded → `ok: true`
  - Zero successes (all failed) → `ok: false`
- The `failures[]` array continues to carry per-path detail regardless of `ok`.
- No change to summary text formatting in `run`.

### Gotcha to add

> `ok: false` only when **every** path failed. Partial failures still return `ok: true` — always check `failures[]` for per-path errors.

---

## Change 4 — `replace_text`: auto-handle file paths

**File:** `src/tools/replace-in-files.ts`

### Problem

`resolveSearchRoot` returns the validated path as `cwd` for `globEntries`. When the caller passes a file path, `globEntries` receives a file as its `cwd` and returns no entries, producing 0 matches with no error.

### Solution

Extend `resolveSearchRoot` (or its call site in `handleSearchAndReplace`) to `stat` the resolved path after validation:

- **If it is a directory:** behavior unchanged — use it as `root`, use `args.pattern ?? '**/*'` as the glob pattern.
- **If it is a file:** use `dirname(resolvedPath)` as `root` and `globEscape(basename(resolvedPath))` as the effective glob pattern, ignoring `args.pattern`.

`globEscape` escapes glob-special characters (`[`, `]`, `{`, `}`, `(`, `)`, `!`, `*`, `?`) in the basename so filenames like `[utils].ts` are treated as literals.

The return type of `resolveSearchRoot` changes from `Promise<string>` to `Promise<{ root: string; filePattern: string }>`. The caller destructures both fields.

### Gotcha to add

> Passing a file path auto-scopes the search to that single file. To combine a directory scope with a glob filter, pass the directory as `path` and use the `pattern` field.

---

## Files changed summary

| File                            | Changes                                                                       |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `src/tools/replace-in-files.ts` | `dryRun` default, `baseNameMatch`, file-path auto-detect, description/gotchas |
| `src/tools/search-content.ts`   | `baseNameMatch` in defaults, gotcha                                           |
| `src/tools/delete-file.ts`      | `ok` schema type, `ok` computation in `handleDelete`, gotcha                  |

## Out of scope

- Changes to tests (test updates follow as a separate step).
- Any other tools not mentioned in the smoke test report.
- Backwards-compatibility shims or feature flags.
