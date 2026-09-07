# Bug hunt: overeng-residue

**Subject** the uncommitted diff on `refactor/overeng-residue` vs `6cedcca9` — 26
files, 329 insertions, 437 deletions. **Hunted** 2026-09-07.

**Verdict: no defect found.** Every cut is behavior-identical on the paths this
diff touches; two candidates were raised and both were killed by blind refuters.

## Confirmed

None.

## Suspected

None.

## Killed

Reported so a later hunt does not re-raise them.

### 1. `edit.ts` builds a resource link on the no-match path

`buildEditFileMetadata` ([`edit.ts:328`](../../../src/tools/edit.ts#L328)) now
calls `buildWrittenFileMeta` unconditionally and blanks the result when
`appliedEdits === 0`, where the old code short-circuited before building
anything. Claim was that a side effect inside the link builder would now fire on
an unmatched edit and on every dry run.

**Killed** — the link builder never receives the store, so no store mutation is
reachable by construction:

```ts
    resourceLink: resourceStore
      ? buildFileResourceLink(validPath, mimeInfo.mimeType, bytesWritten)
      : undefined,
```

`resourceStore` is consumed as a boolean gate and never passed onward
([`file-uri.ts:113-115`](../../../src/core/file-uri.ts#L113-L115)).
`buildFileResourceLink` and `buildFileResourceUri` are pure constructors. The
extra work on the blanked path is a `Buffer.byteLength`, a MIME sniff, a line
count, and two object literals, all discarded. No `notifications/resources/list_changed`
can be emitted.

### 2. `GuardedFileSystem.open` lost its write-capable branch

[`fs.ts:268`](../../../src/core/fs.ts#L268) now always takes
`validateExistingPath` and hardcodes `'r'`. Claim was a guard bypass or an EBADF
on a write-intending caller, or a lost `--read-only` enforcement point.

**Killed** on three counts:

- The sole caller is read-only end to end —
  [`replace-in-files.ts:374`](../../../src/tools/replace-in-files.ts#L374) opens,
  stats, then hands the handle to `readFileBufferWithLimit`, which only calls
  `handle.createReadStream(...)`. It passed `'r'` explicitly before the cut, so
  the write branch had no reachable caller either.
- Writes in that tool never go through `open`; they go through `atomicWriteFile`,
  whose first act is `await pathGuard.validatePathForWrite(filePath)`
  ([`fs.ts:66`](../../../src/core/fs.ts#L66)). The write guard is intact on the
  only path that writes.
- `validatePathForWrite` is not the `--read-only` enforcement point.
  `registeredTools(readOnly)` ([`index.ts:41-44`](../../../src/tools/index.ts#L41-L44))
  owns that gate; in read-only mode the mutating tools are never registered, so
  no request reaches `open` or `writeFile`.

## Checked and clean

Each considered against the taxonomy and dismissed with the reason.

| Cut | Why it is behavior-identical |
| :--- | :--- |
| `toPerFileError` returns `Problem` | `fromUnknown` already returns that exact shape via `build()`, with the same spread-conditional key omission; both allocate fresh. |
| `PerPathError` / `DeleteFailure.error` → `Problem` | `code` narrows `string` → `ErrorCode` at compile time only; the wire schema `PerFileErrorSchema` keeps `code: z.string()` and validates unchanged. `readonly` is erased. |
| `getFileType` → `resolveEntryType` | The isFile/isDirectory check order differs but never the result: `Stats` derives its type from `S_IFMT`, so exactly one predicate is true. `Stats` structurally satisfies `DirentLike`; `FileType` **is** `EntryType` (`fs.ts:28` aliases the import). |
| `buildWrittenFileMeta` gate | `resourceStore !== undefined` (old patch.ts) vs truthiness (new): a `ResourceStore` instance is always truthy. `create.ts`'s `meta.resourceLink ? …` is truthy exactly when the store is, since `buildFileResourceLink` always returns an object. |
| `annotations` param deleted | All six call sites already omitted it; the inlined literal is the same object the default produced. |
| `createReadRangeFields` inlined | Same bounds, same messages, same four fields. TOOL-SURFACE-001/002 pin the emitted schema and pass. |
| `maxBatch` deleted | Both callers passed only `{ extra }`; `DEFAULT_MAX_BATCH` is the value the fallback produced. |
| `runOverPairs` → `runTransfers` | Body moved verbatim. Only substitution: `const verb = opts.op === 'copy' ? 'Copy' : 'Move'` → `VERB[op]`, which is `{ move: 'Move', copy: 'Copy' }` — identical strings. Plan-error rethrow, duplicate-destination fail-closed message, `confirm_${i}` indexing over the sorted pending list, progress tick, and `rethrowIfAborted` fold all unchanged. |
| `ToolCtx.sessionId` / `.server` deleted | Neither was read. Every `.server` hit in `src/` is `mcp.server` (a different object) or `deps.server` (`ToolDeps`, kept). `resources.test.ts:30` builds a fake `ServerContext`, not a `ToolCtx`. |
| `Problem.ioError` deleted | Zero callers. `ErrorCode.IO_ERROR` is still produced by `ERRNO_MAP` classification and still read by `fromUnknown`'s `shouldOverride`. |
| `file-uri.ts`'s new imports | No cycle: `mime.ts`, `read.ts`, `store.ts` and `schema.ts` do not import `file-uri.ts`. `FileKind` and `ResourceStore` are type-only imports and erase. |
| `fmt.ts` gains `diff` | `src/core/` already imports `ignore`, `@adguard/re2-wasm`, and `zod`. No import-boundary lint covers `src/core/**`. |

## Behavior that did change, by design

`searchFiles` `sortBy: 'name'` now uses `basename()` instead of splitting on
`[/\\]`. On POSIX a filename containing a literal `\` sorts differently — the old
comparator treated the backslash as a separator, which was wrong. The plan calls
this a fix, not a preservation. On Windows the two are identical, because
`path.win32.basename` splits on both separators.

## Coverage

**Read in full**: the complete diff of all 19 `src/` files at `-U8`, plus the
whole of `src/tools/move.ts`'s new `runTransfers` and the surrounding
`planTransfer`/`executeTransfer`; the complete diff of all 7 test files.

**Blast radius opened**: `src/core/store.ts` (link-builder purity),
`src/core/path.ts` (`validatePathForWrite`, `--read-only`), `src/core/read.ts`
(import chain and `readFileBufferWithLimit`), `src/core/glob.ts`
(`resolveEntryType`, `DirentLike`), `src/core/mime.ts` and `src/core/schema.ts`
(cycle check only), `eslint.config.mjs`, `knip.json`, `tsconfig.json`.

**Not audited**: the unchanged bodies of the large files this diff only touches in
part — `replace-in-files.ts`, `read.ts`, `define.ts`, `delete-file.ts`,
`tools.test.ts` — read only far enough to judge the changed contract, per scope.
The security core (`path.ts`'s containment, the sensitive denylist, ADS
stripping, `http-policy.ts`) is unchanged by this diff and was not re-audited.

**Taken on trust**: that `diff` v9's `diffLines` and `createTwoFilesPatch` return
synchronously — the moved comments assert it, the behavior is unchanged by this
diff, and 277 tests exercise both.

**Not run**: this is a static hunt. The gate (`node scripts/tasks.mjs`, exit 0,
277 pass) was run by run-plan, not by the hunt.
