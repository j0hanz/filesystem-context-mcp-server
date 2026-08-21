# Run: Derive the mutating-tool roster from tool annotations

Executing [`tool-roster-single-owner.plan.md`](tool-roster-single-owner.plan.md),
started 2026-08-21 at `606f71c`.

- **Orient** 2026-08-21 — done. `git diff --stat 606f71c..HEAD -- src/tools src/resources.ts src/cli.ts src/prompts.ts __tests__` → 0 lines. No files flagged, so no Current state excerpt needed re-matching. No prior run log; started at Step 0.
- **0** 2026-08-21 — **STOP**: the step's stated must-hold did not occur. `npm run format:check` → exit 0 (Verify satisfied), but `git add src/core docs` then `git status --porcelain` shows **zero** modified files under `src/core/`, not the ten the step requires.

## STOP detail — Step 0

**Condition.** [Step 0](tool-roster-single-owner.plan.md#0-land-the-pre-existing-formatting-fix-as-its-own-commit)
states: "`git status` must show exactly ten modified files under `src/core/`,
plus whatever is staged under `docs/`." After running the step's own command,
`git status --porcelain` returned only the two `docs/` additions.

**Evidence.** The ten files were never unformatted in the repository. They were
CRLF in this working tree only:

| Check                                                     | Result               |
| :-------------------------------------------------------- | :------------------- |
| `git show HEAD:src/core/file-uri.ts` CRLF count           | `0` — HEAD stores LF |
| Same for `fmt.ts`, `glob.ts`                              | `0` each             |
| `cmp` HEAD blob vs worktree file after `prettier --write` | `IDENTICAL bytes`    |
| `git diff --stat -- src/core`                             | empty                |
| `git config core.autocrlf`                                | `true`               |
| `.gitattributes`                                          | does not exist       |

With `core.autocrlf=true` and no `.gitattributes`, Git materialises CRLF in the
working tree and normalises back to LF on staging. Prettier defaults to
`endOfLine: "lf"` and [`.prettierrc`](../../../.prettierrc) does not override it,
so it flagged the CRLF files. `prettier --write` converted them to LF — which is
byte-identical to what HEAD already stores, so there is nothing to commit.

**What this means for the plan.** The
[toolchain section](tool-roster-single-owner.plan.md#toolchain-state-at-606f71c--read-this-before-running-anything)
describes the red gate as pre-existing formatting debt at HEAD. It is not. It is
a local line-ending artifact of this Windows checkout. A fresh clone on CI —
LF checkout, no autocrlf — would have passed `npm run format:check` all along.

The plan-hunt report repeated the same mischaracterisation for `src/core`. Its
Finding 2 remains correct for the plan document itself, which was genuinely
unformatted markdown; the `src/core` half of that finding was wrong.

**Why this is a stop and not a deviation.** Following Step 0 literally would
produce a commit messaged `style: apply prettier import ordering to src/core`
containing no `src/core` change at all — only the two plan documents. Writing a
commit whose message contradicts its contents is not a call the executor should
make silently, and the alternatives are the user's to choose.

**Options for the user.**

| Option                                                             | Effect                                                                  |
| :----------------------------------------------------------------- | :---------------------------------------------------------------------- |
| Drop Step 0; commit the plan documents on their own honest message | Steps 1-7 proceed unchanged; gate is already green in this working tree |
| Add `.gitattributes` with `* text=auto eol=lf`                     | Fixes the artifact permanently for every Windows checkout; own change   |
| Set `endOfLine: "auto"` in `.prettierrc`                           | Stops Prettier flagging CRLF checkouts; weakens the check               |
| Leave it                                                           | Gate goes red again whenever Git re-materialises those files            |

**State left behind.** `src/core/` working-tree files are now LF — byte-identical
to HEAD, so Git reports no change. The staging area was reset; `docs/` is
untracked. No commit was made. Repository is at `606f71c`, `git status` clean
apart from untracked `docs/`.
