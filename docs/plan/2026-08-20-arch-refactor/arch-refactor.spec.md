# Spec: arch-refactor

Six independent refactor findings from the architecture audit (2026-08-20).
Each is a net-deletion move that removes a domain rule duplicated across
modules. No declared boundaries exist in the repo (no ADRs, CODEOWNERS, or
import-linter), so all findings are inferred. Layering is already clean
(`src/core` never imports up), so no finding restructures zones — they
collapse duplication _within_ the existing layers.

## Requirements

- **R1** — `stoppedReason` enum + tracker duplicated across the three
  search-style tools. Lift a shared `StoppedReason` type, `StoppedReasonSchema`
  (zod), and `StopReasonTracker` into `src/core/search.ts`; remove the
  per-tool `z.enum` and the inline tracker computation (also duplicated inside
  `search.ts` itself).

- **R2** — "accessible AND non-sensitive" composition re-derived externally by
  `glob.ts` while `PathGuard` owns it privately. Expose
  `PathGuard.isEntryAccessible(entryPath, entryType)`; migrate `glob.ts` to it.
  (`path-completer.ts` and `calculate-hash.ts` do not recompose the same
  policy — see Out-of-scope.)

- **R3** — realpath→normalize→containment re-implemented at three sites.
  Export the canonical `resolveRealPath` from `path.ts`; migrate
  `path-completer.ts` and `registrar.ts` to call it instead of rolling their
  own realpath+normalize.

- **R4** — search-base resolution idiom split across 3-4 tools. Add
  `resolveSearchBase(path, fs)` to `src/core/glob.ts`; migrate
  `replace-in-files.ts`, `search-content.ts`, `search-files.ts` (the
  single-file branch in `replace-in-files.ts` survives as a tool-specific
  variation). **Dropped in plan-hunt (2026-08-20):** the move as written is
  self-halting — `resolveSearchBase` accepts a file, but `search-content` and
  `search-files` are directory-only (`validateExistingDirectory`), so migrating
  them changes a file arg from `NOT_DIRECTORY` to a silent parent-dir scan and
  trips the step's own STOP. The only non-halting rescope (a directory-only
  helper wrapping `validateExistingDirectory(resolvePathOrRoot(path))`) wraps a
  single expression — fails net-deletion. `replace-in-files.ts`'
  `resolveSearchRoot` is single-consumer. See
  [`arch-refactor.plan-hunt.md`](arch-refactor.plan-hunt.md) and
  [`arch-refactor.plan.md`](arch-refactor.plan.md) Notes.

- **R5** — `createTwoFilesPatch` setImmediate wrapper duplicated in `edit.ts`
  and `replace-in-files.ts`. Add `buildPatchDiff(label, original, modified)`
  in a new `src/core/diff.ts`; both tools call it.

- **R6** — ad-hoc `e.code === 'ENOENT'` at six sites. Add
  `isNotFoundErrno(error)` to `src/core/errors.ts`; migrate the six sites.

## Out of scope

- `src/tools/calculate-hash.ts:165` `pathGuard.isSensitive(entry.path)` —
  correct bare-sensitive skip on entries already rooted inside an allowed
  directory; not a recomposition of containment. Leave it.
- `src/core/path-completer.ts` sensitivity application — it splits policy
  (containment in `isAllowedCompletionDirectory`, sensitive per-entry in
  `findMatchesInDirectory`), addressed by R3, not R2.
- `src/core/path.ts` 1104-line Pool split — the only move is a file split
  (adds files, deletes nothing), fails the audit's net-deletion bar.
- `GuardedFileSystem.pathGuard` public field — intentional DI composition
  (`define.ts` wires both access paths to one instance), not a reach-past.
- `replace-in-files.ts` matcher extraction — single consumer, no seam.
