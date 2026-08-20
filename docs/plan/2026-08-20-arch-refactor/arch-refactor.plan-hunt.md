# Plan Hunt: arch-refactor

Hunt of [`arch-refactor.plan.md`](arch-refactor.plan.md), written against
commit `eb0502f`, 2026-08-20. Four blind refuters dispatched (claim withheld);
verdicts below. Two steps hand back to [write-plan](../write-plan/SKILL.md).

## Findings

### CONFIRMED — step 5 (R2): `isEntryAccessible` move guarantees its own STOP

The step makes `isEntryAccessibleByType` delegate to a new
`PathGuard.isEntryAccessible(entryPath, entryType)` that checks containment
against `this.rootBoundaries` and drops the caller's `rootDirectories` param.

The sole caller passes a different set. [`list.ts:123-127`](../../../src/tools/list.ts#L123):

```ts
const accessible = await isEntryAccessibleByType(
  entry.path,
  entryType,
  [rootPath],
  options.pathGuard,
);
```

`[rootPath]` is the single listed directory (from `validateExistingDirectory`
at list.ts:258), not `PathGuard.rootBoundaries` (the `ROOT_BOUNDARY` env set,
declared at [`path.ts:446`](../../../src/core/path.ts#L446), assigned at
`path.ts:1024`). The two are not the same kind of thing, and `rootBoundaries`
can be empty — [`path.ts:606`](../../../src/core/path.ts#L606) guards on
`length > 0`, and `isPathWithinDirectories(p, [])` returns `false`
([`path.ts:220-228`](../../../src/core/path.ts#L220)). So the delegate would
filter every entry when `rootBoundaries` is empty, and against the wrong set
otherwise.

The step's own STOP names this divergence — so a cold executor following step 5
in order hits the gate, confirms `[rootPath]` ≠ `rootBoundaries`, and STOPS.
The step halts without accomplishing R2. A self-halting step is a dead step.

Refuter verdict: `killed` — on the narrower claim "ships broken behavior
uncaught." The refuter's own trace confirms the precondition is false, i.e.
the step halts. Override: the move is wrong-as-designed.

**Fix for write-plan**: `isEntryAccessible` must take the caller's bounds —
`PathGuard.isEntryAccessible(entryPath, entryType, bounds: readonly string[])`
— and the delegate passes `rootDirectories` straight through. Containment then
uses `[rootPath]`, behavior preserved. Drop the R2 STOP (the param flows; no
divergence to gate). `isSensitive`/symlink-branch logic stays on the guard.

### CONFIRMED — step 6 (R4): `resolveSearchBase` move guarantees its own STOP

`search-content` and `search-files` require a directory — they resolve via
`validateExistingDirectory`, which throws `NOT_DIRECTORY` for a file
([`search-content.ts:350-351`](../../../src/tools/search-content.ts#L350),
[`search-files.ts:131-132`](../../../src/tools/search-files.ts#L131);
`validateExistingDirectory` throws at `path.ts:794-795`). Neither branches on
file-vs-dir.

`resolveSearchBase` accepts a file (returns `{root: dirname, singleFile}`), so
migrating those two tools changes a file argument from a clear `NOT_DIRECTORY`
error to a silent parent-directory scan. The step's inline STOP
("if it never branches on file-vs-dir, STOP") fires for both — the step halts
without accomplishing R4 for them.

Refuter verdict: `killed` — on the claim "the STOP doesn't catch it." The
inline STOP does catch it (the summary-section STOP's polarity is inverted, but
the inline gate is operative). Override: again the step halts; the move is
wrong-as-designed for directory-only consumers.

**Fix for write-plan** — two viable rescopes (pick one):

1. Make `resolveSearchBase` directory-only: it calls
   `pathGuard.validateExistingDirectory(pathGuard.resolvePathOrRoot(path))`
   internally and returns `{root}` (no `singleFile`). The three dir tools
   (search-content, search-files, list) adopt it; `replace-in-files` keeps its
   own `resolveSearchRoot` (the genuine single-file variation). Seam = 3 dir
   tools, gate-2 holds.
2. Drop R4. The dir tools' "idiom" is one expression
   (`validateExistingDirectory(resolvePathOrRoot(path))`); once the
   single-file variation is excluded, what remains may not clear the
   net-deletion bar. `replace-in-files`'s `resolveSearchRoot` is a single
   consumer (no seam on its own).

Recommend rescope (1) — keep the finding, fix the helper to be directory-only.

## Killed (genuine, no action)

- **R1 zod singleton (step 3)** — `killed`. zod v4 `.describe()` is
  non-mutating: `node_modules/zod/src/v4/classic/schemas.ts:334-338`
  `describe(description) { const cl = this.clone(); core.globalRegistry.add(cl, { description }); return cl; }`.
  Per-site `StoppedReasonSchema.describe(text)` returns a fresh clone; the
  shared singleton is never written. Functionally equivalent to the repo's
  `PerFileErrorSchema.optional().describe()` pattern
  ([`schema.ts:179`](../../../src/core/schema.ts#L179) base + per-site
  `.optional().describe()` at edit.ts:125, read.ts:127, stat.ts:35). Not a
  defect.
- **R1 existing test (step 3)** — `killed`.
  [`__tests__/unit/replace-stop-reason.test.ts`](../../../__tests__/unit/replace-stop-reason.test.ts)
  asserts `processEntriesConcurrently`'s raw booleans
  (`result.stoppedByAbort/stoppedByLimit/stoppedByMatchCap`), not the
  `stoppedReason` enum/schema. Step 3 keeps the boolean→`StoppedReason` mapping
  with "no logic change" and does not edit `processEntriesConcurrently`. The
  test stays green.

## Noted (not blocking, tidy in write-plan if convenient)

- **R6 mislabel** — Current state and [`arch-refactor.spec.md`](arch-refactor.spec.md)
  R6 list `glob.ts:60` as an `=== 'ENOENT'` literal and say "six sites." It is
  `SKIPPABLE_ERRNOS.has(error.code)`; only five `=== 'ENOENT'` sites exist
  (path.ts:65,267,698; delete-file.ts:173,204). Step 1 and the Done-gate grep
  are correct (five sites, glob.ts untouched). Internal-doc inconsistency only;
  step 1 runs fine.
- **R3 normalize switch (step 4)** — migrating `path-completer` and
  `registrar` to `resolveRealPath` swaps `normalizePath(real)` for
  `normalizeAllowedDirectory(real)` (the latter strips trailing separators and
  preserves filesystem roots specially, [`path.ts:190`](../../../src/core/path.ts#L190)).
  `isPathInsideDirectory` ([`path.ts:209`](../../../src/core/path.ts#L209))
  case-folds but does not re-resolve, so it relies on the caller's
  normalization; a realpath that is a bare root or carries a trailing separator
  could classify differently. Low risk (realpath rarely returns those for
  completion directories) and the step's Verify (tests pass) + R3 STOP guard
  it. Watch the path-completer root-path tests; not a confirmed dead step.

## Coverage

Hunted: all 6 steps. Cited paths verified against the repo (`git ls-files` /
grep / opened definitions): the 5 ENOENT sites, `isEntryAccessibleByType`
caller, `rootBoundaries` field, `validateExistingDirectory` behavior, zod v4
`.describe()` source, `replace-stop-reason.test.ts` assertions,
`isPathInsideDirectory`, schema.ts helper conventions. Four blind refuters
dispatched (one per candidate), all returned; no in-thread fallback needed.

## Hand-off

Two confirmed dead steps (R2 step 5, R4 step 6) → [write-plan](../write-plan/SKILL.md)
to fix per the rescopes above, then re-hunt. R1 (both sub-claims), R6, R3, R5
are clear. Do not forward to [run-plan](../run-plan/SKILL.md) until R2 and R4
are redesigned.

## Re-hunt — 2026-08-20 (after write-plan fixes)

write-plan applied:

- **R2 (step 5) redesigned** — `isEntryAccessible(entryPath, entryType, bounds)`
  takes the caller's `bounds`; the delegate forwards `rootDirectories` as
  `bounds`. Non-symlink containment uses `bounds` (not `this.rootBoundaries`);
  symlink branch and error branch mirror `glob.ts:35-64` line-for-line;
  `pathGuard.isSensitive` → `this.isSensitive`. The self-halting R2 STOP is
  removed.
- **R4 (step 6) dropped** — the only non-halting rescope wraps a single
  expression (`validateExistingDirectory(resolvePathOrRoot(path))`), fails
  net-deletion; `replace-in-files.ts`' `resolveSearchRoot` is single-consumer.
  Removed from Goal, Scope, Done, STOP, Notes; spec R4 marked dropped.

One blind refuter dispatched on the redesigned step 5 (R2, access-control-
adjacent). Verdict: the refuter could not kill the preservation claim.
Substance (verbatim from the return):

- `src/core/path.ts:540-541` — `isSensitive(filePath: string): boolean { return
this.sensitive.isSensitive(filePath); }` is the public pass-through the plan's
  `this.isSensitive(...)` maps to (and which `glob.ts:42` reaches as
  `pathGuard.isSensitive`).
- `src/core/path.ts:741-774` — `validateExistingPathDetailed` returns
  `{ requestedPath, resolvedPath, isSymlink }`, matching the plan's
  `validated.requestedPath`/`validated.resolvedPath` and the original
  `glob.ts:54`.
- `src/core/path.ts:8-16` — errors import block has `ERRNO_MAP, ErrorCode,
FsError, isFsError, isNodeError, rethrowIfAborted`; `SKIPPABLE_FS_CODES` and
  `SKIPPABLE_ERRNOS` absent — and the plan names adding them (step 5). Not an
  unmentioned import.
- `src/tools/list.ts:123-128` — sole caller passes `[rootPath]` as
  `rootDirectories`.
- "No member is missing, no signature mismatch, no behavior divergence, no
  unmentioned import."

> Note on the verdict label: the dispatch framed the plan's preservation claim
> as the "finding," so a `confirmed` verdict inverts the skill's usual
> defect-confirmed semantics — the refuter "could not kill" the claim, i.e. the
> redesign holds. Read by substance, not label.

Result: **zero confirmed-dead steps remain.** R2 redesigned and re-verified;
R4 dropped; R1, R3, R5, R6 clear from the first hunt. The plan is clear to
forward to [run-plan](../run-plan/SKILL.md).
