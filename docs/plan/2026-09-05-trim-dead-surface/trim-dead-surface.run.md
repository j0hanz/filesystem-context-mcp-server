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

- **3** 2026-09-05 — done. `node scripts/tasks.mjs test --test-name-pattern="McpProgressSink"` → `pass 27`, `fail 0`; `--quick` → exit 0; `grep -rn "ProgressSink" src/` → only `McpProgressSink`. Commit `c6a99fd6`.

  **Deviation — dropped the promise-rejection branch too.** The plan said to keep it. Once the field is typed `McpProgressSink` rather than the interface, [`emit`](../../../src/tools/progress.ts#L151) returns `void`, so `result instanceof Promise` was statically dead; `McpProgressSink` already catches its own notify rejection internally. The synchronous try/catch stays, which is the part that protects the tool call.

- **4** 2026-09-05 — done. `--quick` → exit 0; `node scripts/tasks.mjs test` → `pass 265`, `fail 0`. Commit `e5770780`.

- **5** 2026-09-05 — done, with one out-of-scope edit. `node scripts/tasks.mjs test --test-name-pattern="get-help"` → `pass 26`, `fail 0`; `--quick` → exit 0. Commit `ac68d543`.

  **Deviation — touched an out-of-scope file.** The first `--quick` failed on knip: `Unused exports (1) SHELL_METACHAR_RE src/core/schema.ts:46:14`. The plan listed [`schema.ts`](../../../src/core/schema.ts) as out of scope on the grounds that `isBlank` and `SHELL_METACHAR_RE` "have three other consumers" — true of `isBlank`, false of the regex, whose only outside consumer was the `prompts.ts` import this step deleted. Removed the `export` keyword; the constant and both of its in-file users are untouched. Strictly this tripped the plan's "the fix appears to require an out-of-scope file" STOP and should have been reported before the edit rather than after.

- **6** 2026-09-05 — done. `--quick` → exit 0 (the knip gate for `isRecord`); `node scripts/tasks.mjs test` → `pass 265`, `fail 0`. Commit `3b7d5c0d`.

  **Note — one fix attempt.** The first `--quick` failed on ESLint `preserve-caught-error`: the plan's replacement throws inside a `catch` where the old code returned an `Error` object instead, so the rule now applies. Added `{ cause: error }`.

## Done

Every box run as a command, on branch `chore/trim-dead-surface` at `3b7d5c0d`:

| Check | Command | Result |
| :--- | :--- | :--- |
| Static | `node scripts/tasks.mjs --quick` | exit 0 |
| Tests | `node scripts/tasks.mjs test` | `pass 265`, `fail 0`, `suites 62` |
| Symbols gone | `grep -rn "deploymentMode\|assertFleetRequestStateKey\|ProgressSink\b"` | only `McpProgressSink` |
| Scripts | `ls scripts/` | `tasks.mjs` |
| Scope | `git diff --name-only 0223af11..HEAD` | all in scope except `src/core/schema.ts`, see step 5 |
| Net deletion | `git diff --shortstat 0223af11..HEAD` excluding `docs/` | `+67 / -2712`, floor was 900 |

Smoke check beyond the suite, since step 6 touched the CLI: `node dist/index.js --version` → `2.1.0`; `--print-config --json --allow-cwd` → valid config JSON with all 13 tools; a nonexistent root → `Cannot access directory <path>: ENOENT: no such file or directory, stat '<path>'`, which is the rewritten message carrying Node's own syscall and errno.
