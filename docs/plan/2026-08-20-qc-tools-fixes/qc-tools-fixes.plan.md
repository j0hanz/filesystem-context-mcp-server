# Plan: Cut dead code and stale comments surfaced by the src/tools QC review

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `3e00223`, 2026-08-20.
> **Drift check (run first)**: `git diff --stat 3e00223..HEAD -- src/tools/edit.ts src/tools/read.ts src/tools/search-content.ts src/tools/search-files.ts src/tools/_helpers.ts src/tools/delete-file.ts src/tools/list.ts src/tools/define.ts`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

The QC review of the `dev`-branch `src/tools` refactor found dead code shipped as
behavior-preserving deletions that didn't go far enough, plus one stale comment
and one garbled comment. Each is a small load-bearing fact a reader must decode
later. This plan deletes the dead paths and fixes the two comments — pure
deletion / comment edits, no behavior change. Requirements: none, this is a fix.

## Current state

- [`src/tools/edit.ts:175-227`](../../../src/tools/edit.ts#L175-L227) —
  `findEditMatch(content, oldText, ignoreWhitespace, regexCache?)`. The regex
  branch (entered only when `ignoreWhitespace`) reads:

  ```ts
  let regex = regexCache?.get(pattern);
  const owned = regex === undefined && regexCache === undefined;
  if (!regex) {
    regex = compileRegex(pattern, { caseSensitive: true });
    regexCache?.set(pattern, regex);
  }
  regex.lastIndex = 0;
  const match = regex.exec(content);
  // With no cache to free it later, this call owns the wasm memory. `match`
  // is a plain array by now, so releasing the pattern here is safe.
  if (owned) freeRegex(regex);
  ```

  The sole caller is `applyEdits` at [`edit.ts:400-404`](../../../src/tools/edit.ts#L400-L404):
  `const regexCache = ignoreWhitespace ? new Map<...>() : undefined;` then
  `findEditMatch(newContent, edit.oldText, ignoreWhitespace, regexCache)`. So
  whenever the regex branch runs, `regexCache` is a `Map`, `owned` is always
  `false`, and the `if (owned) freeRegex(regex)` branch + its comment are
  unreachable. `findEditMatch` is not exported, so no other caller can pass
  `undefined` to reach it. `freeRegex` stays imported — `applyEdits`' `finally`
  at [`edit.ts:417`](../../../src/tools/edit.ts#L417) frees every cached regex.

- [`src/tools/read.ts:326-329`](../../../src/tools/read.ts#L326-L329) —

  ```ts
  if (args.includeHash) {
    // Hash the content as read (after truncation, if applicable) to avoid --- IGNORE ---
    value.contentHash = createHash('sha256').update(result.content, 'utf-8').digest('hex');
  }
  ```

  The `--- IGNORE ---` tail is a leftover artifact; the sentence never finishes
  what the hash avoids.

- [`src/tools/search-content.ts:341-399`](../../../src/tools/search-content.ts#L341-L399)
  — `handleSearchContent` returns `{ structured, link?, matchCount, fileCount }`
  and computes `matchCount = matchPayloads.length` / `fileCount = new
Set(matchPayloads.map((m) => m.file)).size` at
  [`:383-384`](../../../src/tools/search-content.ts#L383-L384). The `run` at
  [`:426`](../../../src/tools/search-content.ts#L426) destructures only
  `{ structured, link }`; both fields are thrown away. `progressDone` at
  [`:422-424`](../../../src/tools/search-content.ts#L422-L424) uses
  `result.totalMatches` / `result.filesMatched` — schema fields on `SearchOutput`
  ([`:131-134`](../../../src/tools/search-content.ts#L131-L134)), not these
  locals — so it is unaffected.

- [`src/tools/search-files.ts:122-191`](../../../src/tools/search-files.ts#L122-L191)
  — `handleSearchFiles` returns `{ structured, link?, count }` with `count:
relativeResults.length` at [`:186`](../../../src/tools/search-files.ts#L186)
  and [`:190`](../../../src/tools/search-files.ts#L190). The `run` at
  [`:218`](../../../src/tools/search-files.ts#L218) destructures only
  `{ structured, link }`; `count` is thrown away. `progressDone` at
  [`:214-216`](../../../src/tools/search-files.ts#L214-L216) uses
  `result.totalMatches` (schema field), not `count`.

- [`src/tools/_helpers.ts:12-50`](../../../src/tools/_helpers.ts#L12-L50) —
  `PutResourceParams` declares `audience?`, `title?`, `description?`
  ([`:18-20`](../../../src/tools/_helpers.ts#L18-L20)); `buildLinkBlock` takes
  `params?: { audience?; title?; description? }` and spreads `title`/`description`
  ([`:46-47`](../../../src/tools/_helpers.ts#L46-L47)). All five `putResource`
  call sites (calculate-hash, list, search-content, search-files, stat — and
  both unit tests) pass only `store/name/mimeType/kind/content`; none passes
  `audience`/`title`/`description`. `putResource` builds a `linkParams` object
  from those three ([`:79-83`](../../../src/tools/_helpers.ts#L79-L83)) that is
  always `{}`, then calls `buildLinkBlock`. `buildFileResourceLink`
  ([`:54-62`](../../../src/tools/_helpers.ts#L54-L62)) is the only audience
  setter, passing `{ audience: ['user', 'assistant'] }`. Test
  [`__tests__/unit/shared-resource-response.test.ts:19`](../../../__tests__/unit/shared-resource-response.test.ts#L19)
  asserts a `putResource` link's `annotations.audience` deepEquals `['user']` —
  that comes from `buildLinkBlock`'s default `params?.audience ?? ['user']`, so
  it holds after the default is applied with no params. `Role` stays imported
  (buildLinkBlock's audience param + buildFileResourceLink still use it).

- [`src/tools/delete-file.ts:74-100`](../../../src/tools/delete-file.ts#L74-L100)
  — `toDeleteFailure`:

  ```ts
  function toDeleteFailure(path: string, error: unknown): DeleteFailure {
    if (isNodeError(error)) {
      if (error.code === 'ENOENT') {
        return { path, error: Problem.fromUnknown(error, ErrorCode.NOT_FOUND, path) };
      }
      if (error.code === 'ENOTEMPTY' || error.code === 'EISDIR' || error.code === 'EEXIST') {
        return {
          path,
          error: Problem.fromUnknown(
            new Error('Directory not empty. Set recursive: true.'),
            ErrorCode.INVALID_INPUT,
            path,
          ),
        };
      }
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        return { path, error: Problem.fromUnknown(error, ErrorCode.PERMISSION_DENIED, path) };
      }
    }
    return { path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path) };
  }
  ```

  [`core/errors.ts`](../../../src/core/errors.ts) `Problem.fromUnknown` calls
  `classify` which maps errno via `ERRNO_MAP`
  ([`:118-133`](../../../src/core/errors.ts#L118-L133)): `ENOENT`→`NOT_FOUND`,
  `EACCES`/`EPERM`→`PERMISSION_DENIED`. `fromUnknown` only overrides the code
  when `classify` returns `UNKNOWN`/`IO_ERROR`
  ([`:75-91`](../../../src/core/errors.ts#L75-L91)); for `ENOENT`/`EPERM`/`EACCES`
  the classified code wins, so `Problem.fromUnknown(error, ErrorCode.NOT_FOUND,
path)` and `Problem.fromUnknown(error, ErrorCode.PERMISSION_DENIED, path)` are
  byte-identical to `Problem.fromUnknown(error, ErrorCode.UNKNOWN, path)` — the
  explicit `defaultCode` is ignored. The `ENOTEMPTY`/`EISDIR`/`EEXIST` branch
  is the only one that earns its keep: it swaps in the friendly "Set recursive:
  true" message and `INVALID_INPUT` code (a raw `ENOTEMPTY` would classify to
  `NOT_DIRECTORY` with the OS message). `isNodeError` stays imported (the
  surviving branch needs it).

- [`src/tools/list.ts:263-311`](../../../src/tools/list.ts#L263-L311) —
  `handleList` wraps its entire body in a `{ ... }` block with no condition and
  no outer variable to shadow; `return output` sits inside it and nothing
  follows the block. The braces are pure noise.

- [`src/tools/define.ts:223-234`](../../../src/tools/define.ts#L223-L234) —
  ```ts
  /**
   * The cast `result.structured as Record<string, unknown>` is required by the MCP SDK's `CallToolResult.structuredContent` type.
   * Callers MUST ensure tool output schemas resolve to object types (not primitives), otherwise the cast is silently unsound.
   */
  function buildSuccessResponse<O>(result: RunResult<O>): CallToolResult {
    const text = result.text ?? JSON.stringify(result.structured);
    const content: ContentBlock[] = [{ type: 'text' as const, text }, ...(result.resources ?? [])];
    return { content, structuredContent: result.structured };
  }
  ```
  The comment describes a cast that is not in the body (`structuredContent:
result.structured`, no cast). The file typechecks without it (the
  `--quick` gate passes), so the cast is not required at the current SDK version.
  Stale comment.

## Commands

| Purpose | Command                          | Expected on success            |
| ------- | -------------------------------- | ------------------------------ |
| Static  | `node scripts/tasks.mjs --quick` | exit 0, 4/4 passed (2 skipped) |
| Full    | `node scripts/tasks.mjs`         | exit 0, all pass               |

## Scope

**In scope** — the only files to modify:

- [`src/tools/edit.ts`](../../../src/tools/edit.ts)
- [`src/tools/read.ts`](../../../src/tools/read.ts)
- [`src/tools/search-content.ts`](../../../src/tools/search-content.ts)
- [`src/tools/search-files.ts`](../../../src/tools/search-files.ts)
- [`src/tools/_helpers.ts`](../../../src/tools/_helpers.ts)
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts)
- [`src/tools/list.ts`](../../../src/tools/list.ts)
- [`src/tools/define.ts`](../../../src/tools/define.ts)

**Files out of scope** — leave alone even though the review named them:

- [`src/tools/progress.ts`](../../../src/tools/progress.ts) — `ProgressSession.#total`
  is NOT dead: `__tests__/unit/progress-session.test.ts` passes `total` to the
  constructor and asserts it flows through `set` (when per-call `total` is
  omitted) and through `complete`/`fail`. It is a tested public feature; the
  production caller simply does not use it. Removing it breaks the test suite.
- [`src/tools/delete-file.ts` `handleDelete`](../../../src/tools/delete-file.ts#L254-L299)
  — do NOT reshape onto `runOverPaths`. delete's output shape is
  `{ ok, path?, paths?, failures? }`, not the `{ ok, results, summary }` that
  `runOverPaths` produces, so it would not collapse. `deleteSinglePath` can
  throw (`tryElicitConfirmation` at [`:192`](../../../src/tools/delete-file.ts#L192)
  is outside any try/catch), so the `errors` loop at
  [`:280-286`](../../../src/tools/delete-file.ts#L280-L286) is a real safety net,
  not dead code. (The `toDeleteFailure` collapse in step 6 is in scope; the
  `handleDelete` orchestration is not.)
- [`src/tools/create.ts`](../../../src/tools/create.ts) — do NOT switch the
  serial `for` loop to `runOverPaths`. `runOverPaths` runs in parallel
  (`processInParallel`), which is a write-concurrency behavior change, and
  create's output (`{ ok, files, failures? }`) plus the `links[]` aggregation
  would need a mapping layer. Not net-deletion.

## Steps

### 1. Delete the unreachable `owned` path in `findEditMatch`

In [`src/tools/edit.ts`](../../../src/tools/edit.ts), inside `findEditMatch`'s
`if (ignoreWhitespace)` branch, remove the `owned` flag, the `if (owned)
freeRegex(regex)` statement, and the two-line comment above it. The branch
becomes:

```ts
let regex = regexCache?.get(pattern);
if (!regex) {
  regex = compileRegex(pattern, { caseSensitive: true });
  regexCache?.set(pattern, regex);
}
// The compiled regex is global and may come from the cache, so lastIndex
// still points past the previous edit's match — reset before searching.
regex.lastIndex = 0;
const match = regex.exec(content);
```

Keep the `freeRegex` import (still used at `applyEdits`' `finally`).

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, 4/4 passed (2 skipped).

### 2. Fix the garbled comment in `applyOptionalFeatures`

In [`src/tools/read.ts:327`](../../../src/tools/read.ts#L327), replace the
garbled line with a complete sentence stating what the hash avoids. Target:

```ts
if (args.includeHash) {
  // Hash the post-truncation content so callers can detect partial reads
  // without re-reading the (possibly truncated) file body.
  value.contentHash = createHash('sha256').update(result.content, 'utf-8').digest('hex');
}
```

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, 4/4 passed (2 skipped).

### 3. Drop the dead `matchCount`/`fileCount` return from `handleSearchContent`

In [`src/tools/search-content.ts`](../../../src/tools/search-content.ts):

- Change the `handleSearchContent` return type
  ([`:346-351`](../../../src/tools/search-content.ts#L346-L351)) to
  `{ structured: SearchOutput; link?: ReturnType<typeof putResource>['link'] }`.
- Delete the two computations at
  [`:383-384`](../../../src/tools/search-content.ts#L383-L384)
  (`const matchCount = ...` / `const fileCount = new Set(...).size;`).
- Change the return at
  [`:393-398`](../../../src/tools/search-content.ts#L393-L398) to
  `{ structured, ...(link !== undefined ? { link } : {}) }`.

`run` at [`:426`](../../../src/tools/search-content.ts#L426) already
destructures only `{ structured, link }`, so no caller changes.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, 4/4 passed (2 skipped).

### 4. Drop the dead `count` return from `handleSearchFiles`

In [`src/tools/search-files.ts`](../../../src/tools/search-files.ts):

- Change the `handleSearchFiles` return type
  ([`:127-131`](../../../src/tools/search-files.ts#L127-L131)) to
  `{ structured: z.infer<typeof SearchFilesOutputSchema>; link?: ReturnType<typeof putResource>['link'] }`.
- In the truncated branch return at
  [`:180-187`](../../../src/tools/search-files.ts#L180-L187), drop `count:
relativeResults.length,`.
- In the final return at
  [`:190`](../../../src/tools/search-files.ts#L190), change to
  `return { structured };`.

`run` at [`:218`](../../../src/tools/search-files.ts#L218) already
destructures only `{ structured, link }`.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, 4/4 passed (2 skipped).

### 5. Tighten `PutResourceParams` and `buildLinkBlock`

In [`src/tools/_helpers.ts`](../../../src/tools/_helpers.ts):

- Remove `audience?`, `title?`, `description?` from `PutResourceParams`
  ([`:18-20`](../../../src/tools/_helpers.ts#L18-L20)); the interface keeps only
  `store`, `name`, `mimeType`, `kind`, `content`.
- Change `buildLinkBlock`'s 5th param from `params?: { audience?: Role[];
title?: string; description?: string }` to a direct `audience?: Role[]`.
  Update the body: `const audience = audienceParam ?? ['user'];` (rename the
  param to avoid shadowing) and delete the `title`/`description` spreads at
  [`:46-47`](../../../src/tools/_helpers.ts#L46-L47). The result keeps
  `annotations: { audience }`.
- Update `buildFileResourceLink` ([`:59`](../../../src/tools/_helpers.ts#L59))
  to pass `['user', 'assistant']` as the 5th arg directly instead of
  `{ audience: ['user', 'assistant'] }`.
- In `putResource` ([`:79-85`](../../../src/tools/_helpers.ts#L79-L85)), delete
  the `linkParams` object and call
  `buildLinkBlock(entry.uri, entry.name, entry.mimeType, entry.size)` with no
  audience arg (defaults to `['user']`, matching today's behavior).

`Role` stays imported (used by `buildLinkBlock` and `buildFileResourceLink`).

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, 4/4 passed (2 skipped).
Then `node scripts/tasks.mjs` → all pass (confirms
`shared-resource-response.test.ts:19` still sees `audience` `['user']`).

### 6. Collapse `toDeleteFailure` to the one override + fallthrough

In [`src/tools/delete-file.ts:74-100`](../../../src/tools/delete-file.ts#L74-L100),
replace the body with:

```ts
function toDeleteFailure(path: string, error: unknown): DeleteFailure {
  if (
    isNodeError(error) &&
    (error.code === 'ENOTEMPTY' || error.code === 'EISDIR' || error.code === 'EEXIST')
  ) {
    return {
      path,
      error: Problem.fromUnknown(
        new Error('Directory not empty. Set recursive: true.'),
        ErrorCode.INVALID_INPUT,
        path,
      ),
    };
  }
  return { path, error: Problem.fromUnknown(error, ErrorCode.UNKNOWN, path) };
}
```

The `ENOENT` and `EPERM`/`EACCES` branches are removed: `Problem.fromUnknown`
classifies them to the same code via `ERRNO_MAP` (see Current state). `isNodeError`
and `ErrorCode` stay imported.

**Verify**: `node scripts/tasks.mjs` → all pass (the delete tests assert
`NOT_FOUND` / `PERMISSION_DENIED` codes, which the fallthrough still produces).

### 7. Delete the wrapping braces in `handleList`

In [`src/tools/list.ts:263-311`](../../../src/tools/list.ts#L263-L311), remove
the bare `{` at `:263` and the matching `}` at `:311`, de-indenting the body one
level. `return output;` becomes the function's return; nothing follows the block.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, 4/4 passed (2 skipped).

### 8. Delete the stale cast comment in `buildSuccessResponse`

In [`src/tools/define.ts:223-226`](../../../src/tools/define.ts#L223-L226),
delete the JSDoc block that references the `result.structured as
Record<string, unknown>` cast. The cast is not present in the body and the file
typechecks without it, so the comment is stale. Leave the function body unchanged.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, 4/4 passed (2 skipped).

## Done

Machine-checkable. All must hold:

- [ ] `node scripts/tasks.mjs --quick` exits 0
- [ ] `node scripts/tasks.mjs` exits 0, including `progress-session.test.ts`,
      `shared-resource-response.test.ts`, and the delete-tool tests
- [ ] `git status` shows changes only in the eight in-scope files
- [ ] `git diff` shows no new behavior — only deletions, de-indents, and the
      two comment rewrites

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt (run the drift check first).
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation.
- A deletion causes a test failure that a behavior-preserving edit should not —
  that means the dead path was actually load-bearing (re-examine before
  re-adding anything).
- `Problem.fromUnknown(error, ErrorCode.UNKNOWN, path)` does NOT classify
  `ENOENT`→`NOT_FOUND` or `EPERM`/`EACCES`→`PERMISSION_DENIED` for a real
  `NodeJS.ErrnoException` — the `ERRNO_MAP` table or the `shouldOverride` rule
  in `core/errors.ts` has changed, and step 6 must be abandoned.

## Notes

- What a reviewer should scrutinize: step 5 (the `buildLinkBlock` signature
  change) and step 6 (the `toDeleteFailure` collapse) are the only edits where
  behavior-preservation rests on a non-obvious invariant — the `ERRNO_MAP`
  classification and the `['user']` audience default respectively. The rest are
  mechanical deletions.
- Deliberately deferred: the three out-of-scope items in Scope. They are real
  design questions (progress `#total` is a tested feature; delete/create batch
  shapes differ from `runOverPaths`), not dead code.
- No rollback needed — all edits are deletions/comment fixes in version control.
