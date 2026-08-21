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

**Resolution.** User chose option 1: drop Step 0, commit the plan documents on
their own message, proceed from Step 1. The `.gitattributes` fix is deferred to
its own change. Committed as `3648fd2`.

## Resumed 2026-08-21

- **0** — dropped by user decision. See STOP detail above.
- **1** — done. Added `readonly annotations: ToolAnnotations` to `DefinedTool` ([`define.ts:102-109`](../../../src/tools/define.ts#L102-L109)) and populated it at [`define.ts:415`](../../../src/tools/define.ts#L415). `npm run type-check` → exit 0.
- **2** — done. `MUTATING_TOOL_NAMES` now derives via `ALL_TOOLS.filter((t) => t.annotations.readOnlyHint !== true)`. Derived set printed as `create, delete, edit, move, replace_text`, size 5 — matches the STOP condition's required set exactly. `npm test` → `pass 801`, `fail 0`.
- **3** — done. Added the three `ORACLE_*` literals to [`helpers.ts`](../../../__tests__/helpers.ts) and created [`tool-roster.test.ts`](../../../__tests__/unit/tool-roster.test.ts) pinning the derived set against them. `npm test` → `pass 803`, `fail 0`.
- **4** — done. [`contract.test.ts`](../../../__tests__/contract.test.ts) and [`cli-read-only.test.ts`](../../../__tests__/unit/cli-read-only.test.ts) now build their sets from the oracle. `READ_TOOLS` widened from six names to the seven-name oracle (adding `list_roots`) — it passed, so the plan's STOP about `list_roots` being dropped under `--read-only` did not fire. `npm test` → `pass 803`, `fail 0`.
- **5** — done. Exported `ALL_TOOLS` from [`tools/index.ts`](../../../src/tools/index.ts); `helpers.ts` dropped twelve direct tool imports and the copied array for one import. `npm run knip` → exit 0 (confirms the new export is consumed), `npm test` → `pass 803`.
- **6** — done. `'Write'` row in [`resources.ts`](../../../src/resources.ts) derives from `MUTATING_TOOL_NAMES`; `--read-only` help row in [`cli.ts`](../../../src/cli.ts) derives too. `npm test` → `pass 803`. `node dist/index.js --help` → `Disable write tools: create, delete, edit, move, replace_text` — the pre-existing `replace` → `replace_text` prose drift is fixed.
- **7** — done, after one fix. Regression test confirmed red first (`buildServerInstructions is not a function` — the function did not exist, so the readOnly-filtered path was unreachable; no STOP). Added `buildServerInstructions(readOnly)`, threaded `readOnly` through `ResourceRegistrationOptions` and both registrars, deleted the `serverInstructionsContent` alias, swapped the `prompts.ts:28` specifier. **Deviation below.** Final: `npm run type-check` → exit 0, `npm run knip` → exit 0, `npm test` → `pass 805`, `fail 0`.

### Deviation at Step 7 — five re-exports orphaned

Not anticipated by the plan or by either plan-hunt refuter. After Step 5 removed
`helpers.ts`'s direct tool imports and Step 6 removed `resources.ts`'s five
mutating-tool imports, nothing consumed the `CREATE`, `DELETE_FILE`, `EDIT`,
`MOVE`, `SEARCH_AND_REPLACE` re-exports in
[`tools/index.ts`](../../../src/tools/index.ts). `npm run knip` failed:

```
Unused exports (5)
CREATE              src/tools/index.ts:42:3
DELETE_FILE         src/tools/index.ts:43:3
EDIT                src/tools/index.ts:44:3
MOVE                src/tools/index.ts:47:3
SEARCH_AND_REPLACE  src/tools/index.ts:49:3
```

First failure, so one fix attempt was taken per the Executor rules: the five
names were dropped from the re-export block, leaving the seven read-only tools
that `resources.ts` still names individually. Their names now reach callers
through `MUTATING_TOOL_NAMES` and `ALL_TOOLS`. This is more deletion in the
direction the plan intended, not a workaround. `tools/index.ts` is in the plan's
Scope, so no out-of-scope STOP.

## Done

| Check                             | Result                                            |
| :-------------------------------- | :------------------------------------------------ |
| `npm run format:check`            | exit 0                                            |
| `npm run type-check`              | exit 0                                            |
| `npm run lint`                    | exit 0 (via `tasks --quick`)                      |
| `npm run knip`                    | exit 0                                            |
| `npm test`                        | exit 0, `pass 805`, `fail 0`, 4 new tests         |
| `node scripts/tasks.mjs --quick`  | exit 0 — format, knip, type-check, lint all green |
| `git status` inside Scope         | 8 modified + 1 new, all in the Scope list         |
| `tool-schemas.json` unchanged     | `git diff --stat` → 0 lines                       |
| Tool names literal once in `src/` | each at its own `defineTool` call, nowhere else   |
| Step 0 a separate commit          | n/a — dropped by user decision                    |

Diff: 8 files, +102 / −87, plus a 45-line test file.
