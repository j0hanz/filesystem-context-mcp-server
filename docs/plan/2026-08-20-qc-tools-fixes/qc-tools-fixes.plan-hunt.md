# Plan Hunt: qc-tools-fixes

Hunted [`qc-tools-fixes.plan.md`](qc-tools-fixes.plan.md) against the repo as it
is at `3e00223`. Every step's cited path and symbol was verified during the
write-plan recon; this pass checked the dead-step tells (invented API, path that
won't resolve, convention violated, step with no gate, version assumed) and sent
the one non-obvious invariant to a blind refuter.

## Result

Zero confirmed defects. The plan forwards to run-plan.

## Steps checked

- **Step 1** (edit.ts `owned`): `findEditMatch` is not exported; sole caller
  `applyEdits` at [`edit.ts:400-404`](../../../src/tools/edit.ts#L400-L404)
  passes `regexCache = ignoreWhitespace ? new Map() : undefined`, so the regex
  branch always sees a `Map` and `owned` is always false. `freeRegex` stays
  used at [`edit.ts:417`](../../../src/tools/edit.ts#L417). Dead path confirmed.
- **Step 2** (read.ts comment): line
  [`read.ts:327`](../../../src/tools/read.ts#L327) exists with the `--- IGNORE ---`
  artifact. Comment-only edit.
- **Step 3** (search-content dead returns): `run` at
  [`:426`](../../../src/tools/search-content.ts#L426) destructures only
  `{ structured, link }`; `SearchOutput` is in scope (used at `:377`).
  `progressDone` uses schema fields `totalMatches`/`filesMatched`, not the
  locals. Dead returns confirmed.
- **Step 4** (search-files `count`): `run` at
  [`:218`](../../../src/tools/search-files.ts#L218) destructures only
  `{ structured, link }`; `progressDone` uses schema `totalMatches`. Dead return
  confirmed.
- **Step 5** (_helpers): all five `putResource` call sites and both unit tests
  pass only `store/name/mimeType/kind/content`. `buildLinkBlock` is called only
  by `buildFileResourceLink` and `putResource`. `Role` stays imported. The plan
  renames the new `audience` param to `audienceParam` to avoid the
  used-before-declaration shadow — handled.
- **Step 6** (toDeleteFailure collapse): **refuter verdict `confirmed`** —
  `Problem.fromUnknown` ([`errors.ts:75-91`](../../../src/core/errors.ts#L75-L91))
  only substitutes `defaultCode` when `classify` returns `UNKNOWN`/`IO_ERROR`
  ([`:77-79`](../../../src/core/errors.ts#L77-L79)); `ERRNO_MAP`
  ([`:119-121`](../../../src/core/errors.ts#L119-L121)) already classifies
  `ENOENT`→`NOT_FOUND` and `EPERM`/`EACCES`→`PERMISSION_DENIED`, so the explicit
  branches' `defaultCode` is dead weight and the fallthrough is byte-identical
  in code, message, path, and suggestion. `details` is dropped by `fromUnknown`
  in both cases and is not on the wire
  ([`DeleteFailureItemSchema`](../../../src/tools/delete-file.ts#L30-L36) exposes
  only `code`+`message`). FsError carriers already fell through (their `code`
  getter returns an `ErrorCode` string, never an errno), so the collapse changes
  nothing for them. Delete-tool tests
  ([`directory.test.ts:555`](../../../__tests__/tools/directory.test.ts#L555),
  [`:849`](../../../__tests__/tools/directory.test.ts#L849)) assert exactly the
  codes `classify` yields.
- **Step 7** (list braces): the `{ ... }` block at
  [`list.ts:263-311`](../../../src/tools/list.ts#L263-L311) has no condition,
  no outer variable to shadow, and nothing after it. Pure noise.
- **Step 8** (define.ts comment): the JSDoc at
  [`define.ts:223-226`](../../../src/tools/define.ts#L223-L226) describes a
  `result.structured as Record<string, unknown>` cast absent from
  `buildSuccessResponse` ([`:227-234`](../../../src/tools/define.ts#L227-L234));
  the `--quick` gate passes without it. Stale.

## Gates

All eight steps name a Verify command with expected output (`node scripts/tasks
.mjs --quick` → exit 0, 4/4 passed; step 5 and step 6 also run the full suite).
No step adds behavior without a gate.

## Out-of-scope rejections (held)

The three items the review named but the plan correctly excludes are dead
rejections, not live candidates: `progress.ts` `#total` is a tested public
feature (`progress-session.test.ts`); `delete-file.ts` `handleDelete` and
`create.ts` do not match the `runOverPaths` output shape and would introduce
behavior changes, not net-deletion.

## Forward

Zero findings → forward to
[run-plan](../run-plan/SKILL.md) against [`qc-tools-fixes.plan.md`](qc-tools-fixes.plan.md).
