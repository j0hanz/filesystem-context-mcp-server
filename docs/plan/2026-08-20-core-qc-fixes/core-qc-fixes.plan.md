# Plan: Close the qc findings on `src/core/`

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `5d882ed`, 2026-08-20.
> **Drift check (run first)**: `git diff --stat 5d882ed..HEAD -- src/core src/tools __tests__`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

A branch review of `src/core/` (16 files, 5777 lines, all new on `dev`) found
two states no code path intends — a `PathGuard` left with new boundaries and
the previous allowed-directory set when a configured directory throws EACCES,
and a roots synchronizer that wedges in `'updating'` for the process lifetime
when that same call rejects — plus a read pipeline that builds a discriminated
union, flattens it, and re-discriminates it at runtime behind an unreachable
error. Around those sit eleven smaller findings: duplicated tables that have
already drifted, a second error vocabulary kept alive only by its own test,
and indirection that adds no behavior.

When this lands: the guard commits atomically, the synchronizer survives a
failed `setRoots`, `ReadSpec` stays a union end to end, `fs.ts` and `path.ts`
are honest about their size, and roughly 400 lines of duplicated or
pass-through code are gone.

Requirements covered: none, this is a fix + restructure pass.

## Current state

### The two half-applied states

[`path.ts:608-611`](../../../src/core/path.ts#L608-L611) — `setRoots` writes,
then recomputes:

```ts
async setRoots(resolvedRoots: readonly string[]): Promise<void> {
  this.rootDirectories = [...resolvedRoots];
  await this.recomputeAllowedDirectories();
}
```

[`path.ts:1132`](../../../src/core/path.ts#L1132) — `recomputeAllowedDirectories`
commits `rootBoundaries` mid-method, then does more async work before the final
commit at [`path.ts:1170`](../../../src/core/path.ts#L1170):

```ts
this.rootBoundaries = boundaries; // :1132 — first commit
// ... allowCwd / findProjectRoot / filterRootsWithin ...
const nextState = await resolveAllowedDirectoriesState(combined, signal);
this.initialize(nextState); // :1170 — second commit
```

The throw between them comes from
[`resolveRealPath`](../../../src/core/path.ts#L337-L350), reached via
`resolveAllowedDirectoriesState` → `expandAllowedDirectories`, which
deliberately rethrows anything that is not ENOENT:

```ts
if (isNodeError(error) && error.code === 'ENOENT') return null;
throw error;
```

[`registrar.ts:230-240`](../../../src/core/registrar.ts#L230-L240) — the
`finally` that calls it:

```ts
    } finally {
      const currentState = this.state as RootsManagerState;
      if (currentState !== 'shutting_down') {
        await this.pathGuard.setRoots(this.rootDirectories);
        this.state = 'idle';
        if (this.pendingRootsUpdate) {
          this.pendingRootsUpdate = false;
          void this.updateRootsFromClient(server);
        }
      }
    }
```

When `setRoots` rejects, `this.state = 'idle'` never runs. Every later
`notifications/roots/list_changed` then returns early at
[`registrar.ts:196-199`](../../../src/core/registrar.ts#L196-L199), setting a
`pendingRootsUpdate` nothing will drain. The `as RootsManagerState` cast exists
only to defeat TypeScript's (correct) narrowing to `'updating'`.

Also [`registrar.ts:218-229`](../../../src/core/registrar.ts#L218-L229): when
`listRoots` throws, `this.rootDirectories` keeps its **previous** value and is
re-applied, while the log says "No roots discovered from the client".

### The read pipeline

[`fs.ts:175-216`](../../../src/core/fs.ts#L175-L216) is a five-arm union
(`full` | `head` | `tail` | `range` | `byteRange`).
[`fs.ts:218-229`](../../../src/core/fs.ts#L218-L229) flattens it:

```ts
interface NormalizedOptions {
  encoding: BufferEncoding;
  maxSize: number;
  head?: number;
  tail?: number;
  startLine?: number;
  endLine?: number;
  skipBinary: boolean;
  signal?: AbortSignal;
  offset?: number;
  length?: number;
}
```

…plus a parallel `mode: ReadMode` string
([`fs.ts:173`](../../../src/core/fs.ts#L173)). `FileReader`
([`fs.ts:740-761`](../../../src/core/fs.ts#L740-L761)) switches on `mode` and
recovers the fields it already knows are present:

```ts
  private requireOption<K extends 'head' | 'tail' | 'startLine'>(
    key: K,
  ): NonNullable<NormalizedOptions[K]> {
    const value = this.context.normalized[key];
    if (value !== undefined) return value;
    throw new FsError(ErrorCode.INVALID_INPUT, `Missing ${key} option`, this.context.filePath);
  }
```

No caller can reach that throw — `normalizeSpec`
([`fs.ts:337-353`](../../../src/core/fs.ts#L337-L353)) established the
invariant twelve lines earlier.

**Ordering to preserve**: `GuardedFileSystem.readFile`
([`fs.ts:1130-1136`](../../../src/core/fs.ts#L1130-L1136)) normalizes **before**
validating the path, so an invalid `head` yields `INVALID_INPUT`, not
`ACCESS_DENIED`. `readFileWithStats`
([`fs.ts:977-985`](../../../src/core/fs.ts#L977-L985)) normalizes and reads in
one call.

### The other findings, each at its line

| #   | Location                                                                                                                                                           | The problem                                                                                   |
| :-- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------------------- |
| 4   | [`fs.ts:1169-1198`](../../../src/core/fs.ts#L1169-L1198)                                                                                                           | six pass-throughs under a comment admitting `pathGuard` stays public                          |
| 4   | [`fs.ts:65`](../../../src/core/fs.ts#L65), [`:75`](../../../src/core/fs.ts#L75), [`:85`](../../../src/core/fs.ts#L85), [`:955`](../../../src/core/fs.ts#L955)      | module-private functions taking `pathGuard`, each with one caller                             |
| 5   | [`errors.ts:75-89`](../../../src/core/errors.ts#L75-L89), [`:329-336`](../../../src/core/errors.ts#L329-L336), [`:352-374`](../../../src/core/errors.ts#L352-L374) | `DetailedError` duplicates `Problem`; `fromUnknown` discards the one field it adds            |
| 5   | [`errors.ts:285-287`](../../../src/core/errors.ts#L285-L287), [`:325-327`](../../../src/core/errors.ts#L325-L327)                                                  | `isFsError` aliases `isFsErrorCarrier`; `getSuggestion` aliases the map                       |
| 6   | [`glob.ts:50-61`](../../../src/core/glob.ts#L50-L61)                                                                                                               | `isNodeError` used to match `ErrorCode` values as if they were errnos                         |
| 7   | [`mime.ts:17-114`](../../../src/core/mime.ts#L17-L114) vs [`:200-241`](../../../src/core/mime.ts#L200-L241)                                                        | two extension tables, already drifted                                                         |
| 8   | [`path.ts:1085-1131`](../../../src/core/path.ts#L1085-L1131)                                                                                                       | two copy-pasted env-directory loops                                                           |
| 9   | [`util.ts:37-52`](../../../src/core/util.ts#L37-L52)                                                                                                               | `assignDefined`: `Reflect.ownKeys` + two casts + a try/catch, for two object literals         |
| a   | [`concurrency.ts:9-11`](../../../src/core/concurrency.ts#L9-L11), [`:63-88`](../../../src/core/concurrency.ts#L63-L88)                                             | abort-reason normalization no caller needs; two idioms disagreeing on the code                |
| b   | [`glob.ts:409-415`](../../../src/core/glob.ts#L409-L415), [`:439`](../../../src/core/glob.ts#L439), [`:520-553`](../../../src/core/glob.ts#L520-L553)              | `ProcessContext` duplicates `NormalizedGlob`; a second defaulting layer; a dead `''` argument |
| c   | [`store.ts:128-150`](../../../src/core/store.ts#L128-L150), [`:220-247`](../../../src/core/store.ts#L220-L247)                                                     | callback-shaped `rawPut` forces six casts; payload hashed twice, walked three times           |
| d   | [`engine.ts:173-238`](../../../src/core/search/engine.ts#L173-L238) vs [`:296-312`](../../../src/core/search/engine.ts#L296-L312)                                  | two scan loops, one skeleton, divergent truncation contracts                                  |
| e   | [`path-completer.ts:39-43`](../../../src/core/path-completer.ts#L39-L43), [`:332-341`](../../../src/core/path-completer.ts#L332-L341)                              | an options bag rebuilt around `this` for one private caller                                   |

### Facts the steps rely on

- **Every `assertNotAborted` call site passes one argument.** 21 sites across
  `src/core/`, `src/tools/`, verified by grep. The `message` parameter is dead.
- **Every `.abort()` in the repo is bare or passes an `Error`.**
  `__tests__/unit/abort.test.ts:24,31`, `path-guard-roots.test.ts:199` pass
  Errors; the rest are bare (default reason is a DOMException, which is an
  `Error`). So `signal.throwIfAborted()` always throws an `Error` and
  `normalizeAbortReason` never converts anything.
- **`createDetailedError` and `getSuggestion` have no consumer outside
  `errors.ts`** — only `__tests__/unit/errors.test.ts:10,13,223-245,122-129`.
- **`assignDefined` has two consumers**:
  [`search-files.ts:116`](../../../src/tools/search-files.ts#L116) and
  [`:144`](../../../src/tools/search-files.ts#L144), both spreadable literals.
- **`buildGlobOptions` has one consumer**: `search/engine.ts:152,279`. The
  other three `globEntries` callers (`list.ts:95`, `calculate-hash.ts:149`,
  `replace-in-files.ts:591`) pass a literal.
- **The six pass-throughs have 13 call sites** across 6 files:
  `list.ts:257,258`, `replace-in-files.ts:547,549`, `search-content.ts:345`
  (two calls), `search-files.ts:133` (two calls), `move.ts:139,140,240`,
  `delete-file.ts:165,170`.
- **`fs.pathGuard` is already reached directly** from `list.ts:266`,
  `search-content.ts:356`, `search-files.ts:150`.
- **`src/core/search/` holds exactly one file**, `engine.ts`. Importers:
  `edit.ts:15,16`, `replace-in-files.ts:24,25`, `search-content.ts:15`,
  `search-files.ts:9`, `__tests__/unit/replace-dollar-expansion.test.ts:13`,
  `__tests__/unit/search-abort.test.ts:22`.
- **knip's entry points are the tests** (`knip.json`: `entry:
["__tests__/helpers.ts", "__tests__/**/*.test.ts"]`). An export used only by
  a test is _not_ flagged — so deleting a function means deleting its test in
  the same step, or knip stays green while dead code survives.

### Conventions to match

- Optional-property construction under `exactOptionalPropertyTypes` uses the
  spread idiom, e.g. [`errors.ts:58-62`](../../../src/core/errors.ts#L58-L62):
  `...(opts.path !== undefined ? { path: opts.path } : {})`. Use it, not a
  reflective helper.
- Errors are `FsError(ErrorCode.X, message, path?, details?, cause?)` —
  [`fs.ts:364-371`](../../../src/core/fs.ts#L364-L371) is the exemplar.
- A deliberate ceiling gets a comment naming it — the waiver at
  [`path.ts:24-31`](../../../src/core/path.ts#L24-L31) is the shape (the
  content is wrong; step 5 rewrites it).
- Tests are `node:test` + `node:assert/strict`, one file per concern under
  `__tests__/unit/`; [`abort.test.ts`](../../../__tests__/unit/abort.test.ts)
  is a small exemplar.

## Commands

| Purpose        | Command                                    | Expected on success                |
| :------------- | :----------------------------------------- | :--------------------------------- |
| Full gate      | `node scripts/tasks.mjs`                   | `6/6 passed`, exit 0               |
| Static only    | `node scripts/tasks.mjs --quick`           | `4/4 passed`, exit 0               |
| Failure detail | `node scripts/tasks.mjs detail`            | source window for the last failure |
| Line counts    | `wc -l src/core/*.ts src/core/search/*.ts` | see per-step expectations          |

Baseline at `5d882ed`: `node scripts/tasks.mjs` → `6/6 passed 22.2s`.

## Scope

**In scope**:

- every file in [`src/core/`](../../../src/core) and the new
  `src/core/read.ts` / `src/core/search.ts`
- [`src/tools/`](../../../src/tools) — call-site updates only (steps 3, 6, 12,
  13, 15), no logic changes
- [`__tests__/unit/`](../../../__tests__/unit) — new tests, and deletion of
  tests for deleted functions

**Files out of scope** — leave alone even though they look related:

- [`src/transport.ts`](../../../src/transport.ts) — calls
  `recomputeAllowedDirectories` at `:160`; step 1 preserves its signature and
  behavior, so it needs no edit. Touching it widens a security change into the
  HTTP session path.
- [`src/server.ts`](../../../src/server.ts),
  [`src/resources.ts`](../../../src/resources.ts),
  [`src/prompts.ts`](../../../src/prompts.ts) — they hold a `PathGuard`
  directly, never a `GuardedFileSystem` pass-through, so step 6 does not reach
  them.
- `package.json`, `server.json` — versions are bumped only by the Release
  workflow (`CLAUDE.md`).

## Steps

### 1. Make `recomputeAllowedDirectories` commit once

In [`path.ts`](../../../src/core/path.ts), restructure
`recomputeAllowedDirectories` ([`:1081-1171`](../../../src/core/path.ts#L1081-L1171))
so no field of `this` is written until every await has resolved. Target shape:

```ts
async recomputeAllowedDirectories(): Promise<void> {
  const boundaries = await resolveConfiguredDirs('ROOT_BOUNDARY', { resolveReal: true });
  // ...compute allowCwdDirs / baseline / rootsToInclude against the LOCAL
  // `boundaries`, never this.rootBoundaries...
  const nextState = await resolveAllowedDirectoriesState(combined, signal);
  this.rootBoundaries = boundaries;   // both commits, adjacent, after every await
  this.initialize(nextState);
}
```

The two reads of `this.rootBoundaries` inside the method
([`:1140`](../../../src/core/path.ts#L1140),
[`:1156-1157`](../../../src/core/path.ts#L1156-L1157)) become reads of the
local. `getRootBoundaries()` and every caller keep their current behavior.

Then give `setRoots` ([`:608-611`](../../../src/core/path.ts#L608-L611)) the
same property — compute first, assign `this.rootDirectories` only if the
recompute succeeded:

```ts
async setRoots(resolvedRoots: readonly string[]): Promise<void> {
  const next = [...resolvedRoots];
  const previous = this.rootDirectories;
  this.rootDirectories = next;
  try {
    await this.recomputeAllowedDirectories();
  } catch (error) {
    this.rootDirectories = previous;   // roll back: the guard keeps its old, consistent view
    throw error;
  }
}
```

Add `__tests__/unit/path-guard-atomic.test.ts`: point `ROOT_BOUNDARY` or
`FS_ALLOWED_DIRS` at a directory whose `realpath` throws a non-ENOENT error
(chmod 000 on POSIX; on Windows, stub via a path that `realpath` rejects with
EPERM — if neither is reproducible on this platform, drive the failure by
temporarily replacing the guard's `options.cliAllowedDirs` with a path that
makes `resolveAllowedDirectoriesState` reject). Assert that after the
rejection, `getAllowedDirectories()` and `getRootBoundaries()` both still
return the pre-call values.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, including the new
`path-guard-atomic` test.

### 2. Keep the roots synchronizer out of `'updating'`

In [`registrar.ts:230-240`](../../../src/core/registrar.ts#L230-L240), make the
state transition survive a rejecting `setRoots`, and drop the
`as RootsManagerState` cast — with the transition no longer racing the await,
TypeScript's narrowing is correct and needs no defeating:

```ts
    } finally {
      if (this.state !== 'shutting_down') {
        try {
          await this.pathGuard.setRoots(this.rootDirectories);
        } catch (error) {
          Logger.emit(
            'warning',
            `Failed to apply roots to the path guard: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
        this.state = 'idle';
        if (this.pendingRootsUpdate) {
          this.pendingRootsUpdate = false;
          void this.updateRootsFromClient(server);
        }
      }
    }
```

If the narrowing still complains, the fix is to widen the field's declared type
at [`:128`](../../../src/core/registrar.ts#L128), not to re-add a cast.

Then resolve the message/behavior disagreement at
[`:218-229`](../../../src/core/registrar.ts#L218-L229): the catch logs "No
roots discovered from the client" while `this.rootDirectories` keeps its
previous value. Set `this.rootDirectories = []` in the catch so the log is
true — a client whose `listRoots` fails has told us nothing, and continuing to
grant the last-known roots is the more permissive of the two readings.

> Assumption: clearing on failure is correct because roots are an
> access-control input. If a test asserts roots survive a transient
> `listRoots` failure, that is a [STOP](#stop) — the intended contract is the
> opposite of this step.

Add to `__tests__/unit/roots-schema-validation.test.ts` (or a new
`__tests__/unit/roots-failure-recovery.test.ts`): a synchronizer whose
`pathGuard.setRoots` rejects once, then a second
`notifications/roots/list_changed` that must still reach `setRoots`. Assert the
second call happens.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, including the new test.

### 3. Keep `ReadSpec` a union through normalization

In [`fs.ts`](../../../src/core/fs.ts), replace `NormalizedOptions` +
`ReadMode` + `NormalizeResult` with a normalized **union** that mirrors
`ReadSpec`:

```ts
interface NormalizedBase {
  encoding: BufferEncoding;
  maxSize: number;
  skipBinary: boolean;
  signal?: AbortSignal;
}

type NormalizedSpec =
  | (NormalizedBase & { kind: 'full' })
  | (NormalizedBase & { kind: 'head'; lines: number })
  | (NormalizedBase & { kind: 'tail'; lines: number })
  | (NormalizedBase & { kind: 'range'; start: number; end?: number })
  | (NormalizedBase & { kind: 'byteRange'; offset: number; length?: number });
```

`normalizeSpec` returns `NormalizedSpec` (not `{normalized, mode}`). Each
`normalizeXSpec` keeps its validation and returns its own arm. `FileReader`
switches on `spec.kind` and reads `spec.lines` / `spec.start` / `spec.offset`
directly.

Delete: `requireOption` ([`:763-771`](../../../src/core/fs.ts#L763-L771)),
`ReadMode` ([`:173`](../../../src/core/fs.ts#L173)), `NormalizeResult`
([`:262-265`](../../../src/core/fs.ts#L262-L265)), the `Missing ${key} option`
error, and the `mode` field from `ReadModeContext`
([`:731-738`](../../../src/core/fs.ts#L731-L738)) and every call that threads
it.

`ReadFileResult.readMode` ([`:249`](../../../src/core/fs.ts#L249)) is a
**public output field** consumed by `src/tools/read.ts` — keep it, typed as
`ReadSpec['kind']`. Do not rename it.

Update the two entry points to pass one value instead of two:
`readFileWithStats` ([`:977-985`](../../../src/core/fs.ts#L977-L985)) and
`GuardedFileSystem.readFile` ([`:1130-1136`](../../../src/core/fs.ts#L1130-L1136)).
`readFile` must still call `normalizeSpec` **before** `validateExistingPath` —
that ordering is what makes a bad `head` an `INVALID_INPUT` rather than an
`ACCESS_DENIED`.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`. In particular
`__tests__/unit/read-line-bounds.test.ts` and
`__tests__/unit/read-input-schema.test.ts` must pass unchanged — this step
changes no behavior.

### 4. Cut the read pipeline out of `fs.ts` into `src/core/read.ts`

Move, verbatim apart from the step-3 shape, everything from
[`fs.ts:99`](../../../src/core/fs.ts#L99) (`// ─── Input validation ───`)
through `readFileWithStatsInternal`
([`:953`](../../../src/core/fs.ts#L953)) — plus `readFileWithStats`
([`:977-985`](../../../src/core/fs.ts#L977-L985)) — into a new
`src/core/read.ts`.

Also move `STREAM_CHUNK_SIZE` ([`:44`](../../../src/core/fs.ts#L44)),
`createTooLargeError` ([`:364-371`](../../../src/core/fs.ts#L364-L371)) and
`assertFileStats` ([`:928-932`](../../../src/core/fs.ts#L928-L932)), and export
them: `fs.ts`'s `calculateFileContentHash` and `readRaw` still need them. The
dependency runs one way only — `fs.ts` imports from `read.ts`, never the
reverse.

`read.ts` exports: `ReadSpec`, `ReadFileResult`, `normalizeSpec`,
`readFileWithStatsInternal` (rename to `readNormalized`), `readFileWithStats`,
`readFileBufferWithLimit`, `countLines`, `createTooLargeError`,
`assertFileStats`, `STREAM_CHUNK_SIZE`.

Update the importers — do not re-export from `fs.ts` to avoid the edit:

- [`src/tools/read.ts:11`](../../../src/tools/read.ts#L11) — `ReadFileResult`, `ReadSpec`
- [`src/tools/edit.ts:10`](../../../src/tools/edit.ts#L10) — `countLines`, `readFileWithStats`
- [`src/tools/create.ts:11`](../../../src/tools/create.ts#L11) — `countLines`
- [`src/tools/replace-in-files.ts:18`](../../../src/tools/replace-in-files.ts#L18) — `countLines`, `readFileBufferWithLimit`

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, and
`wc -l src/core/fs.ts src/core/read.ts` → `fs.ts` under 450, `read.ts` under
850, neither over 1000.

### 5. Rewrite the `path.ts` waiver to describe the file that exists

The waiver at [`path.ts:24-31`](../../../src/core/path.ts#L24-L31) claims what
is left "splits only into <100-line fragments of a single concept". Two
separable concerns are in the file, each with a single entry point:

- **denylist policy** — `DEFAULT_SENSITIVE_PATTERNS`, `buildSensitivePatterns`,
  `CompiledPattern`, `CompiledPatternSet`, `compilePatternGlobs`,
  `compilePatterns`, `toPatternSet`, `matchesAnyGlob`, `stripAdsFromPath`,
  `isSensitive` ([`:238-309`](../../../src/core/path.ts#L238-L309),
  [`:468-515`](../../../src/core/path.ts#L468-L515),
  [`:624-634`](../../../src/core/path.ts#L624-L634)) — ~150 lines, reaching
  `PathGuard` as one `matches(path)` call, already consumed independently by
  [`path-completer.ts:364`](../../../src/core/path-completer.ts#L364).
- **allowed-directory assembly** — `normalizeCLIDirectories`, `isRootWithin`,
  `filterRootsWithin`, `normalizeAllowedDirectories`,
  `expandAllowedDirectories`, `resolveAllowedDirectoriesState`, the body of
  `recomputeAllowedDirectories`, `UNSAFE_CWD_PATHS`, `isUnsafeCwdPath`,
  `findProjectRoot` — ~250 lines of "assemble the set", a different job from
  "validate a path against the set".

Replace the waiver text with those two names and the structural reason for
keeping them in place — the shared `IS_WINDOWS` / `normalizeForMatch` /
`isPathWithinDirectories` primitives and the fact that both are pure
access-control policy. A waiver that misstates its own contents is worse than
none; if the reason will not survive being written down, cut the denylist into
`src/core/denylist.ts` instead and drop the waiver.

**Verify**: `node scripts/tasks.mjs --quick` → `4/4 passed`. (Comment-only, or
one file move.)

### 6. Delete the `GuardedFileSystem` pass-throughs

`pathGuard` is already public and already reached directly from three call
sites, so the seam encapsulates nothing. Delete the six methods and the comment
defending them ([`fs.ts:1169-1198`](../../../src/core/fs.ts#L1169-L1198)):
`resolvePathOrRoot`, `validateExistingPath`, `validateExistingDirectory`,
`validatePathForWrite`, `validatePathForDelete`, `isAllowedRoot`.

Update the 13 call sites to `fs.pathGuard.x(...)` /
`ctx.fs.pathGuard.x(...)` — `list.ts:257,258`, `replace-in-files.ts:547,549`,
`search-content.ts:345`, `search-files.ts:133`, `move.ts:139,140,240`,
`delete-file.ts:165,170`.

In the same pass, inline the module-private helpers that take `pathGuard` and
have exactly one caller each into the method that calls them: `stat`
([`:65-73`](../../../src/core/fs.ts#L65-L73)) into `GuardedFileSystem.stat`,
`mkdir` ([`:75-83`](../../../src/core/fs.ts#L75-L83)) into `.mkdir`, `readlink`
([`:85-97`](../../../src/core/fs.ts#L85-L97)) into `.readlink` — keeping its
comment — and `readFileRaw` ([`:955-975`](../../../src/core/fs.ts#L955-L975))
into `.readRaw`.

Leave `setRoots` ([`:1165-1167`](../../../src/core/fs.ts#L1165-L1167)),
`statDetailed` and `hasChildrenUnchecked` alone — they add behavior.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, and
`git diff --stat -- src/tools` shows changes in exactly 6 files.

### 7. Collapse `DetailedError` into `Problem`

In [`errors.ts`](../../../src/core/errors.ts), rewrite `Problem.fromUnknown`
([`:75-89`](../../../src/core/errors.ts#L75-L89)) to call `classify` directly
and apply the same UNKNOWN/IO_ERROR override, then delete `DetailedError`
([`:329-336`](../../../src/core/errors.ts#L329-L336)), `createDetailedError`
([`:352-374`](../../../src/core/errors.ts#L352-L374)) and `getSuggestion`
([`:325-327`](../../../src/core/errors.ts#L325-L327)) — the last is a one-line
alias of `DEFAULT_SUGGESTIONS[code]`, which `resolveSuggestion`
([`:113`](../../../src/core/errors.ts#L113)) and the `FsError` constructor
([`:400`](../../../src/core/errors.ts#L400)) already read directly.

Collapse `isFsError` ([`:285-287`](../../../src/core/errors.ts#L285-L287)) and
`isFsErrorCarrier` ([`:258-265`](../../../src/core/errors.ts#L258-L265)) to one
exported function — keep the name `isFsError` (17+ call sites) and its
`error is FsError` signature; `classify` at
[`:293`](../../../src/core/errors.ts#L293) switches to it.

Delete the tests for the deleted exports:
`__tests__/unit/errors.test.ts` `describe('createDetailedError')`
([`:223-245`](../../../__tests__/unit/errors.test.ts#L223)) and
`describe('getSuggestion')` ([`:122-129`](../../../__tests__/unit/errors.test.ts#L122)),
plus their imports at `:10,13`. Behavior those tests covered that
`fromUnknown` still owns — the NOT_FOUND suggestion assertion at
[`:278`](../../../__tests__/unit/errors.test.ts#L278) — must keep a test; move
it under the `fromUnknown` describe rather than deleting it.

> knip will not catch a miss here: tests are its entry points, so an export
> kept alive only by its own test stays green.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, and
`grep -rn "createDetailedError\|getSuggestion\|isFsErrorCarrier" src __tests__`
returns nothing.

### 8. Split the two error namespaces in `glob.ts`

[`glob.ts:50-61`](../../../src/core/glob.ts#L50-L61) tests errno codes and
`ErrorCode` values in one `isNodeError` string list. Replace with two named
sets owned by [`errors.ts`](../../../src/core/errors.ts) — where both
discriminators live — and one dispatch:

```ts
// errors.ts
export const SKIPPABLE_FS_CODES: ReadonlySet<ErrorCode> = new Set([
  ErrorCode.ACCESS_DENIED,
  ErrorCode.NOT_FOUND,
  ErrorCode.SYMLINK_NOT_ALLOWED,
]);
export const SKIPPABLE_ERRNOS: ReadonlySet<string> = new Set(['ENOENT', 'EACCES', 'ELOOP']);

// glob.ts
if (isFsError(error)) {
  if (SKIPPABLE_FS_CODES.has(error.code)) return false;
  throw error;
}
if (isNodeError(error) && SKIPPABLE_ERRNOS.has(error.code)) return false;
throw error;
```

Keep the dangling-symlink comment from
[`:56-58`](../../../src/core/glob.ts#L56-L58) on `SKIPPABLE_FS_CODES` — it
explains why `NOT_FOUND` is in that set.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`. `path-guard.test.ts` and
the list/search tests cover the dangling-symlink path.

### 9. Derive the binary-extension set from `EXT_MAP`

In [`mime.ts`](../../../src/core/mime.ts), replace the hand-maintained
`KNOWN_BINARY_EXTENSIONS` ([`:200-241`](../../../src/core/mime.ts#L200-L241))
with a derivation plus an explicit remainder:

```ts
// Every non-text kind is binary for read purposes, except SVG — an image kind
// whose bytes are text, and which the read path must not fast-path as binary.
const EXTRA_BINARY_EXTENSIONS = [
  'mov',
  'avi',
  'mkv',
  'webm',
  'ttf',
  'otf',
  'woff',
  'woff2',
  'doc',
  'docx',
  'xls',
  'xlsx',
  'ppt',
  'pptx',
  'sqlite',
  'db',
  'bin',
  'dat',
  'mp4',
];

const KNOWN_BINARY_EXTENSIONS = new Set(
  [
    ...Object.entries(EXT_MAP)
      .filter(([, v]) => v.kind !== 'text')
      .map(([k]) => k),
    ...EXTRA_BINARY_EXTENSIONS,
  ]
    .filter((ext) => ext !== 'svg')
    .map((ext) => `.${ext}`),
);
```

The two tables had already drifted — `.xz .bz2 .msi .dmg .tiff .aac .ogg .m4a`
were binary/audio in `EXT_MAP` and unknown to the old set; `.mp4 .docx .ttf
.woff2` the reverse. This derivation resolves the drift toward "binary", which
only changes whether a file skips its content probe.

Add a case to `__tests__/unit/mime.test.ts` asserting
`isKnownBinaryExtension('a.svg') === false` and
`isKnownBinaryExtension('a.xz') === true`.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, including the new mime
cases, and `__tests__/unit/file-type.test.ts` unchanged.

### 10. Fold the two env-directory loops into one helper

[`path.ts:1085-1131`](../../../src/core/path.ts#L1085-L1131) runs the same
normalize → `stat` → `isDirectory()` → warn loop twice, differing only in the
`allowMissing` fallback and one extra `realpath`. Extract:

```ts
async function resolveConfiguredDirs(
  envVar: string,
  opts: { allowMissing?: boolean; resolveReal?: boolean },
): Promise<string[]>;
```

It keeps both warning messages verbatim — `Path configured in ${envVar} is not
a directory: ${rawPath}` and `Path configured in ${envVar} is invalid or does
not exist: ${rawPath} (${message})` — so operator-facing output does not
change. This lands on top of step 1's restructure; both call sites become one
line each.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, and
`__tests__/unit/cli-dir-unify.test.ts` + `cwd-walk.test.ts` pass unchanged.

### 11. Delete `assignDefined`

Delete [`util.ts:36-52`](../../../src/core/util.ts#L36-L52) and its test block
in [`__tests__/unit/util.test.ts:7-30`](../../../__tests__/unit/util.test.ts#L7).
Rewrite its two consumers with the codebase's own spread idiom:

```ts
// search-files.ts:116 — applySummaryFields
Object.assign(structured, {
  ...(summary.skippedInaccessible ? { skippedInaccessible: summary.skippedInaccessible } : {}),
  ...(summary.stoppedReason !== undefined ? { stoppedReason: summary.stoppedReason } : {}),
  ...(nextCursor !== undefined ? { nextCursor } : {}),
});

// search-files.ts:144
const searchOptions: Parameters<typeof searchFiles>[3] = {
  maxResults: fetchMax,
  includeHidden: args.includeHidden,
  sortBy: args.sortBy,
  respectGitignore: !args.includeIgnored,
  ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
  ...(signal !== undefined ? { signal } : {}),
};
```

Note the first site's original used `summary.skippedInaccessible || undefined`
— a falsy-zero drop, not an undefined check. The rewrite above preserves that
(`0` stays absent). Do not "fix" it here.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, including
`__tests__/unit/search-abort.test.ts` and any search-files output assertion.

### 12. Collapse the abort machinery to `throwIfAborted`

In [`concurrency.ts`](../../../src/core/concurrency.ts):

- `assertNotAborted(signal)` becomes `signal?.throwIfAborted()`; drop the
  `message` parameter (no call site passes it).
- Delete `createAbortError`, `normalizeAbortReason`, `getAbortError`
  ([`:63-88`](../../../src/core/concurrency.ts#L63-L88)); `withAbort`'s
  `onAbort` ([`:99`](../../../src/core/concurrency.ts#L99)) rejects with
  `signal.reason` directly.
- `checkParallelAbort` ([`:9-11`](../../../src/core/concurrency.ts#L9-L11))
  becomes `signal?.throwIfAborted()` — or is replaced by `assertNotAborted` at
  its four call sites ([`:25`](../../../src/core/concurrency.ts#L25),
  [`:31`](../../../src/core/concurrency.ts#L31),
  [`:39`](../../../src/core/concurrency.ts#L39),
  [`:57`](../../../src/core/concurrency.ts#L57)).

> **Behavior change, intended**: `checkParallelAbort` currently throws a fresh
> `AbortError` and discards the signal's reason, so a `timedSignal` deadline
> hit inside `processInParallel` surfaced as `CANCELLED` while the same
> deadline through `withAbort` surfaced as `TIMEOUT`
> ([`errors.ts:155-159`](../../../src/core/errors.ts#L155-L159) maps
> `TimeoutError` to `TIMEOUT`). After this step both report `TIMEOUT`. That is
> the fix, not a regression — call it out in the commit message.

Existing tests should hold:
[`parallel-results.test.ts:76-78`](../../../__tests__/unit/parallel-results.test.ts#L76-L78)
accepts `AbortError` **or** `/aborted/i`, and its `ctrl.abort()` is bare (name
`AbortError`). [`abort.test.ts`](../../../__tests__/unit/abort.test.ts) tests
`timedSignal` only.

Add one case to `abort.test.ts`: `processInParallel` under a `timedSignal` that
fires must reject with a reason whose `name` is `TimeoutError`.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, including the new case and
`__tests__/unit/search-abort.test.ts` unchanged.

### 13. Delete `ProcessContext` and the second glob defaulting layer

In [`glob.ts`](../../../src/core/glob.ts):

- Delete `ProcessContext` ([`:409-415`](../../../src/core/glob.ts#L409-L415)).
  `processGlobPattern` ([`:458`](../../../src/core/glob.ts#L458)) already
  receives `plan: NormalizedGlob`, which holds `cwd`, `maxDepth` and
  `suppressErrors`; give it `seen` and `onlyFiles` as plain parameters and read
  the rest from `plan`.
- Inline `globEntries` ([`:520-526`](../../../src/core/glob.ts#L520-L526)) and
  `nativeGlobEntries` ([`:495-518`](../../../src/core/glob.ts#L495-L518)) into
  one generator — the wrapper's only job is the `respectGitignore` load, which
  belongs at the top of the body.
- Delete `buildGlobOptions` ([`:530-553`](../../../src/core/glob.ts#L530-L553)).
  Make `excludePatterns`, `includeHidden`, `baseNameMatch` and `onlyFiles`
  optional on `GlobEntriesOptions` ([`:245-255`](../../../src/core/glob.ts#L245-L255));
  `normalizeGlobOptions` ([`:346`](../../../src/core/glob.ts#L346)) already
  defaults `suppressErrors` and `respectGitignore` with `?? false`, so extend
  it to default the other four (`onlyFiles` defaults to `true`, matching
  `buildGlobOptions`). Update its only consumer,
  [`engine.ts:152,279`](../../../src/core/search/engine.ts#L152), to pass the
  literal directly.
- Replace the dead-argument call at
  [`:438-443`](../../../src/core/glob.ts#L438-L443) — it passes `''` for
  `absolutePath`, which `relativePath` then overrides — with the direct call
  `gitignoreMatcher.isIgnored(posixRel, isDir)`.

`isIgnoredByGitignore` ([`:223-233`](../../../src/core/glob.ts#L223-L233)) stays
— [`calculate-hash.ts:11`](../../../src/tools/calculate-hash.ts#L11) imports it
and uses the `absolutePath` form for real.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, and `wc -l src/core/glob.ts`
under 560.

### 14. Make `rawPut` generic and hash once

In [`store.ts`](../../../src/core/store.ts):

- Make `rawPut` ([`:128-150`](../../../src/core/store.ts#L128-L150)) generic in
  its entry type — `private rawPut<E extends StoredEntry>(params, createFn: (base) => E): E`
  — so the six `as` casts at
  [`:268`](../../../src/core/store.ts#L268),
  [`:275`](../../../src/core/store.ts#L275),
  [`:279`](../../../src/core/store.ts#L279),
  [`:289`](../../../src/core/store.ts#L289),
  [`:296`](../../../src/core/store.ts#L296),
  [`:300`](../../../src/core/store.ts#L300) disappear. `getExisting` gains the
  same treatment for `getText`/`getBlob`, or keeps one cast with a comment
  explaining the `expectedKind` correspondence.
- Hash once: `tryReturnHashHit` ([`:220`](../../../src/core/store.ts#L220))
  computes `computeSha256(data)`, then `rawPut` computes it again on every
  miss. Compute it in the two public methods and pass it down; `checkBeforePut`
  ([`:212`](../../../src/core/store.ts#L212)) can take the already-computed
  `estimateBytes` the same way.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, including
`__tests__/unit/resource-store.test.ts` and `resource-store-blob.test.ts`, and
`grep -c " as " src/core/store.ts` → at most 1.

### 15. Unify the two search scan loops and flatten the directory

In [`engine.ts`](../../../src/core/search/engine.ts), extract the shared
skeleton of `scanContent`
([`:173-238`](../../../src/core/search/engine.ts#L173-L238)) and `searchFiles`
([`:296-312`](../../../src/core/search/engine.ts#L296-L312)) — glob, abort
check, maxResults check, `validateExistingPath` in a `try/catch` incrementing
`skippedInaccessible`:

```ts
async function* guardedEntries(
  entries: AsyncIterable<GlobEntry>,
  pathGuard: PathGuard,
  signal: AbortSignal | undefined,
  counters: { skippedInaccessible: number; stoppedByAbort: boolean },
): AsyncGenerator<GlobEntry>
```

Give both callers the same truncation contract: `searchContent` currently folds
abort and cap into one `truncated` boolean
([`:247`](../../../src/core/search/engine.ts#L247)), so a timed-out content
search is indistinguishable from a capped one at the tool boundary. Add
`stoppedReason?: 'timeout' | 'maxResults'` to `SearchContentOutcome.summary`
([`:106-124`](../../../src/core/search/engine.ts#L106-L124)), computed exactly
as `searchFiles` does at
[`:328-329`](../../../src/core/search/engine.ts#L328-L329) (cap wins over
abort). Surface it in
[`src/tools/search-content.ts`](../../../src/tools/search-content.ts) next to
its existing summary fields, matching how
[`search-files.ts:118`](../../../src/tools/search-files.ts#L118) passes
`stoppedReason` through.

Then move `src/core/search/engine.ts` → `src/core/search.ts` (the directory
holds one file) and update the six importers: `edit.ts:15,16`,
`replace-in-files.ts:24,25`, `search-content.ts:15`, `search-files.ts:9`,
`__tests__/unit/replace-dollar-expansion.test.ts:13`,
`__tests__/unit/search-abort.test.ts:22`.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, and
`ls src/core/search` → no such directory.

### 16. Rewrite the `path-completer.ts` options bag away

[`suggest`](../../../src/core/path-completer.ts#L39-L43) packs
`{ pathGuard: this.pathGuard, argumentName, contextArguments }` into an object
so the private `completePath`
([`:332-341`](../../../src/core/path-completer.ts#L332-L341)) can unpack it and
read the guard the instance already holds. Change the signature to
`completePath(value: string, argumentName: string, contextArguments?: Record<string, string>)`
and read `this.pathGuard`. `argumentName` already defaults to `''` at
[`:28`](../../../src/core/path-completer.ts#L28), so the `?? ''` at
[`:341`](../../../src/core/path-completer.ts#L341) goes too.

**Verify**: `node scripts/tasks.mjs` → `6/6 passed`, including
`__tests__/unit/path-completer.test.ts` and `completions.test.ts`.

## Done

All must hold:

- [ ] `node scripts/tasks.mjs` exits 0 with `6/6 passed`
- [ ] New tests exist and pass: `path-guard-atomic` (step 1), roots-failure
      recovery (step 2), the `timedSignal` × `processInParallel` case (step 12),
      the two mime cases (step 9)
- [ ] `wc -l src/core/*.ts` shows no file over 1000 lines except `path.ts`,
      which carries a waiver naming the two concerns it keeps and why
- [ ] `grep -rn "createDetailedError\|getSuggestion\|isFsErrorCarrier\|assignDefined\|buildGlobOptions\|requireOption" src __tests__` returns nothing
- [ ] `ls src/core/search` fails — the directory is gone
- [ ] `git status` shows no files outside the in-scope list

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt.
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation.
- The fix appears to require an out-of-scope file — in particular
  `src/transport.ts`, whose `recomputeAllowedDirectories` call at `:160` step 1
  is meant to leave untouched.
- **Step 1 or 2 changes an existing assertion in
  `__tests__/unit/path-guard-roots.test.ts` or `roots-schema-validation.test.ts`.**
  These are access-control paths; a test that has to change means the intended
  contract differs from this plan's reading, not that the test is stale.
- **A test asserts that roots survive a failed `listRoots`** — step 2 clears
  them, and that is the opposite contract.
- Step 9's derivation flips an extension the read path depends on in the other
  direction (a `text`-kind extension becoming binary). The derivation is
  one-way by construction; if a test disagrees, the exception list is wrong.

## Notes

- **Scrutinize first**: step 1's rollback in `setRoots` and step 2's decision
  to clear `rootDirectories` on a `listRoots` failure. Both change what a guard
  holds after a failure, which is the whole point, but they are the two places
  where a wrong reading is a security posture rather than a bug.
- **Step 4's boundary is not perfectly clean**: `read.ts` exports
  `createTooLargeError`, `assertFileStats` and `STREAM_CHUNK_SIZE` for
  `fs.ts`'s hash and raw-read paths. The alternative — leaving them in `fs.ts`
  — makes the import cycle bidirectional, which is worse. Flag it in review if
  a third home is obviously better.
- **Step 12 changes an error code** (`CANCELLED` → `TIMEOUT` for deadlines hit
  inside `processInParallel`). It is a fix; say so in the commit message so it
  is not read as an accident.
- **Deferred**: the denylist extraction from `path.ts` (step 5 keeps it with a
  rewritten waiver rather than cutting `src/core/denylist.ts`). If the waiver
  cannot be written honestly, cut the file — that branch is in the step.
- **Rollback**: no migrations, no data. `git checkout -- src __tests__` after
  any step, or `git revert` the step's commit. Commit per step so this stays
  cheap.
