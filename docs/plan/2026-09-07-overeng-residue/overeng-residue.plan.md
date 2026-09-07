# Plan: cut the 16 verified over-engineering residues left by the 2026-09-07 audit

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `6cedcca9`, 2026-09-07.
> **Drift check (run first)**:
> `git diff --stat 6cedcca9..HEAD -- src/ __tests__/`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

A full-repo over-engineering audit confirmed 16 behavior-preserving cuts sitting
on top of commit `8524d341`: one generic driver with a single instantiation, one
unreachable write branch, four hand-declared copies of one error shape, three
copies of a post-write metadata block, two copies of a diff-stat loop, two copies
of a `createTwoFilesPatch` call, and six pieces of dead surface (unread context
fields, unpassed options, a one-caller factory, a test-only export). Every cut is
a deletion or a fold — no new behavior, no new features, no schema change on the
wire.

The cost today is read cost: a maintainer tracing `move`'s failure path reads a
three-type-parameter driver in `batch.ts` that exists for one call site, and four
declarations of `{code, message, path?, suggestion?}` that are the same type.
When this lands, the tool layer has one error shape, one diff-stat helper, one
post-write metadata builder, and `batch.ts` holds only the path-batch driver two
tools actually share.

Requirements covered: none, this is a cleanup.

## Current state

Every cut's exact code as it exists at `6cedcca9`.

### The error shape, declared four times

[`src/core/errors.ts:20-32`](../../../src/core/errors.ts#L20-L32) — the private
twin and the exported original are field-for-field identical:

```ts
interface PerFileError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly suggestion?: string;
}

export interface Problem {
  readonly code: ErrorCode;
  readonly message: string;
  readonly path?: string;
  readonly suggestion?: string;
}
```

[`src/core/errors.ts:76-90`](../../../src/core/errors.ts#L76-L90) — the rebuild
that copies a `Problem` into the twin field by field:

```ts
  toPerFileError(
    error: unknown,
    defaultCode: ErrorCode = ErrorCode.UNKNOWN,
    path?: string,
  ): PerFileError {
    const problem = Problem.fromUnknown(error, defaultCode, path);
    return {
      code: problem.code,
      message: problem.message,
      ...(problem.path !== undefined ? { path: problem.path } : {}),
      ...(problem.suggestion !== undefined ? { suggestion: problem.suggestion } : {}),
    };
  },
```

`Problem.fromUnknown` already returns exactly that shape via its own `build()`
([`errors.ts:39-46`](../../../src/core/errors.ts#L39-L46)), so the rebuild is a
copy with no transform.

[`src/tools/batch.ts:10-15`](../../../src/tools/batch.ts#L10-L15) — third copy,
consumed only by `PerPathResult<T>` at
[`batch.ts:29`](../../../src/tools/batch.ts#L29):

```ts
interface PerPathError {
  code: ErrorCode;
  message: string;
  path?: string;
  suggestion?: string;
}
```

[`src/tools/delete-file.ts:76-84`](../../../src/tools/delete-file.ts#L76-L84) —
fourth copy, inline:

```ts
interface DeleteFailure {
  path: string;
  error: {
    code: string;
    message: string;
    path?: string;
    suggestion?: string;
  };
}
```

`Problem` is already imported by both files
([`batch.ts:4`](../../../src/tools/batch.ts#L4),
[`delete-file.ts:9-16`](../../../src/tools/delete-file.ts#L9-L16)).

> `PairFailureItem.error` at
> [`batch.ts:21-26`](../../../src/tools/batch.ts#L21-L26) is a **wire** type
> (`code: string`, explicit `| undefined` on the optionals) mirroring
> `PerFileErrorSchema`. It is NOT a fifth copy — step 7 leaves it alone. (Step 13
> deletes it for an unrelated reason: it becomes unreferenced when the pair
> driver moves.)

### The pair driver with one instantiation

[`src/tools/batch.ts:115-134`](../../../src/tools/batch.ts#L115-L134) and
[`batch.ts:161-302`](../../../src/tools/batch.ts#L161-L302) — `PairPlan`,
`PairPlanResult`, `PairExecResult`, `PairBatchOutcome`, `RunOverPairsOptions`,
`pairFailure`, and `runOverPairs<TItem, TPlan, TResult>`.

The sole instantiation is
[`move.ts:230-234`](../../../src/tools/move.ts#L230-L234):

```ts
  const outcome = await runOverPairs(args.moves, ctx, {
    op,
    plan: (pair) => planTransfer(op, pair, ctx.fs, overwrite),
    execute: (plan, pendingSorted) => executeTransfer(op, plan, ctx, pendingSorted),
  });
```

with `TItem = { source, destination }`, `TPlan = TransferPlan`
([`move.ts:72-92`](../../../src/tools/move.ts#L72-L92)), `TResult =
MoveItemResult` ([`move.ts:65`](../../../src/tools/move.ts#L65)). `move.ts` also
imports the two result types at
[`move.ts:22`](../../../src/tools/move.ts#L22).

`isTotalFailure` at
[`batch.ts:148-159`](../../../src/tools/batch.ts#L148-L159) takes **either**
count shape and is used by six tools — it stays in `batch.ts`, and its doc
comment mentions `runOverPairs`, so the comment needs a word changed.

`runOverPaths` at [`batch.ts:56-113`](../../../src/tools/batch.ts#L56-L113) has
five callers and stays untouched.

### The unreachable write branch

[`src/core/fs.ts:281-296`](../../../src/core/fs.ts#L281-L296):

```ts
  async open(
    filePath: string,
    flags: string | number,
    mode?: string | number,
  ): Promise<FileHandle> {
    // Only a plain read-only open ('r' / O_RDONLY) uses the existing-path guard.
    // Every other flag (write, append, read-write, sync, numeric) is treated as
    // write-capable and routed through the stricter write guard.
    const isReadOnly = flags === 'r' || flags === fsConstants.O_RDONLY;
    const validPath = isReadOnly
      ? await this.pathGuard.validateExistingPath(filePath)
      : await this.pathGuard.validatePathForWrite(filePath);
    return fsOpen(validPath, flags, mode);
  }
```

The only caller is
[`replace-in-files.ts:375`](../../../src/tools/replace-in-files.ts#L375):

```ts
  await using fileHandle = await ctx.fs.open(validPath, 'r');
```

`fsConstants` may become unused in `fs.ts` after the cut — check before deleting
its import.

### `getFileType` duplicating `resolveEntryType`

[`src/core/fs.ts:123-128`](../../../src/core/fs.ts#L123-L128):

```ts
export function getFileType(stats: Stats): FileType {
  if (stats.isFile()) return 'file';
  if (stats.isDirectory()) return 'directory';
  if (stats.isSymbolicLink()) return 'symlink';
  return 'other';
}
```

[`src/core/glob.ts:16-27`](../../../src/core/glob.ts#L16-L27):

```ts
export interface DirentLike {
  isDirectory(): boolean;
  isFile(): boolean;
  isSymbolicLink(): boolean;
}

export function resolveEntryType(dirent: DirentLike): EntryType {
  if (dirent.isDirectory()) return 'directory';
  if (dirent.isFile()) return 'file';
  if (dirent.isSymbolicLink()) return 'symlink';
  return 'other';
}
```

The check order differs but never the result — `Stats` reports exactly one type.
`Stats` structurally satisfies `DirentLike`. The return types are the same type:
[`fs.ts:28`](../../../src/core/fs.ts#L28) is
`import type { EntryType as FileType } from './primitives.js'`, and
[`schema.ts:36-38`](../../../src/core/schema.ts#L36-L38) builds `FileType` from
the same `ENTRY_TYPES`.

Three callers: [`stat.ts:70`](../../../src/tools/stat.ts#L70),
[`delete-file.ts:181`](../../../src/tools/delete-file.ts#L181),
[`delete-file.ts:230`](../../../src/tools/delete-file.ts#L230).

### The post-write metadata block, written three times

[`src/tools/patch.ts:51-71`](../../../src/tools/patch.ts#L51-L71):

```ts
function buildPatchMeta(
  validPath: string,
  patched: string,
  resourceStore: ToolCtx['resourceStore'],
): PatchMeta {
  const bytesWritten = Buffer.byteLength(patched, 'utf-8');
  const mimeInfo = detectMimeFromContent(validPath, patched);
  const resourceUri = buildFileResourceUri(validPath);
  const link =
    resourceStore !== undefined
      ? buildFileResourceLink(validPath, mimeInfo.mimeType, bytesWritten)
      : undefined;
  return {
    size: bytesWritten,
    lineCount: countLines(patched),
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    resourceUri,
    link,
  };
}
```

[`src/tools/edit.ts:343-368`](../../../src/tools/edit.ts#L343-L368) — same five
steps, with the `appliedEdits > 0` gate:

```ts
function buildEditFileMetadata(
  content: string,
  validPath: string,
  appliedEdits: number,
  resourceStore: ResourceStore | undefined,
): EditFileMetadata {
  const bytesWritten = Buffer.byteLength(content, 'utf-8');
  const lineCount = countLines(content);
  const mimeInfo = detectMimeFromContent(validPath, content);
  // Omitted rather than empty-stringed when nothing matched: `""` satisfied the
  // schema's `string` and then failed every resources/read a client tried it on.
  const resourceUri = appliedEdits > 0 ? buildFileResourceUri(validPath) : undefined;
  const resourceLink =
    appliedEdits > 0 && resourceStore
      ? buildFileResourceLink(validPath, mimeInfo.mimeType, bytesWritten)
      : undefined;
  return { /* … */ };
}
```

[`src/tools/create.ts:98-121`](../../../src/tools/create.ts#L98-L121) — the same
steps inline inside the per-file callback:

```ts
        const bytesWritten = Buffer.byteLength(content, 'utf-8');
        const lineCount = countLines(content);
        const mimeInfo = detectMimeFromContent(validPath, content);

        const resourceUri = buildFileResourceUri(validPath);
        const file: CreateFileResult = { /* … */ };

        return ctx.resourceStore
          ? {
              file,
              resourceLink: buildFileResourceLink(validPath, mimeInfo.mimeType, bytesWritten),
            }
          : { file };
```

All three already import from
[`src/core/file-uri.ts`](../../../src/core/file-uri.ts) — that is the helper's
home.

> The `appliedEdits > 0` gate is load-bearing and verified: an edit that matched
> nothing must emit **no** `resourceUri` and **no** link. It becomes a parameter,
> never a dropped condition.

### The diff-stat loop, written twice

[`src/tools/edit.ts:179-191`](../../../src/tools/edit.ts#L179-L191) —
module-local:

```ts
function computeDiffStats(
  original: string,
  modified: string,
): { linesAdded: number; linesRemoved: number } {
  // diffLines returns the change list synchronously on diff v9.
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const part of diffLines(original, modified)) {
    if (part.added) linesAdded += part.count;
    else if (part.removed) linesRemoved += part.count;
  }
  return { linesAdded, linesRemoved };
}
```

[`src/tools/diff.ts:61-67`](../../../src/tools/diff.ts#L61-L67) — the same loop
inline:

```ts
  // diffLines returns the change list synchronously; count added/removed lines.
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const part of diffLines(contentA, contentB)) {
    if (part.added) linesAdded += part.count;
    else if (part.removed) linesRemoved += part.count;
  }
```

Neither `edit.ts` nor `diff.ts` imports
[`src/core/fmt.ts`](../../../src/core/fmt.ts) today — eight other files do
(`cli.ts`, `cli-help.ts`, `define.ts`, `delete-file.ts`, `move.ts`,
`replace-in-files.ts`, `search-content.ts`, `search-files.ts`), which is what
makes it the shared home. `diff` is already a production dependency, and
`src/core/` already carries package imports (`glob.ts` → `ignore`, `search.ts` →
`@adguard/re2-wasm`, `schema.ts` → `zod`), so this adds no new dependency and
crosses no lint boundary.

> [`patch.ts:75-87`](../../../src/tools/patch.ts#L75-L87) counts `+`/`-` prefixes
> off a **parsed patch**, not `diffLines`. Different input, not a third copy —
> leave it.

### The `createTwoFilesPatch` call, written twice

[`src/tools/edit.ts:425-434`](../../../src/tools/edit.ts#L425-L434):

```ts
      const label = basename(validPath);
      // createTwoFilesPatch returns the unified diff string synchronously on
      // diff v9 (the { callback } option fires via setTimeout and returns undefined).
      editResult.diff = createTwoFilesPatch(
        label,
        label,
        content,
        editResult.content,
        'Original',
        'Modified',
      );
```

[`src/tools/replace-in-files.ts:400-412`](../../../src/tools/replace-in-files.ts#L400-L412):

```ts
  const header = toPosixRelative(summary.root, params.filePath);

  // createTwoFilesPatch returns the unified diff string synchronously on
  // diff v9 (the { callback } option fires via setTimeout and returns undefined).
  const patch = createTwoFilesPatch(
    header,
    header,
    params.originalContent,
    params.updatedContent,
    'Original',
    'Modified',
  );
```

Same args, same headers, same comment — only the label differs.

> [`diff.ts:51-59`](../../../src/tools/diff.ts#L51-L59) passes **two different**
> file names, headers `'a'`/`'b'`, and a `{ context }` option. Not a duplicate —
> leave it.

### The hand-rolled basename

[`src/core/search.ts:311-321`](../../../src/core/search.ts#L311-L321):

```ts
  if (options.sortBy === 'name') {
    results.sort((a, b) => {
      const aName = a.path.split(/[/\\]/).pop() ?? '';
      const bName = b.path.split(/[/\\]/).pop() ?? '';
      return aName.localeCompare(bName);
    });
  } else {
    results.sort((a, b) => a.path.localeCompare(b.path));
  }
```

`String.prototype.split` never returns an empty array, so `?? ''` is dead; and
splitting on `\` is wrong on POSIX, where `\` is a legal filename character.
`node:path` is not yet imported by
[`search.ts:1-11`](../../../src/core/search.ts#L1-L11) — the `basename` import is
new.

`sortBy: 'name'` has **zero** test coverage today: the only `searchFiles` test is
[`core-fs.test.ts:193-209`](../../../__tests__/core-fs.test.ts#L193-L209)
(TC-FUNC-039), which passes `{}`. Step 12 adds one.

### Dead surface

| Location | What is dead |
| :--- | :--- |
| [`define.ts:46`](../../../src/tools/define.ts#L46) | `ToolCtx.sessionId` — assigned at [`:179`](../../../src/tools/define.ts#L179), read by nothing |
| [`define.ts:83`](../../../src/tools/define.ts#L83) | `ToolCtx.server` — assigned at [`:156`](../../../src/tools/define.ts#L156) and [`:189`](../../../src/tools/define.ts#L189), read by nothing |
| [`schema.ts:281`](../../../src/core/schema.ts#L281) | `singleOrBatchPathsInput`'s `maxBatch` option — never passed |
| [`file-uri.ts:47`](../../../src/core/file-uri.ts#L47) | `annotations` param — never passed by any of 6 call sites |
| [`index.ts:41`](../../../src/tools/index.ts#L41) | `ALL_REGISTERED_TOOL_NAMES` — test-only export |
| [`schema.ts:189`](../../../src/core/schema.ts#L189) | `createReadRangeFields` factory — one caller |
| [`errors.ts:57`](../../../src/core/errors.ts#L57) | `Problem.ioError` factory — zero callers |

Grep evidence recorded at `6cedcca9`:

- `sessionId`: only `define.ts:46`, `define.ts:179`, and
  [`resources.test.ts:30`](../../../__tests__/resources.test.ts#L30) — the test
  builds a fake `ServerContext`, not a `ToolCtx`, so it is unaffected.
- `.server` under `src/tools/`: `define.ts:156`, `define.ts:175`, `define.ts:189`,
  `define.ts:540`, `index.ts:65`. Lines 175 and 540 read **`deps.server`**
  (`ToolDeps`), a different object. `ToolDeps.server` stays.
- `maxBatch`: both callers pass only `{ extra }` —
  [`read.ts:48`](../../../src/tools/read.ts#L48),
  [`stat.ts:26`](../../../src/tools/stat.ts#L26).
- `annotations` on the two link builders: not passed at
  [`create.ts:118`](../../../src/tools/create.ts#L118),
  [`edit.ts:358`](../../../src/tools/edit.ts#L358),
  [`patch.ts:62`](../../../src/tools/patch.ts#L62),
  [`read.ts:522`](../../../src/tools/read.ts#L522),
  [`replace-in-files.ts:632`](../../../src/tools/replace-in-files.ts#L632), or
  the internal call at
  [`file-uri.ts:58`](../../../src/core/file-uri.ts#L58).
- `ALL_REGISTERED_TOOL_NAMES`: 14 references, all in tests —
  `http-server.test.ts:11,199`, `http-transport.test.ts:6,37`,
  `inspector-stdio.test.ts:6,81,82`, `smoke.test.ts:6,36,39`,
  `stdio.test.ts:13,59`, `tools.test.ts:22,231`. `knip` does not flag it because
  `knip.json`'s entry glob is `__tests__/**/*.test.ts`.
- `ioError`: definition only (`errors.ts:57`), plus the compiled
  `dist/core/errors.d.ts` — no call site anywhere in `src/`, `__tests__/`, or
  `scripts/`.

`createReadRangeFields`'s one caller passes four fixed strings —
[`read.ts:41-47`](../../../src/tools/read.ts#L41-L47):

```ts
const readRangeFields = createReadRangeFields({
  head: 'Return first N lines',
  tail: 'Return last N lines',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});
```

The TODO above it at
[`schema.ts:180-181`](../../../src/core/schema.ts#L180-L181) already says so.

### Conventions to match

- **Comments earn their place.** This repo writes a comment when the code is
  surprising and nowhere else — see the TOCTOU note at
  [`move.ts:186-188`](../../../src/tools/move.ts#L186-L188) and the URI-case note
  at [`file-uri.ts:35-41`](../../../src/core/file-uri.ts#L35-L41). When a cut
  removes a code path, remove its comment too; when a cut moves code, the comment
  moves with it.
- **Optional properties are spread, never set to `undefined`** — the codebase runs
  `exactOptionalPropertyTypes`. Exemplar:
  [`errors.ts:40-45`](../../../src/core/errors.ts#L40-L45).
- **Formatting is Prettier's** — never hand-format; `node scripts/tasks.mjs fix`
  settles it.

## Commands

| Purpose | Command | Expected on success |
| :--- | :--- | :--- |
| Static checks | `node scripts/tasks.mjs --quick` | exit 0; build, both type-checks, eslint, prettier, knip all clean |
| Tests | `node scripts/tasks.mjs test` | exit 0; `pass 276 fail 0` (277 from step 12 on) |
| Full gate | `node scripts/tasks.mjs` | exit 0 |
| Format + lint-fix | `node scripts/tasks.mjs fix` | exit 0 |

Baseline at `6cedcca9`: `tests 276`, `suites 61`, `pass 276`, `fail 0`.

## Scope

**In scope** — the only files to modify:

- [`src/core/errors.ts`](../../../src/core/errors.ts)
- [`src/core/fs.ts`](../../../src/core/fs.ts)
- [`src/core/file-uri.ts`](../../../src/core/file-uri.ts)
- [`src/core/fmt.ts`](../../../src/core/fmt.ts)
- [`src/core/schema.ts`](../../../src/core/schema.ts)
- [`src/core/search.ts`](../../../src/core/search.ts)
- [`src/tools/batch.ts`](../../../src/tools/batch.ts)
- [`src/tools/create.ts`](../../../src/tools/create.ts)
- [`src/tools/define.ts`](../../../src/tools/define.ts)
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts)
- [`src/tools/diff.ts`](../../../src/tools/diff.ts)
- [`src/tools/edit.ts`](../../../src/tools/edit.ts)
- [`src/tools/index.ts`](../../../src/tools/index.ts)
- [`src/tools/move.ts`](../../../src/tools/move.ts)
- [`src/tools/patch.ts`](../../../src/tools/patch.ts)
- [`src/tools/read.ts`](../../../src/tools/read.ts)
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts)
- [`src/tools/stat.ts`](../../../src/tools/stat.ts)
- [`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts) — step 12 only
- [`__tests__/http-server.test.ts`](../../../__tests__/http-server.test.ts),
  [`__tests__/http-transport.test.ts`](../../../__tests__/http-transport.test.ts),
  [`__tests__/inspector-stdio.test.ts`](../../../__tests__/inspector-stdio.test.ts),
  [`__tests__/smoke.test.ts`](../../../__tests__/smoke.test.ts),
  [`__tests__/stdio.test.ts`](../../../__tests__/stdio.test.ts),
  [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts) — step 5 only

**Files out of scope** — leave alone even though they look related:

- [`src/cli.ts`](../../../src/cli.ts),
  [`src/cli-help.ts`](../../../src/cli-help.ts),
  [`README.md`](../../../README.md) — the `--safe` alias of `--read-only` was
  considered and **excluded**: it is a documented public CLI flag
  (`README.md:368`, `cli-help.ts:28`), so removing it is a breaking change, not a
  behavior-preserving cut.
- [`src/core/store.ts`](../../../src/core/store.ts),
  [`src/core/page-store.ts`](../../../src/core/page-store.ts) — merging the two
  stores was adversarially refuted twice (client-visible ISO TTL vs injectable
  numeric clock, byte-metered vs count-only eviction, test-pinned prune
  coalescing). A generic replacement needs knobs costing more than the dedup
  saves.
- [`src/core/path.ts`](../../../src/core/path.ts),
  [`src/core/http-policy.ts`](../../../src/core/http-policy.ts) — the security
  core. PathGuard's dual lexical+realpath containment, the sensitive denylist,
  and NTFS ADS stripping were all verified load-bearing. Do not "simplify" them.
- `delete-file.ts`'s plan/execute pipeline beyond the two `getFileType` call
  sites and the `DeleteFailure.error` type — routing `delete` through the pair
  driver was refuted twice: its output shaping (input-ordered rows,
  noop→`deleted:true`, requested-vs-resolved path fallback) cannot be expressed
  by `PairBatchOutcome`, and the swap silently changes plan-error, duplicate-key,
  pending-dedupe, and noop semantics on an irreversible tool with test-pinned
  behavior (TC-FUNC-068/069/069b).
- [`package.json`](../../../package.json),
  [`server.json`](../../../server.json) — versions are bumped only by the
  Release workflow.
- [`dist/`](../../../dist) — build output; `npm run build` regenerates it.

## Steps

Steps 1–6 are independent dead-surface deletions; 7 unifies the error shape;
8–12 fold the duplicated blocks; 13 is the pair-driver fold and lands last
because it is the largest diff.

Run `node scripts/tasks.mjs fix` before each Verify if Prettier complains.

### 1. Delete the two unread `ToolCtx` fields

In [`src/tools/define.ts`](../../../src/tools/define.ts):

- Delete `readonly sessionId?: string;` at
  [`:46`](../../../src/tools/define.ts#L46) and its spread
  `...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),` at
  [`:179`](../../../src/tools/define.ts#L179).
- Delete `readonly server?: McpServer;` at
  [`:83`](../../../src/tools/define.ts#L83) and both assignments
  `server: deps.server,` at [`:156`](../../../src/tools/define.ts#L156) and
  [`:189`](../../../src/tools/define.ts#L189).
- **Keep** `ToolDeps.server` at [`:87`](../../../src/tools/define.ts#L87), the
  `deps.server.server.getClientCapabilities()` read at
  [`:175`](../../../src/tools/define.ts#L175), and
  `deps.server.registerTool(...)` at
  [`:540`](../../../src/tools/define.ts#L540).
- `toToolCtx`'s `deps` parameter is
  `Pick<ToolDeps, 'pathGuard' | 'pageStore' | 'resourceStore' | 'server'>` at
  [`:147`](../../../src/tools/define.ts#L147) — `'server'` must **stay** in that
  Pick: line 175 still reads it.
- If the `McpServer` type import becomes unused in this file, remove it;
  `eslint` will say so.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0

### 2. Delete `singleOrBatchPathsInput`'s unpassed `maxBatch`

In [`src/core/schema.ts`](../../../src/core/schema.ts): drop `maxBatch?: number;`
from the options object at [`:281`](../../../src/core/schema.ts#L281) and the
`const maxBatch = opts.maxBatch ?? DEFAULT_MAX_BATCH;` line at
[`:283`](../../../src/core/schema.ts#L283); use `DEFAULT_MAX_BATCH`
([`:274`](../../../src/core/schema.ts#L272)) directly in the `.max(...)` call and
in the description template string.

Both callers already pass only `{ extra }` — no call site changes.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0

### 3. Delete the never-passed `annotations` param on both link builders

In [`src/core/file-uri.ts`](../../../src/core/file-uri.ts): remove the
`annotations` parameter from `buildFileResourceLinkFor`
([`:42-50`](../../../src/core/file-uri.ts#L42-L50)) and `buildFileResourceLink`
([`:52-65`](../../../src/core/file-uri.ts#L52-L65)), inlining
`{ audience: ['user', 'assistant'] }` into the returned block, and drop the
argument from the internal call at
[`:63`](../../../src/core/file-uri.ts#L63).

Target shape:

```ts
export function buildFileResourceLinkFor(
  uri: string,
  name: string,
  mimeType: string,
  size: number,
): ContentBlock {
  return {
    type: 'resource_link',
    uri,
    name,
    mimeType,
    size,
    annotations: { audience: ['user', 'assistant'] },
  };
}
```

No call-site changes — all six already omit the argument.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0

### 4. Inline `createReadRangeFields` into `read.ts`

Delete `ReadRangeDescriptions`
([`schema.ts:182-187`](../../../src/core/schema.ts#L182-L187)),
`createReadRangeFields`
([`schema.ts:189-203`](../../../src/core/schema.ts#L189-L203)), and the
now-answered TODO above them at
[`schema.ts:179-181`](../../../src/core/schema.ts#L179-L181).

In [`src/tools/read.ts`](../../../src/tools/read.ts), replace the
`createReadRangeFields({...})` call at
[`:41-47`](../../../src/tools/read.ts#L41-L47) with the four literals, keeping
the same bounds and messages:

```ts
const rangeField = (description: string) =>
  z
    .int32()
    .min(1, { message: 'Min: 1' })
    .max(100000, { message: 'Max: 100,000' })
    .optional()
    .describe(description);

const readRangeFields = {
  head: rangeField('Return first N lines'),
  tail: rangeField('Return last N lines'),
  startLine: rangeField('Start line (1-indexed)'),
  endLine: rangeField('End line (1-indexed)'),
};
```

Drop `createReadRangeFields` from `read.ts`'s import of `../core/schema.js`;
keep `validateReadRange`.

> The published input schema must not change. `tools.test.ts`'s
> TOOL-SURFACE-001/002 assert on the emitted schema — if they fail, a bound or a
> description drifted.

**Verify**: `node scripts/tasks.mjs test` → `pass 276 fail 0`

### 5. Delete the test-only `ALL_REGISTERED_TOOL_NAMES` export

Delete [`index.ts:41`](../../../src/tools/index.ts#L41). In each of the six test
files, drop it from the `../src/tools/index.js` import and compute it locally
beside the existing `ALL_TOOLS` usage:

```ts
const ALL_REGISTERED_TOOL_NAMES = ALL_TOOLS.map((t) => t.name);
```

Files and their references:
`http-server.test.ts:11,199`; `http-transport.test.ts:6,37`;
`inspector-stdio.test.ts:6,81,82`; `smoke.test.ts:6,36,39`;
`stdio.test.ts:13,59`; `tools.test.ts:22,231`.

Each file must import `ALL_TOOLS` from `../src/tools/index.js`. Only
`tools.test.ts` ([`:23`](../../../__tests__/tools.test.ts#L23)) has it today —
the other five add it to the same import statement they are already editing.
Assertions stay byte-identical.

**Verify**: `node scripts/tasks.mjs test` → `pass 276 fail 0`

### 6. Delete the zero-caller `Problem.ioError`

Delete [`errors.ts:57`](../../../src/core/errors.ts#L57). `ErrorCode.IO_ERROR`
stays — it is still produced by `ERRNO_MAP` classification and read by
`fromUnknown`'s `shouldOverride` check at
[`errors.ts:60-61`](../../../src/core/errors.ts#L60-L61).

**Verify**: `node scripts/tasks.mjs --quick` → exit 0

### 7. Collapse the four error-shape declarations onto `Problem`

Three edits, one commit — the type must land everywhere at once or the build
breaks between them.

1. [`src/core/errors.ts`](../../../src/core/errors.ts): delete the
   `PerFileError` interface ([`:20-25`](../../../src/core/errors.ts#L20-L25)) and
   collapse `toPerFileError`'s body
   ([`:76-90`](../../../src/core/errors.ts#L76-L90)) to:

   ```ts
     toPerFileError(
       error: unknown,
       defaultCode: ErrorCode = ErrorCode.UNKNOWN,
       path?: string,
     ): Problem {
       return Problem.fromUnknown(error, defaultCode, path);
     },
   ```

2. [`src/tools/batch.ts`](../../../src/tools/batch.ts): delete the `PerPathError`
   interface ([`:10-15`](../../../src/tools/batch.ts#L10-L15)) and change
   `PerPathResult<T>` ([`:29`](../../../src/tools/batch.ts#L29)) to use
   `Problem`, which is already imported at
   [`:4`](../../../src/tools/batch.ts#L4).

3. [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts): type
   `DeleteFailure.error` as `Problem`
   ([`:76-84`](../../../src/tools/delete-file.ts#L76-L84)) — `Problem` is already
   imported at [`:15`](../../../src/tools/delete-file.ts#L15). `toDeleteFailure`
   already returns exactly that shape via `Problem.toPerFileError`.

`code` narrows from `string` to `ErrorCode` on `DeleteFailure`. The wire schema
`PerFileErrorSchema` keeps `code: z.string()`
([`schema.ts:166-171`](../../../src/core/schema.ts#L166-L171)) — do not change
it; `ErrorCode` is a string union and validates unchanged.

**Verify**: `node scripts/tasks.mjs test` → `pass 276 fail 0`

### 8. Extract `computeDiffStats` and `unifiedPatch` into `fmt.ts`

Add both to [`src/core/fmt.ts`](../../../src/core/fmt.ts), importing
`createTwoFilesPatch` and `diffLines` from `diff`:

```ts
export function computeDiffStats(
  original: string,
  modified: string,
): { linesAdded: number; linesRemoved: number } {
  // diffLines returns the change list synchronously on diff v9.
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const part of diffLines(original, modified)) {
    if (part.added) linesAdded += part.count;
    else if (part.removed) linesRemoved += part.count;
  }
  return { linesAdded, linesRemoved };
}

// createTwoFilesPatch returns the unified diff string synchronously on diff v9
// (the { callback } option fires via setTimeout and returns undefined).
export function unifiedPatch(label: string, original: string, modified: string): string {
  return createTwoFilesPatch(label, label, original, modified, 'Original', 'Modified');
}
```

Repoint the four sites:

- [`edit.ts:179-191`](../../../src/tools/edit.ts#L179-L191): delete the local
  `computeDiffStats`; import it from `../core/fmt.js`. The call at
  [`edit.ts:321`](../../../src/tools/edit.ts#L321) is unchanged.
- [`edit.ts:425-434`](../../../src/tools/edit.ts#L425-L434):
  `editResult.diff = unifiedPatch(basename(validPath), content, editResult.content);`
- [`diff.ts:61-67`](../../../src/tools/diff.ts#L61-L67): replace the inline loop
  with `const { linesAdded, linesRemoved } = computeDiffStats(contentA, contentB);`
  — note the downstream code mutates neither, so `const` destructuring is safe.
- [`replace-in-files.ts:400-412`](../../../src/tools/replace-in-files.ts#L400-L412):
  `const patch = unifiedPatch(header, params.originalContent, params.updatedContent);`

Drop the now-unused `diffLines` / `createTwoFilesPatch` imports from any of the
three tool files where they no longer appear. `diff.ts` keeps
`createTwoFilesPatch` — its call at
[`diff.ts:51-59`](../../../src/tools/diff.ts#L51-L59) passes different headers
and is not folded.

**Verify**: `node scripts/tasks.mjs test` → `pass 276 fail 0`

### 9. Extract the post-write metadata block into `file-uri.ts`

Add to [`src/core/file-uri.ts`](../../../src/core/file-uri.ts):

```ts
export interface WrittenFileMeta {
  bytesWritten: number;
  lineCount: number;
  mimeType: string;
  kind: FileKind;
  /** Undefined when nothing was written: there is no updated content to point at. */
  resourceUri: string | undefined;
  resourceLink: ContentBlock | undefined;
}

export function buildWrittenFileMeta(
  validPath: string,
  content: string,
  opts: { written?: boolean; resourceStore?: ResourceStore | undefined },
): WrittenFileMeta {
  const bytesWritten = Buffer.byteLength(content, 'utf-8');
  const mimeInfo = detectMimeFromContent(validPath, content);
  // Omitted rather than empty-stringed when nothing matched: `""` satisfied the
  // schema's `string` and then failed every resources/read a client tried it on.
  const written = opts.written ?? true;
  return {
    bytesWritten,
    lineCount: countLines(content),
    mimeType: mimeInfo.mimeType,
    kind: mimeInfo.kind,
    resourceUri: written ? buildFileResourceUri(validPath) : undefined,
    resourceLink:
      written && opts.resourceStore
        ? buildFileResourceLink(validPath, mimeInfo.mimeType, bytesWritten)
        : undefined,
  };
}
```

`file-uri.ts` gains imports of `detectMimeFromContent` (`./mime.js`),
`countLines` (`./read.js`), `FileKind` (`./schema.js`), and `ResourceStore`
(`./store.js`).

> If any of those introduces an import cycle that `tsc` or `eslint` rejects, that
> is a [STOP](#stop) condition — report it rather than moving the helper
> elsewhere.

Repoint the three sites, each keeping its own output shape:

- [`patch.ts:43-71`](../../../src/tools/patch.ts#L43-L71): delete `PatchMeta` and
  `buildPatchMeta`; call
  `buildWrittenFileMeta(validPath, patched, { resourceStore })` and map
  `bytesWritten → size`, `resourceLink → link` at the use site. `resourceUri` is
  non-optional in `PatchOutputSchema`
  ([`patch.ts:36`](../../../src/tools/patch.ts#L36)) — with `written` defaulting
  to true it is always a string here, so assert or narrow at the use site rather
  than widening the schema.
- [`edit.ts:334-368`](../../../src/tools/edit.ts#L334-L368): delete
  `EditFileMetadata` and `buildEditFileMetadata`; call
  `buildWrittenFileMeta(validPath, content, { written: appliedEdits > 0, resourceStore })`.
- [`create.ts:98-121`](../../../src/tools/create.ts#L98-L121): replace the inline
  five steps with one call, `{ resourceStore: ctx.resourceStore }`.

> The `appliedEdits > 0` gate must survive exactly: an edit that matched nothing
> emits neither `resourceUri` nor a link.

**Verify**: `node scripts/tasks.mjs test` → `pass 276 fail 0`

### 10. Delete `getFileType`, repoint to `resolveEntryType`

Delete [`fs.ts:123-128`](../../../src/core/fs.ts#L123-L128). Repoint the three
callers to `resolveEntryType` from `../core/glob.js`:

- [`stat.ts:70`](../../../src/tools/stat.ts#L70) —
  `type: isSymlink ? 'symlink' : resolveEntryType(stats),`
- [`delete-file.ts:181`](../../../src/tools/delete-file.ts#L181) —
  `const itemType = resolveEntryType(firstStats.stats);`
- [`delete-file.ts:230`](../../../src/tools/delete-file.ts#L230) —
  `const currentItemType = resolveEntryType(currentStats.stats);`

Update both files' imports: drop `getFileType` from `../core/fs.js`, add
`resolveEntryType` from `../core/glob.js`. `delete-file.ts` keeps its
`import type { FileType, GuardedFileSystem }` — `ItemType = FileType` at
[`delete-file.ts:116`](../../../src/tools/delete-file.ts#L116) still resolves, as
`FileType` and `EntryType` are the same type. If `Stats` becomes an unused import
in `fs.ts`, remove it.

**Verify**: `node scripts/tasks.mjs test` → `pass 276 fail 0`

### 11. Reduce `GuardedFileSystem.open` to its one reachable form

Replace [`fs.ts:281-296`](../../../src/core/fs.ts#L281-L296) with:

```ts
  async open(filePath: string): Promise<FileHandle> {
    const validPath = await this.pathGuard.validateExistingPath(filePath);
    return fsOpen(validPath, 'r');
  }
```

Delete the three-line comment above it — it described the branch that is gone.
Update the one caller,
[`replace-in-files.ts:375`](../../../src/tools/replace-in-files.ts#L375), to
`await ctx.fs.open(validPath)`. If `fsConstants` is now unused in `fs.ts`, remove
its import.

**Verify**: `node scripts/tasks.mjs test` → `pass 276 fail 0`

### 12. Replace the hand-rolled basename, and cover the branch

In [`src/core/search.ts`](../../../src/core/search.ts): add
`import { basename } from 'node:path';` and replace the comparator at
[`:313-318`](../../../src/core/search.ts#L313-L318) with:

```ts
  if (options.sortBy === 'name') {
    results.sort((a, b) => basename(a.path).localeCompare(basename(b.path)));
  } else {
```

This branch has no coverage today, so add one case to
[`__tests__/core-fs.test.ts`](../../../__tests__/core-fs.test.ts), directly after
TC-FUNC-039 ([`:193-209`](../../../__tests__/core-fs.test.ts#L193-L209)), in the
same `describe('Search & Glob (TC-FUNC-039–046)')` block. It must fail if the
comparator reverts to path-order:

```ts
    it("TC-FUNC-039b: searchFiles sortBy 'name' orders by basename, not full path", async () => {
      await writeTestFile(tmpDir, 'sort_dir/zzz/alpha.ts', '// a');
      await writeTestFile(tmpDir, 'sort_dir/aaa/omega.ts', '// o');

      const sortDir = join(tmpDir, 'sort_dir');
      const byName = await searchFiles(sortDir, '**/*.ts', [], { sortBy: 'name' }, ctx.pathGuard);
      assert.deepStrictEqual(
        byName.results.map((r) => basename(r.path)),
        ['alpha.ts', 'omega.ts'],
      );

      const byPath = await searchFiles(sortDir, '**/*.ts', [], {}, ctx.pathGuard);
      assert.deepStrictEqual(
        byPath.results.map((r) => basename(r.path)),
        ['omega.ts', 'alpha.ts'],
      );
    });
```

`basename` must be added to the `node:path` import at
[`core-fs.test.ts:3`](../../../__tests__/core-fs.test.ts#L3) (currently
`dirname, join`).

> `aaa/omega.ts` sorts before `zzz/alpha.ts` by path and after it by basename —
> that opposition is what makes the test falsifying. If `byPath` comes back in
> the same order as `byName`, the fixture is wrong, not the code.

**Verify**: `node scripts/tasks.mjs test` → `pass 277 fail 0`

### 13. Fold `runOverPairs` into `move.ts` as a non-generic driver

The largest diff; it lands last so every earlier step is already green.

In [`src/tools/move.ts`](../../../src/tools/move.ts), add a module-local
`runTransfers` over the concrete types — no type parameters:

```ts
type TransferPlanResult =
  | { status: 'fail'; failure: MoveFailureItem }
  | { status: 'noop' }
  | { status: 'plan'; plan: TransferPlan };

type TransferExecResult = { readonly skipped: string } | { readonly value: MoveItemResult };

async function runTransfers(
  items: readonly z.infer<typeof MoveItemSchema>[],
  ctx: ToolCtx,
  op: PairOp,
  plan: (item: z.infer<typeof MoveItemSchema>) => Promise<TransferPlanResult>,
  execute: (plan: TransferPlan, pendingSorted: readonly string[]) => Promise<TransferExecResult>,
): Promise<
  { results: MoveItemResult[]; skipped: string[]; failures: MoveFailureItem[] } | InputRequiredResult
> {
  // body of runOverPairs, verbatim, with the type parameters resolved
}
```

Move the body of
[`batch.ts:187-302`](../../../src/tools/batch.ts#L187-L302) across **verbatim**,
including every comment: the fail-closed plan-error rethrow, the
duplicate-destination fail-closed loop and its explanation, the `pendingSorted` /
`pendingRoundTrip` R9 block with its `confirm_${i}` indexing, the progress
`tick`, and the `rethrowIfAborted` fold over `execErrors`. `verb` comes from the
existing `VERB` map at [`move.ts:69`](../../../src/tools/move.ts#L69) — use
`VERB[op]` and drop the local `const verb = opts.op === 'copy' ? …` line.

Move `pairFailure` ([`batch.ts:161-170`](../../../src/tools/batch.ts#L161-L170))
into `move.ts` too — it is the driver's helper and `move.ts` is its only other
user (`planTransfer` at
[`move.ts:117`](../../../src/tools/move.ts#L117) and
[`:138`](../../../src/tools/move.ts#L138)). Its return type becomes
`MoveFailureItem`.

Then in [`src/tools/batch.ts`](../../../src/tools/batch.ts) delete: `PairPlan`
([`:115-120`](../../../src/tools/batch.ts#L115-L120)), `PairPlanResult`
([`:122-125`](../../../src/tools/batch.ts#L122-L125)), `PairExecResult`
([`:128`](../../../src/tools/batch.ts#L128)), `PairBatchOutcome`
([`:130-134`](../../../src/tools/batch.ts#L130-L134)), `pairFailure`,
`RunOverPairsOptions` ([`:172-179`](../../../src/tools/batch.ts#L172-L179)),
`runOverPairs` with its doc comment
([`:181-302`](../../../src/tools/batch.ts#L181-L302)), and `PairFailureItem`
([`:17-27`](../../../src/tools/batch.ts#L17-L27)).

`PairFailureItem` goes with them: all five of its occurrences are in `batch.ts`,
four of them inside the code this step deletes or moves, and the fifth is
`pairFailure`'s return annotation, which moves to `move.ts` typed as
`MoveFailureItem`. `move.ts` never imported it. Leaving it behind makes it an
exported type with zero references, which `knip` reports and `check:static` fails
on — see finding 1 in
[`overeng-residue.plan-hunt.md`](overeng-residue.plan-hunt.md).

Keep in `batch.ts`: `runOverPaths`; `isTotalFailure`; `normalizeBatchItems`;
`BatchResult`; `PerPathResult`. Adjust `isTotalFailure`'s doc comment
([`:146`](../../../src/tools/batch.ts#L146)) — it names `runOverPairs`; say
"move's pair outcome" instead.

`move.ts`'s import line
([`:22-23`](../../../src/tools/move.ts#L22-L23)) becomes
`import { isTotalFailure } from './batch.js';` — one value import, no type
import. `MoveFailureItem` ([`move.ts:51`](../../../src/tools/move.ts#L51))
covers every failure-shape use inside `move.ts`. `batch.ts` may no longer need
`InputRequiredResult`, `pendingRoundTrip`, `choiceInput`,
`IS_CASE_INSENSITIVE_FS`, or `rethrowIfAborted` — drop whichever `eslint`
reports unused, and add them to `move.ts`.

Behavior that must not change, all test-pinned: an all-failed batch still reports
`isError` via `isTotalFailure`
([`move.ts:394`](../../../src/tools/move.ts#L394)); a duplicate destination still
fails closed with the same message; a pending overwrite still round-trips as
`confirm_${i}` over the **sorted** destination list; a self-move is still
silently skipped.

**Verify**: `node scripts/tasks.mjs` → exit 0, `pass 277 fail 0`

## Done

All must hold:

- [ ] `node scripts/tasks.mjs --quick` exits 0 — build, both type-checks, eslint,
      prettier, and knip clean
- [ ] `node scripts/tasks.mjs test` exits 0 with `pass 277 fail 0` (276 baseline +
      TC-FUNC-039b)
- [ ] `git status` shows no modified file outside the [Scope](#scope) in-scope
      list
- [ ] `git grep -n "PerFileError\b" src/` returns nothing (the schema's
      `PerFileErrorSchema` is a different identifier and may still match — check
      the hits are only that)
- [ ] `git grep -n "runOverPairs\|PairBatchOutcome\|PairPlanResult\|PairExecResult\|PairFailureItem\|getFileType\|createReadRangeFields\|ALL_REGISTERED_TOOL_NAMES\|ioError" src/`
      returns nothing
- [ ] `git grep -c "createTwoFilesPatch" src/` shows it only in
      `src/core/fmt.ts` and `src/tools/diff.ts`

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt — the drift check flagged a file and this plan was written against
  `6cedcca9`.
- A step's verification fails twice after one fix attempt. A second failure means
  the step's assumption is wrong, not its implementation.
- Step 9's helper introduces an import cycle (`file-uri.ts` → `mime.ts` /
  `read.ts` / `schema.ts` / `store.ts`) that `tsc` or `eslint` rejects. Do not
  relocate the helper on your own judgment — report the cycle.
- Step 13 changes any observable move/copy behavior: a different failure message,
  a different `confirm_*` key, an `isError` that flips, or a self-move that stops
  being silent. The fold is verbatim or it is wrong.
- `knip` reports an export as unused that this plan does not name. The prior
  effort's rule applies: STOP and report rather than widening the cut.
- A cut appears to require a file on the out-of-scope list — in particular
  `cli.ts`, `store.ts`, `page-store.ts`, or `path.ts`.
- The published tool schemas change: `tools.test.ts`'s TOOL-SURFACE-001 or
  TOOL-SURFACE-002 failing means a description or bound drifted, which is a wire
  change, not a cleanup.

## Notes

**For the reviewer, in descending order of suspicion:**

- **Step 13** is the only step big enough to hide a behavior change. Read it as a
  move, not a rewrite: the diff should show the same statements in the same order
  with `TPlan` → `TransferPlan` and `TResult` → `MoveItemResult`. Anything else
  in that hunk deserves a question.
- **Step 9** trades three explicit blocks for one helper plus an options object.
  The `written` flag is the `appliedEdits > 0` gate in disguise; if the parameter
  reads worse at the three call sites than the duplication did, say so — the cut
  is worth reverting, and only that one.
- **Step 5** is the weakest cut by line count: it deletes one line from `src/` and
  adds one to each of six test files. Its value is that `src/tools/index.ts` stops
  exporting for tests only; if the churn is judged not worth it, this step is
  independently droppable.

**Deliberately not done:**

- The `--safe` CLI alias stays. It is documented public surface; removing it is a
  breaking change that belongs to a release, not a cleanup.
- `delete-file.ts` is not routed through the pair driver, and `ResourceStore` is
  not merged with `PageSnapshotStore` — both adversarially refuted; see
  [Scope](#scope) for why.

**Rollback**: every step is a pure source edit on a branch, no migration and no
data. `git checkout -- src/ __tests__/` undoes uncommitted work; `git revert`
the commit undoes a landed step.
