# Plan: Collapse six duplicated domain rules into their owning core modules

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `eb0502f`, 2026-08-20.
> **Drift check (run first)**: `git diff --stat eb0502f..HEAD -- src/core/errors.ts src/core/search.ts src/core/path.ts src/core/glob.ts src/core/path-completer.ts src/core/registrar.ts src/tools/edit.ts src/tools/replace-in-files.ts src/tools/search-content.ts src/tools/search-files.ts src/tools/list.ts src/tools/delete-file.ts`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

Six domain rules are duplicated across the search-style tools and the path
listers; each drifts independently and the security-sensitive ones (R2, R6)
open holes when they do. This plan moves each rule to its owning core module
and deletes the copies. Every move is net-deletion. Requirements covered:
[`R1`](arch-refactor.spec.md#requirements), [`R2`](arch-refactor.spec.md#requirements),
[`R3`](arch-refactor.spec.md#requirements), [`R5`](arch-refactor.spec.md#requirements),
[`R6`](arch-refactor.spec.md#requirements). R4 was dropped — see
[Notes](#notes).

## Current state

Conventions to match (one exemplar each):

- zod schemas live in `src/core/schema.ts`; a schema helper looks like
  [`defaultFalseBoolean`](../../../src/core/schema.ts) — `z.boolean()` with a
  `.describe()` and `.default(false)`. Import zod as `import * as z from 'zod/v4'`.
- error helpers live in [`src/core/errors.ts`](../../../src/core/errors.ts);
  `isNodeError` at [`errors.ts:321`](../../../src/core/errors.ts#L321) is the
  shape to imitate for `isNotFoundErrno`.
- `PathGuard` methods in [`src/core/path.ts`](../../../src/core/path.ts) use
  `private`/`async`, call `this.sensitive`, `this.validateExistingPathDetailed`,
  `isPathWithinDirectories`. `EntryType` is imported from
  [`primitives.ts:17`](../../../src/core/primitives.ts#L17) (already re-exported
  by `glob.ts`).
- tests: `__tests__/unit/*.test.ts` for core, `__tests__/tools/*.test.ts` for
  tools. Imitate [`__tests__/unit/errors.test.ts`](../../../__tests__/unit/errors.test.ts)
  for a unit test of an `errors.ts` helper.

Facts, inlined:

- [`src/core/search.ts:123`](../../../src/core/search.ts#L123) and
  [`src/core/search.ts:291`](../../../src/core/search.ts#L291) — two inline
  `stoppedReason?: 'timeout' | 'maxResults'` type literals. The compute is
  duplicated at [`search.ts:248-253`](../../../src/core/search.ts#L248-L253)
  and [`search.ts:328-333`](../../../src/core/search.ts#L328-L333):
  ```ts
  const hitMaxResults = matches.length >= maxResults;
  const stoppedReason = hitMaxResults
    ? 'maxResults'
    : counters.stoppedByAbort
      ? 'timeout'
      : undefined;
  ```
- [`src/tools/replace-in-files.ts:140-145`](../../../src/tools/replace-in-files.ts#L140-L145) —
  `z.enum(['maxResults','maxFiles','timeout'])` output field; mapping at
  [`replace-in-files.ts:658-663`](../../../src/tools/replace-in-files.ts#L658-L663)
  from `processEntriesConcurrently` booleans. The `ReplaceSummary.stoppedReason`
  type literal at [`replace-in-files.ts:521`](../../../src/tools/replace-in-files.ts#L521).
- [`src/tools/search-content.ts:146-151`](../../../src/tools/search-content.ts#L146-L151) —
  `z.enum(['maxResults','timeout'])`; `stoppedReason` arrives from
  `searchContent()` (core), spread at
  [`search-content.ts:70`](../../../src/tools/search-content.ts#L70).
- [`src/tools/search-files.ts:67-72`](../../../src/tools/search-files.ts#L67-L72) —
  `z.enum(['maxResults','timeout'])`; summary spread at
  [`search-files.ts:111-117`](../../../src/tools/search-files.ts#L111-L117).
- [`src/core/glob.ts:35-64`](../../../src/core/glob.ts#L35-L64) —
  `isEntryAccessibleByType` recomposes containment + sensitivity on requested
  AND resolved, with a symlink branch; `pathGuard.isSensitive` is a pass-through
  to `SensitiveMatcher`. The same composition is owned privately by
  `PathGuard.validateAccessAndSensitivity` at
  [`path.ts:626-634`](../../../src/core/path.ts#L626-L634).
- [`src/core/path.ts:257-270`](../../../src/core/path.ts#L257-L270) —
  `resolveRealPath(normalized, signal)` (module-private): realpath →
  `normalizeAllowedDirectory`, returns `null` on ENOENT, rethrows others.
  Used only at [`path.ts:276`](../../../src/core/path.ts#L276).
- [`src/core/path-completer.ts:108-123`](../../../src/core/path-completer.ts#L108-L123) —
  `isAllowedCompletionDirectory`: `isPathWithinDirectories(path, allowed)` →
  `stat`+`realpath` → `isPathWithinDirectories(normalizePath(real), allowed)`,
  suppresses ENOENT and EACCES → `false`.
- [`src/core/registrar.ts:46-59`](../../../src/core/registrar.ts#L46-L59) —
  `resolveRealPathIfExists`: realpath → `normalizePath` → returns real only if
  `!isSamePath(real, normalized)`, suppresses everything → `null`. Comment at
  [`registrar.ts:34`](../../../src/core/registrar.ts#L34) notes it "relocated
  from path.ts".
- [`src/tools/replace-in-files.ts:539-559`](../../../src/tools/replace-in-files.ts#L539-L559) —
  `resolveSearchRoot`; single-file branch at
  [`replace-in-files.ts:548-557`](../../../src/tools/replace-in-files.ts#L548-L557)
  bypasses glob. Exclude-pattern line at
  [`replace-in-files.ts:604`](../../../src/tools/replace-in-files.ts#L604).
- [`src/tools/search-content.ts:350-351`](../../../src/tools/search-content.ts#L350-L351) —
  `fs.pathGuard.validateExistingDirectory(fs.pathGuard.resolvePathOrRoot(args.path))`.
- [`src/tools/search-files.ts:131-134`](../../../src/tools/search-files.ts#L131-L134) —
  same `validateExistingDirectory(resolvePathOrRoot(...))` + `excludePatterns`.
- [`src/tools/list.ts:94-104`](../../../src/tools/list.ts#L94-L104) —
  `globEntries` with `excludePatterns: options.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS`.
- [`src/tools/edit.ts:349-360`](../../../src/tools/edit.ts#L349-L360) — `buildDiff`:
  `setImmediate` + `createTwoFilesPatch(fileName, fileName, original, modified, 'Original','Modified',{callback})` → `Promise<string>`.
- [`src/tools/replace-in-files.ts:404-421`](../../../src/tools/replace-in-files.ts#L404-L421) —
  `maybeAppendPatchDiff`: same `setImmediate`+`createTwoFilesPatch` shape.
- ENOENT literal sites (five — all read
  `isNodeError(error) && error.code === 'ENOENT'`):
  [`path.ts:65`](../../../src/core/path.ts#L65),
  [`path.ts:267`](../../../src/core/path.ts#L267),
  [`path.ts:698`](../../../src/core/path.ts#L698),
  [`delete-file.ts:173`](../../../src/tools/delete-file.ts#L173),
  [`delete-file.ts:204`](../../../src/tools/delete-file.ts#L204).
  `isNodeError` is imported from `../core/errors.js` at the tool site and from
  `./errors.js` in core. Note:
  [`glob.ts:60`](../../../src/core/glob.ts#L60) is
  `isNodeError(error) && error.code !== undefined && SKIPPABLE_ERRNOS.has(error.code)`
  — NOT an `=== 'ENOENT'` literal, not migrated by R6 (ENOENT is already
  covered by `SKIPPABLE_ERRNOS`).

## Commands

| Purpose   | Command                          | Expected on success      |
| --------- | -------------------------------- | ------------------------ |
| Typecheck | `node scripts/tasks.mjs --quick` | `4/4 passed (2 skipped)` |
| Tests     | `node scripts/tasks.mjs`         | `6/6 passed`             |

Baseline at `eb0502f`: both green.

## Scope

**In scope** — the only files to modify:

- [`src/core/errors.ts`](../../../src/core/errors.ts) (R6)
- [`src/core/diff.ts`](../../../src/core/diff.ts) (R5 — new file)
- [`src/core/search.ts`](../../../src/core/search.ts) (R1)
- [`src/core/path.ts`](../../../src/core/path.ts) (R2, R3)
- [`src/core/glob.ts`](../../../src/core/glob.ts) (R2)
- [`src/core/path-completer.ts`](../../../src/core/path-completer.ts) (R3)
- [`src/core/registrar.ts`](../../../src/core/registrar.ts) (R3)
- [`src/tools/edit.ts`](../../../src/tools/edit.ts) (R5)
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts) (R1, R5)
- [`src/tools/search-content.ts`](../../../src/tools/search-content.ts) (R1)
- [`src/tools/search-files.ts`](../../../src/tools/search-files.ts) (R1)
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts) (R6)
- test files under `__tests__/` for the new helpers (one per new core export)

**Files out of scope** — leave alone even though they look related:

- [`src/tools/calculate-hash.ts`](../../../src/tools/calculate-hash.ts) — its
  `pathGuard.isSensitive(entry.path)` at :165 is a correct bare-sensitive skip,
  not a containment recomposition (R2 does not apply; spec Out-of-scope).
- [`src/core/schema.ts`](../../../src/core/schema.ts) — R1's schema goes in
  `search.ts` next to the tracker, not the zod-only `schema.ts`, to keep the
  concept in one module. `schema.ts` imports `path.ts` already; do not create a
  `search.ts` ↔ `schema.ts` cycle.
- [`src/core/fs.ts`](../../../src/core/fs.ts) — `GuardedFileSystem.pathGuard`
  public field is intentional DI composition, not a refactor target.
- [`src/tools/list.ts`](../../../src/tools/list.ts) — R2's delegate keeps the
  `isEntryAccessibleByType` signature, so the call at
  [`list.ts:123`](../../../src/tools/list.ts#L123) is unchanged. R4 (which would
  have touched it) is dropped.
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts)
  `resolveSearchRoot` — R4 dropped; the single-file branch is a single-consumer
  variation, no seam. Leave it.

## Steps

### 1. R6 — `isNotFoundErrno` in `errors.ts`, migrate six sites

Add to [`src/core/errors.ts`](../../../src/core/errors.ts) near `isNodeError`
([`errors.ts:321`](../../../src/core/errors.ts#L321)):

```ts
/** True when `error` is a Node errno error with code `ENOENT` (path not found). */
export function isNotFoundErrno(error: unknown): boolean {
  return isNodeError(error) && error.code === 'ENOENT';
}
```

Replace `isNodeError(error) && error.code === 'ENOENT'` with `isNotFoundErrno(error)`
at the six sites: [`path.ts:65`](../../../src/core/path.ts#L65),
[`path.ts:267`](../../../src/core/path.ts#L267),
[`path.ts:698`](../../../src/core/path.ts#L698),
[`delete-file.ts:173`](../../../src/tools/delete-file.ts#L173),
[`delete-file.ts:204`](../../../src/tools/delete-file.ts#L204),
[`glob.ts:60`](../../../src/core/glob.ts#L60) (note: glob.ts:60 is
`error.code !== undefined && SKIPPABLE_ERRNOS.has(error.code)` — that is NOT the
ENOENT literal; leave it. Only the five `=== 'ENOENT'` sites change). Add
`isNotFoundErrno` to the `errors.js` import list in `path.ts` and
`delete-file.ts`; `glob.ts` does not change (no `=== 'ENOENT'` literal there
after re-check — confirm during edit).

Add a unit test in [`__tests__/unit/errors.test.ts`](../../../__tests__/unit/errors.test.ts)
covering: ENOENT → true, EACCES → false, non-Error → false, `AbortError` → false.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`.

### 2. R5 — `buildPatchDiff` in new `src/core/diff.ts`, migrate `edit.ts` + `replace-in-files.ts`

Create [`src/core/diff.ts`](../../../src/core/diff.ts):

```ts
import { createTwoFilesPatch } from 'diff';

/**
 * Build a unified two-file patch on the event loop (deferred via setImmediate
 * so a large diff never blocks). `label` is used as both the old and new file
 * header. Resolves to '' if the diff library returns undefined.
 */
export function buildPatchDiff(label: string, original: string, modified: string): Promise<string> {
  return new Promise<string>((resolve) => {
    setImmediate(() => {
      createTwoFilesPatch(label, label, original, modified, 'Original', 'Modified', {
        callback: (res: string | undefined) => {
          resolve(res ?? '');
        },
      });
    });
  });
}
```

In [`src/tools/edit.ts`](../../../src/tools/edit.ts): drop the `createTwoFilesPatch`
import (keep `diffLines` if still used elsewhere — check
[`edit.ts:6`](../../../src/tools/edit.ts#L6)); import `buildPatchDiff` from
`../core/diff.js`; replace the body of `buildDiff`
([`edit.ts:349-360`](../../../src/tools/edit.ts#L349-L360)) with:

```ts
async function buildDiff(validPath: string, original: string, modified: string): Promise<string> {
  return buildPatchDiff(basename(validPath), original, modified);
}
```

(If `buildDiff` then only delegates, inline it at its single call site and
delete the function — confirm the call site count first.)

In [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts):
drop `createTwoFilesPatch` from the `diff` import
([`replace-in-files.ts:7`](../../../src/tools/replace-in-files.ts#L7)); import
`buildPatchDiff`; in `maybeAppendPatchDiff`
([`replace-in-files.ts:404-421`](../../../src/tools/replace-in-files.ts#L404-L421))
replace the `new Promise`+`setImmediate`+`createTwoFilesPatch` block with:

```ts
const patch = await buildPatchDiff(header, params.originalContent, params.updatedContent);
```

Keep the size-budget append loop below it unchanged.

Add `__tests__/unit/diff.test.ts`: `buildPatchDiff` returns a string containing
`---`/`+++` headers and the changed line for a known original/modified pair;
resolves to a non-empty string for identical inputs (the library emits a
no-op patch) — assert it does not throw and returns a string.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`.

### 3. R1 — `StoppedReason` + tracker in `search.ts`, migrate three tools

Add to [`src/core/search.ts`](../../../src/core/search.ts) (add `import * as z from 'zod/v4'` at the top — `search.ts` does not currently import zod; no cycle, `schema.ts` does not import `search.ts`):

```ts
export type StoppedReason = 'maxResults' | 'maxFiles' | 'timeout';

export const StoppedReasonSchema = z.enum(['maxResults', 'maxFiles', 'timeout']).optional();

/**
 * Accumulates why an enumeration stopped early. maxResults wins over maxFiles
 * wins over timeout (the most specific cap is the definite cause even if the
 * abort also fired on the same iteration). Call `resolve()` once at the end.
 */
export class StopReasonTracker {
  #maxResults = false;
  #maxFiles = false;
  #abort = false;
  hitMaxResults(): void {
    this.#maxResults = true;
  }
  hitMaxFiles(): void {
    this.#maxFiles = true;
  }
  hitAbort(): void {
    this.#abort = true;
  }
  get truncated(): boolean {
    return this.#maxResults || this.#maxFiles || this.#abort;
  }
  resolve(): StoppedReason | undefined {
    if (this.#maxResults) return 'maxResults';
    if (this.#maxFiles) return 'maxFiles';
    if (this.#abort) return 'timeout';
    return undefined;
  }
}
```

Replace the inline compute at [`search.ts:248-253`](../../../src/core/search.ts#L248-L253)
and [`search.ts:328-333`](../../../src/core/search.ts#L328-L333) with a
`StopReasonTracker`: set `tracker.hitMaxResults()` where `hitMaxResults` is
computed, `tracker.hitAbort()` where `counters.stoppedByAbort` is set, and
`const stoppedReason = tracker.resolve();`. Replace the two inline
`stoppedReason?: 'timeout' | 'maxResults'` literals
([`search.ts:123`](../../../src/core/search.ts#L123),
[`search.ts:291`](../../../src/core/search.ts#L291)) with `stoppedReason?: StoppedReason`.

Migrate the three tool output schemas to `StoppedReasonSchema`:

- [`replace-in-files.ts:140-145`](../../../src/tools/replace-in-files.ts#L140-L145):
  `stoppedReason: StoppedReasonSchema.describe('…existing text…')`. Import
  `StoppedReasonSchema` and `StoppedReason` from `../core/search.js` (alongside
  the existing `compileRegex`/`freeRegex` import at
  [`replace-in-files.ts:38`](../../../src/tools/replace-in-files.ts#L38)). Replace
  the `ReplaceSummary.stoppedReason` literal at
  [`replace-in-files.ts:521`](../../../src/tools/replace-in-files.ts#L521) with
  `StoppedReason | undefined`. At
  [`replace-in-files.ts:655-663`](../../../src/tools/replace-in-files.ts#L655-L663)
  keep the mapping from `stoppedByLimit/stoppedByMatchCap/stoppedByAbort` but
  assign the `StoppedReason` literals (no logic change — the union now includes
  `maxFiles` which is exactly what this tool emits).
- [`search-content.ts:146-151`](../../../src/tools/search-content.ts#L146-L151):
  `stoppedReason: StoppedReasonSchema.describe('…existing text…')`. The
  `SearchSummary.stoppedReason` type (search-content's local interface) becomes
  `StoppedReason | undefined`.
- [`search-files.ts:67-72`](../../../src/tools/search-files.ts#L67-L72):
  same. The `applySummaryFields` param at
  [`search-files.ts:111`](../../../src/tools/search-files.ts#L111) becomes
  `stoppedReason?: StoppedReason`.

Reconciliation (deliberate, record in the commit message): `search-content` and
`search-files` never emit `maxFiles`, but their output schema now advertises it
as an optional enum value. The field is optional and absent when the scan runs
to completion, so no client sees a spurious `maxFiles`. This is the one
widening the audit accepted to get a single shared schema.

Add `__tests__/unit/search.test.ts` (or extend
[`__tests__/unit/search-abort.test.ts`](../../../__tests__/unit/search-abort.test.ts))
asserting `StopReasonTracker.resolve()` precedence: maxResults > maxFiles >
timeout > undefined, and `truncated` flag.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`; the
`__tests__/schemas/__snapshots__/tool-schemas.json` snapshot updates cleanly
(run `node scripts/tasks.mjs` once and accept the snapshot diff — it will show
`maxFiles` added to the two narrower enums; confirm no other snapshot lines
change).

### 4. R3 — export `resolveRealPath`, migrate `path-completer` + `registrar`

Rename the existing module-private `resolveRealPath` at
[`path.ts:257`](../../../src/core/path.ts#L257) to `export async function
resolveRealPath(...)` (add `export`, keep signature and ENOENT-only suppression).
Its existing caller at [`path.ts:276`](../../../src/core/path.ts#L276) is
unaffected.

[`src/core/path-completer.ts`](../../../src/core/path-completer.ts): add
`resolveRealPath` to the `./path.js` import
([`path-completer.ts:6`](../../../src/core/path-completer.ts#L6) — confirm the
existing path import line). Rewrite `isAllowedCompletionDirectory`
([`path-completer.ts:108-123`](../../../src/core/path-completer.ts#L108-L123)):

```ts
async function isAllowedCompletionDirectory(path: string, allowed: string[]): Promise<boolean> {
  if (!isPathWithinDirectories(path, allowed)) return false;
  try {
    const stats = await stat(path);
    if (!stats.isDirectory()) return false;
    const real = await resolveRealPath(path);
    return real !== null && isPathWithinDirectories(real, allowed);
  } catch (err) {
    if (!isNotFoundErrno(err) && !isSkippableAccesErrno(err)) {
      Logger.debug('isAllowedCompletionDirectory: unexpected probe error', {
        path,
        error: String(err),
      });
    }
    return false;
  }
}
```

Reconciliation: `resolveRealPath` rethrows non-ENOENT errors (EACCES, EIO), but
`isAllowedCompletionDirectory` must swallow EACCES (and ENOENT) and return
`false`. The `catch` above keeps that policy — `resolveRealPath`'s ENOENT path
returns `null` (no throw) for ENOENT, and the `catch` covers EACCES/EIO from
both `stat` and `resolveRealPath`. Keep the existing EACCES/ENOENT log-suppression
behavior (use `isNotFoundErrno` from R6 and a local check for EACCES, or keep
the existing `err.code !== 'ENOENT' && err.code !== 'EACCES'` test — match
current behavior exactly). Import `isNotFoundErrno` from `./errors.js`.

[`src/core/registrar.ts`](../../../src/core/registrar.ts): add `resolveRealPath`
to the `./path.js` import. Rewrite `resolveRealPathIfExists`
([`registrar.ts:46-59`](../../../src/core/registrar.ts#L46-L59)):

```ts
async function resolveRealPathIfExists(
  normalizedPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    assertNotAborted(signal);
    const real = await resolveRealPath(normalizedPath, signal);
    if (real === null) return null;
    return isSamePath(real, normalizedPath) ? null : real;
  } catch (error) {
    rethrowIfAborted(error);
    return null;
  }
}
```

Reconciliation: `resolveRealPath` rethrows non-ENOENT; `resolveRealPathIfExists`
historically suppressed all errors → null. The `catch` above preserves that.
`isSamePath` stays imported from `./path.js`.

Add/extend a unit test in
[`__tests__/unit/path-completer.test.ts`](../../../__tests__/unit/path-completer.test.ts)
asserting `isAllowedCompletionDirectory` returns false for a non-directory and
for a path outside `allowed` (existing tests likely cover this — confirm and
avoid duplicate assertions).

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`.

### 5. R2 — `PathGuard.isEntryAccessible`, migrate `glob.ts`

Add to `PathGuard` in [`src/core/path.ts`](../../../src/core/path.ts), importing
`EntryType` from `./primitives.js` (add to the existing import at
[`path.ts:17`](../../../src/core/path.ts#L17)). The method takes the caller's
`bounds` so the containment check uses exactly the set the caller passes today
(`[rootPath]` from list.ts:123) — not `this.rootBoundaries`, which is a
different set and can be empty:

```ts
/**
 * True when `entryPath` is both within `bounds` and not sensitive, checking
 * the requested AND resolved paths. Symlinks are resolved via
 * validateExistingPathDetailed (which checks containment against
 * this.rootBoundaries internally); other types check `bounds` directly.
 * Skippable errno/fs errors return false (the entry is filtered, not fatal).
 */
async isEntryAccessible(
  entryPath: string,
  entryType: EntryType,
  bounds: readonly string[],
): Promise<boolean> {
  const isSensitive = (requestedPath: string, resolvedPath: string): boolean =>
    this.isSensitive(requestedPath) || this.isSensitive(resolvedPath);
  if (entryType !== 'symlink') {
    const normalizedPath = normalizePath(entryPath);
    if (!isPathWithinDirectories(normalizedPath, bounds)) return false;
    return !isSensitive(entryPath, normalizedPath);
  }
  try {
    const validated = await this.validateExistingPathDetailed(entryPath);
    return !isSensitive(validated.requestedPath, validated.resolvedPath);
  } catch (error) {
    if (isFsError(error)) {
      if (SKIPPABLE_FS_CODES.has(error.code)) return false;
      throw error;
    }
    if (isNodeError(error) && error.code !== undefined && SKIPPABLE_ERRNOS.has(error.code))
      return false;
    throw error;
  }
}
```

This is a line-for-line move of [`glob.ts:35-64`](../../../src/core/glob.ts#L35-L64)
into the guard — `pathGuard.isSensitive(...)` becomes `this.isSensitive(...)`,
`rootDirectories` becomes the `bounds` parameter. The error branch stays
`SKIPPABLE_ERRNOS.has(error.code)` (which already covers ENOENT) — do NOT
rewrite it to `isNotFoundErrno`, that changes nothing and adds a redundant
check. Confirm `this.isSensitive` is the public pass-through on `PathGuard`
(the original calls `pathGuard.isSensitive`); if the member is named
differently, adjust to match.

Confirm `isFsError`, `isNodeError`, `SKIPPABLE_FS_CODES`, `SKIPPABLE_ERRNOS`
are imported into `path.ts` from `./errors.js` (check
[`path.ts:8-16`](../../../src/core/path.ts#L8-L16) — the errors import block
currently has `ERRNO_MAP, ErrorCode, FsError, isFsError, isNodeError,
rethrowIfAborted`; add `SKIPPABLE_FS_CODES` and `SKIPPABLE_ERRNOS`).
`normalizePath` and `isPathWithinDirectories` are same-file.
`validateExistingPathDetailed` is the existing method at
[`path.ts:741`](../../../src/core/path.ts#L741).

Migrate [`src/core/glob.ts:35-64`](../../../src/core/glob.ts#L35-L64):
`isEntryAccessibleByType` becomes a thin delegate that forwards
`rootDirectories` as `bounds`:

```ts
export async function isEntryAccessibleByType(
  entryPath: string,
  entryType: EntryType,
  rootDirectories: readonly string[],
  pathGuard: PathGuard,
): Promise<boolean> {
  return pathGuard.isEntryAccessible(entryPath, entryType, rootDirectories);
}
```

`rootDirectories` is now used (forwarded), so no `no-unused-vars` concern. The
sole caller at [`list.ts:123`](../../../src/tools/list.ts#L123) is unchanged
(it still passes `[rootPath]`). Because `bounds` flows straight through, the
non-symlink containment check is identical to today — no divergence, no STOP.
`isPathWithinDirectories`, `normalizePath`, `isNodeError`, `isFsError`,
`SKIPPABLE_ERRNOS`, and `SKIPPABLE_FS_CODES` become unused in `glob.ts` after
this — remove them from the [`glob.ts:7-17`](../../../src/core/glob.ts#L7-L17)
imports (grep `glob.ts` for each before deleting; keep any still used elsewhere
in the file). `EntryType` and `PathGuard` stay imported.

Add a unit test in [`__tests__/unit/path-guard.test.ts`](../../../__tests__/unit/path-guard.test.ts)
for `isEntryAccessible`: a sensitive file → false; a path within `bounds` and
not sensitive → true; a symlink escaping bounds → false; an entry outside
`bounds` → false (proves `bounds`, not `rootBoundaries`, drives containment).

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`.

### 6. R4 — dropped (plan-hunt)

R4 is not executed. plan-hunt found the step self-halting as written
(`resolveSearchBase` accepts a file; `search-content` and `search-files` are
directory-only via `validateExistingDirectory` at
[`search-content.ts:350-351`](../../../src/tools/search-content.ts#L350) and
[`search-files.ts:131-132`](../../../src/tools/search-files.ts#L131), so
migrating them would change a file arg from a `NOT_DIRECTORY` error to a
silent parent-dir scan — the step's own STOP fires).

The only non-halting rescope is a directory-only `resolveSearchBase` wrapping
`pathGuard.validateExistingDirectory(pathGuard.resolvePathOrRoot(path))`. That
wraps a single expression shared by two tools — a middleman, not a seam: it
fails the net-deletion bar. `replace-in-files.ts`' `resolveSearchRoot` (the
single-file variation) is a single consumer, no seam on its own. So R4 does not
clear the bar once the dead move is removed. Dropped.

Leave [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts)
`resolveSearchRoot`, [`src/tools/search-content.ts`](../../../src/tools/search-content.ts),
[`src/tools/search-files.ts`](../../../src/tools/search-files.ts), and
[`src/tools/list.ts`](../../../src/tools/list.ts) root-resolution as-is. If a
later audit wants this seam reopened, the move is a directory-only helper in
`glob.ts` AND a decision to add single-file support to the directory-only
tools — record that in an ADR, not this plan.

## Done

Machine-checkable. All must hold:

- [ ] `node scripts/tasks.mjs --quick` exits 0 (`4/4 passed`)
- [ ] `node scripts/tasks.mjs` exits 0 (`6/6 passed`), including new tests for
      `isNotFoundErrno`, `buildPatchDiff`, `StopReasonTracker`, `isEntryAccessible`
- [ ] `git status` shows no files outside the in-scope list (plus the new
      `src/core/diff.ts` and the new/edited test files)
- [ ] No `z.enum(['maxResults'` / `['maxResults','timeout']` literal remains in
      `src/tools/*.ts` (R1): `grep -rn "enum(\['maxResults'" src/tools` → no hits
- [ ] No `=== 'ENOENT'` literal remains in `src/core/path.ts` or
      `src/tools/delete-file.ts` (R6):
      `grep -rn "=== 'ENOENT'" src/core/path.ts src/tools/delete-file.ts` → no hits
- [ ] No `setImmediate` + `createTwoFilesPatch` block remains in
      `src/tools/edit.ts` or `src/tools/replace-in-files.ts` (R5):
      `grep -rn createTwoFilesPatch src/tools` → no hits

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt (run the drift check first).
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation.
- The fix appears to require an out-of-scope file.
- **R3**: `resolveRealPath`'s ENOENT-only error suppression cannot be
  reconciled with `isAllowedCompletionDirectory`'s EACCES-suppression without
  changing observable behavior (the catch-wrap is meant to preserve it; if a
  test fails that proves the wrap is not equivalent, stop).
- **R2**: `this.isSensitive` is not the public pass-through member on
  `PathGuard` (the original `glob.ts` calls `pathGuard.isSensitive`); if the
  member is named differently, stop and use the correct name rather than
  inventing one.

## Notes

- **Reviewer focus**: R2's `isEntryAccessible` takes `bounds` from the caller
  and the delegate forwards `rootDirectories` as `bounds` — confirm the
  non-symlink containment check uses `bounds` (NOT `this.rootBoundaries`, which
  is a different set and can be empty), and that the error branch stayed
  `SKIPPABLE_ERRNOS.has(error.code)` (not rewritten to `isNotFoundErrno` — that
  is redundant, ENOENT is already in `SKIPPABLE_ERRNOS`). R1's schema widening
  (search-content/search-files advertise `maxFiles`) is deliberate; verify the
  snapshot diff is _only_ the added enum variant. R3's two migrations keep
  their error-suppression policy via a catch-wrap — read both rewritten
  functions against the originals for behavioral parity.
- **R4 dropped**: plan-hunt found the move self-halting; the only non-halting
  rescope wraps a single expression and fails net-deletion. R4 is removed from
  this plan and recorded in the spec Out-of-scope. `resolveSearchRoot` in
  `replace-in-files.ts` stays (single-consumer).
- **Deferred**: the `path.ts` 1104-line Pool split (audit finding, not in this
  plan — fails net-deletion). The matcher extraction from `replace-in-files.ts`
  (single consumer, no seam). Both recorded in the spec Out-of-scope.
- **Rollback**: all steps are code-only, no migration or data. `git reset --hard eb0502f`
  restores the baseline; per-step rollback is `git revert <step-sha>` since each
  step is intended to be its own commit.
- **Ordering rationale**: R6 → R5 → R1 → R3 → R2. R6 first (trivial, unblocks
  R3's `isNotFoundErrno` use). The rest are independent (R5 touches edit +
  replace-in-files; R1 the three search tools; R3 path-completer + registrar;
  R2 path.ts + glob.ts — no two share a file). Each step leaves the build green.
