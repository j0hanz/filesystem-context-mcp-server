# Run: Delete the unreachable and single-implementation surface

Executing [`trim-dead-surface.plan.md`](trim-dead-surface.plan.md), started
2026-09-05 at `0223af11`, on branch `chore/trim-dead-surface`. One commit per
step, per the plan's Notes.

Drift check clean: `git diff --stat 0223af11..HEAD -- src/ __tests__/ scripts/ README.md package.json`
returned no rows, working tree held only the untracked plan directory.

- **1** 2026-09-05 — done. `node scripts/tasks.mjs --quick` → exit 0, `All matched files use Prettier code style!`; `git status --porcelain scripts/` → 8 `D` entries, no modifications; `ls scripts/` → `tasks.mjs`. Commit `8e375a1b`.
- **2** 2026-09-05 — done, with one deviation. `node scripts/tasks.mjs test` → `tests 265`, `suites 62`, `pass 265`, `fail 0` — exactly the plan's predicted counts. `grep -rn "deploymentMode\|assertFleetRequestStateKey" src/ __tests__/ README.md` → no matches; `grep -rn "eventBus" src/` → no matches. Commit `1b6e103a`.

  **Deviation — a fourth fleet block the plan did not name.** The first `--quick` failed with `TS2304: Cannot find name 'assertFleetRequestStateKey'` at [`input-required.test.ts:29`](../../../__tests__/input-required.test.ts#L29), inside `describe('fleet request-state key initialization')` — a block the plan's step 2d never listed. Read on its merits, that test asserts the codec picks up `FS_REQUEST_STATE_KEY` set after import, which survives the deletion; the `assertFleetRequestStateKey(true)` call was only forcing lazy codec construction, and the first `mint` does that anyway. Kept the test, dropped the call, renamed the block to `request-state key initialization`, and trimmed the now-unused `beforeEach`/`afterEach` import. Test count is unaffected — still the 10 tests the plan predicted removing.

  Also: the README table re-padded under Prettier because the replacement `FS_REQUEST_STATE_KEY` row is shorter than the old one, so the whole table narrowed. Content-preserving; `git diff -w` shows only the two intended rows.
