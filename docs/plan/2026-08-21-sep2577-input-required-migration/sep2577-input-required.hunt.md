# Bug Hunt: SEP-2577 input_required migration

Hunted the SEP-2577 `input_required` migration landed on branch `sep2577-input-required`
against commit `cf4f255`. Scope: changed code plus blast radius, per the brief — 29 files,
~11415 lines, one pass, highest-risk subset first.

> **Verdict — one Minor, Confirmed.** `applyGrant`→`setRoots` is an unsynchronized
> read-`await`-write on the session's shared `PathGuard`; concurrent `tools/call` on one
> HTTP session can interleave, losing a user-accepted grant and surfacing a legitimate
> retry as a raw JSON-RPC error. Fail-closed, no privilege gain.

## Confirmed

### GRANT-1 — Unsynchronized grant application races on a shared `PathGuard` (Minor)

[`path.ts:618`](../../../src/core/path.ts#L618) — in `applyGrant`, at the line:

```ts
await this.setRoots([...this.getAllowedDirectories(), targetDir]);
```

**What.** `applyGrant` reads the current allowed dirs (`getAllowedDirectories()`,
[path.ts:487](../../../src/core/path.ts#L487)), appends `targetDir`, and writes the whole
set back through `setRoots` ([path.ts:473](../../../src/core/path.ts#L473)). `setRoots`
synchronously sets `this.rootDirectories = next`, then `await`s
`recomputeAllowedDirectories()` — which itself `await`s
(`resolveConfiguredDirs`, [path.ts:986-989](../../../src/core/path.ts#L986-L989)) **before**
reading `this.rootDirectories` at [path.ts:1014](../../../src/core/path.ts#L1014). There is
no compare-and-swap: the recompute commits whatever `rootDirectories` holds at read time,
not the value the caller passed. Two grants in flight on one `PathGuard` interleave across
the `await`, and the second `setRoots`'s write can land before the first's recompute reads —
the first grant is lost (last write wins), or both recomputes converge on one set.

**Trigger.** A single HTTP session issues two `tools/call` concurrently, both retried with
accepted grant confirmations for distinct out-of-root dirs, both reaching `applyGrant`
near-simultaneously. The SDK does **not** serialize per session:
`Protocol._onrequest` fires each inbound handler without awaiting the previous one
(`Promise.resolve().then(() => handler(request, ctx))` —
`node_modules/@modelcontextprotocol/server/dist/src-STyD_Vvf.cjs:6447`). Per-session
`PathGuard` is shared (`createHttpSession` → `createServer` builds one context per session,
[transport.ts:400](../../../src/transport.ts#L400); one `pathGuard` per
[`FilesystemServerContext`](../../../src/server.ts#L133)), so the two calls share it.

**Impact.**

1. A user-accepted grant is silently dropped — the next access to that dir fails
   `ACCESS_DENIED` until the client re-grants. Fail-closed, self-healing on the next
   `setRoots`. No privilege escalation: an interleaving can never produce an allowed set
   larger than the union the user accepted, because each write is itself a superset of the
   prior set plus one accepted dir.
2. A legitimate retry can hit the R9 state-binding check at
   [`define.ts:311`](../../../src/tools/define.ts#L311) with a recomputed `grantDirs` that no
   longer matches the sealed `state.paths` (the other call's grant shifted the allowed set
   mid-round). `precheckGrant` runs **outside** `runTool`'s try/catch
   ([`define.ts:357`](../../../src/tools/define.ts#L357)), so the `FsError(INVALID_INPUT)`
   propagates to the SDK's `_onrequest` rejection handler and surfaces as a raw JSON-RPC
   `-32602` error, not an `isError` tool result — a broken contract a client must special-case.

**Ruled out.** Grep for `mutex|lock|queue|serialize|runExclusive|Mutex|Semaphore|acquire|release`
across `src/` returns zero hits in `path.ts` or any caller of `setRoots`/`applyGrant`/
`recomputeAllowedDirectories`. `withSession`
([observability.ts:12](../../../src/core/observability.ts#L12)) is `AsyncLocalStorage` for
logging; `activeRequests` ([transport.ts:484](../../../src/transport.ts#L484)) is an idle
counter — neither is a queue. Cross-session races do not occur: each HTTP session owns its
own `PathGuard`. The race is intra-session only, gated by the SDK firing concurrent handlers
on one session. Refuter-confirmed (blind): all three settling checks came back empty.

**Severity: Minor (torn — took the lower).** A race is Major-bait, but both outcomes are
fail-closed, self-healing, and the trigger (two concurrent grant round-trips on one session)
is uncommon. The raw-JSON-RPC-error contract break is the part a reader could re-rank Major.

**Fix (suggestion, not applied).**

- Primary: guard `applyGrant`'s read-compute-write with a per-`PathGuard` async mutex so
  `getAllowedDirectories() → setRoots → recomputeAllowedDirectories` is atomic. A one-slot
  `AsyncMutex` (`p-limit` or a ~10-line `runExclusive`) around `setRoots` closes both
  outcomes.
- Secondary: move the R9 check inside `runTool`'s try/catch (or catch at the
  `execute`/`precheckGrant` boundary, [`define.ts:357`](../../../src/tools/define.ts#L357))
  so a state mismatch surfaces as an `isError` tool result, not a JSON-RPC error.

## Suspected

None. The one candidate resolved to Confirmed under refutation.

## Coverage

**Read in full** (changed files, end to end):

- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts) — two-phase plan/finalize,
  TOCTOU re-stat + dev/ino/birthtimeMs identity, R9 re-plan + state check. Sound.
- [`src/tools/move.ts`](../../../src/tools/move.ts) — plan/execute, TOCTOU, EXDEV
  cp+rm fallback, R9. Sound.
- [`src/tools/input-required.ts`](../../../src/tools/input-required.ts) — requestState codec
  (HMAC mint/verify), `buildInputRequired`, `readAcceptedConfirm`, `confirmInput`. Sound.
- [`src/server.ts`](../../../src/server.ts) — one `PathGuard` per context; `requestState.verify`
  wired to the codec. Sound.

**Read in part** (blast radius, judged the changed contract only):

- [`src/tools/define.ts`](../../../src/tools/define.ts#L280-L378) — `precheckGrant`, `execute`
  (grant gate before `runTool`, R9 throw outside try/catch). Source of impact #2 above.
- [`src/core/path.ts`](../../../src/core/path.ts) — `setRoots`, `precheckAccess`,
  `applyGrant`, `validateAccess`, `recomputeAllowedDirectories`. Source of GRANT-1.
- [`src/transport.ts`](../../../src/transport.ts#L398-L457) — `createHttpSession` builds one
  context (one `PathGuard`) per session. Settled the cross-session race.

**Confirmed mechanically, not deep-read:**

- The 11 `accessPaths` wirings
  ([`delete-file.ts:383`](../../../src/tools/delete-file.ts#L383),
  [`edit.ts:529`](../../../src/tools/edit.ts#L529),
  [`list.ts:320`](../../../src/tools/list.ts#L320),
  [`create.ts:101`](../../../src/tools/create.ts#L101),
  [`calculate-hash.ts:329`](../../../src/tools/calculate-hash.ts#L329),
  [`move.ts:422`](../../../src/tools/move.ts#L422),
  [`read.ts:405`](../../../src/tools/read.ts#L405),
  [`replace-in-files.ts:644`](../../../src/tools/replace-in-files.ts#L644),
  [`search-content.ts:417`](../../../src/tools/search-content.ts#L417),
  [`search-files.ts:207`](../../../src/tools/search-files.ts#L207),
  [`stat.ts:203`](../../../src/tools/stat.ts#L203)).
  Each returns the paths its tool operates on; `validateAccess` is the hard gate inside every
  op, so a mis-wired `accessPaths` fails closed (under-reporting → `ACCESS_DENIED`,
  over-reporting → a spurious prompt). Verified all 11 via one grep; no per-file deep read
  because the contract is a one-liner and the security gate is independent of it.

**Tells dispositioned (not findings):**

- SECRET tag at [`directory.test.ts:260`](../../../__tests__/tools/directory.test.ts#L260) —
  `progressToken: 'list-progress-token'`, a test-fixture string, not a credential.
- MARKER tags — `example.com`/`mcp.example.com` (HTTP test host fixtures),
  `FILESYSTEM_MCP_PUBLIC_URL` (test env fixture), `TODO` (search-pattern test input +
  `replace-in-files` regex schema examples in
  [`tool-schemas.json`](../../../__tests__/schemas/__snapshots__/tool-schemas.json#L1356)).
  All fixtures.
- "Tests assert the bug" tell on the rewritten wire tests — they assert legacy-era fail-close
  (`isError` + "did not declare the required capability"). Correct era-constrained behavior:
  the `InMemoryTransport` test harness negotiates `2025-11-25`, so raw `input_required` is
  unobservable over the wire and fail-close is the right observable. Not a bug encoded as
  expected.

**Not audited, named here:**

- The four rewritten wire-test files
  ([`security.test.ts`](../../../__tests__/security.test.ts),
  [`directory.test.ts`](../../../__tests__/tools/directory.test.ts),
  [`read-write.test.ts`](../../../__tests__/tools/read-write.test.ts),
  [`stat.test.ts`](../../../__tests__/tools/stat.test.ts)) beyond the out-of-root assertions
  already inspected for the "tests assert the bug" tell. The round-trip-accept path (modern
  era, accept → mutate) is exercised by [`access-grant.test`](../../../__tests__) and the
  R14 atomic-batch tests in delete/move, not re-traced here.
- `recomputeAllowedDirectories`'s full body
  ([path.ts:981-1024](../../../src/core/path.ts#L981-L1024)) beyond the post-await read at
  line 1014 that settles GRANT-1.

**Taken on trust (third-party, read by the refuter):** the SDK does not serialize per-session
`tools/call` — `Protocol._onrequest` fires handlers without awaiting the prior one
(`@modelcontextprotocol/server`, `dist/src-STyD_Vvf.cjs:6447`). This is the reachability
hinge for GRANT-1; if a future SDK release adds per-session serialization, the race becomes
unreachable and the finding drops to Killed.

---

# Re-hunt 2026-08-21: sep2577-input-required-followup

Hunted the followup plan's changes (GRANT-1 fix + refactor + tests, run log
[`sep2577-input-required-followup.run.md`](sep2577-input-required-followup.run.md)),
against this report's GRANT-1 finding. Scope: the delta since the report above —
`src/core/path.ts` (mutex, `isWithinBoundary`), `src/tools/define.ts`
(`precheckGrant` relocation), `src/tools/input-required.ts` (`pendingRoundTrip`
extraction), `src/tools/delete-file.ts`/`src/tools/move.ts` (call sites),
`__tests__/helpers.ts` (extracted stub harness), and the two new R2/R12 tests
in `delete-file.test.ts`/`move.test.ts`. The remaining 12 files git reports
modified (`cli.ts`, `schema.ts`, `server.ts`, `calculate-hash.ts`, `create.ts`,
`edit.ts`, `list.ts`, `read.ts`, `replace-in-files.ts`, `search-content.ts`,
`search-files.ts`, `stat.ts`) were not touched by the followup plan — the
report above already covers them (Sound / mechanically confirmed).

> **Verdict — no findings.** GRANT-1 is closed: the mutex serializes every
> `rootDirectories` write, `precheckGrant` now routes through `runTool`'s
> catch, and no behavior changed under refactor.

## Confirmed

None.

## Suspected

None.

## Coverage

**Read in full:**

- [`src/core/path.ts:442-644`](../../../src/core/path.ts#L442-L644) —
  `#mutex`/`runExclusive`, `#setRootsLocked`/`setRoots`, `precheckAccess`,
  `applyGrant`, `isWithinBoundary`. `runExclusive` chains `fn` onto the tail
  via `.then(fn, fn)` (the tail never rejects — its own settlement branch
  swallows both outcomes — so the second `fn` arg is dead but harmless) and
  resets the tail to a rejection-swallowing continuation of the _result_
  before returning the _unswallowed_ result to the caller — a standard
  one-slot mutex; verified no code path writes `rootDirectories` outside
  `#setRootsLocked` (`grep 'rootDirectories\s*='` → two hits, both inside it).
  `applyGrant` calls the unlocked `#setRootsLocked` (not public `setRoots`)
  inside its own `runExclusive`, avoiding the self-deadlock the code comment
  claims.
- [`src/tools/define.ts:277-349`](../../../src/tools/define.ts#L277-L349) —
  `precheckGrant` now called inside `runTool`'s `try`; `#flushProgress`
  ([define.ts:251](../../../src/tools/define.ts#L251)) only flushes the MCP
  notification sink and never sets `#progressClosed`, confirming the grant
  `input_required` early-return leaves the progress session paused (not
  finished), same as the pre-existing delete/move round-1 path through the
  same `if (isInputRequiredResult(result)) return result` branch.
- [`src/tools/input-required.ts`](../../../src/tools/input-required.ts) —
  `pendingRoundTrip` reproduces the prior triplicated read-state →
  `buildInputRequired` → mismatch-throw flow with no logic change.
- [`__tests__/helpers.ts:313-395`](../../../__tests__/helpers.ts#L313-L395) —
  `registerAgainstStub`'s `init` parameter defaults to `initialize` (no
  ROOT_BOUNDARY resolution), matching every original call site except
  `elicitation.test.ts`, which now passes an explicit
  `(pg, r) => pg.setRoots([r])` override at both its call sites (verified —
  the file's declined-grant test and its ROOT_BOUNDARY test both carry it).
- [`__tests__/tools/delete-file.test.ts`](../../../__tests__/tools/delete-file.test.ts),
  [`__tests__/tools/move.test.ts`](../../../__tests__/tools/move.test.ts) — the
  two new R2 tests (two pending items, one `input_required`) and the one new
  R12 test (malformed accept-with-no-`confirm` does not delete). Confirmed the
  dir/dest naming sorts as each test assumes (`dir-a`/`dir-b`,
  `existing-a.txt`/`existing-b.txt`), so `confirm_0`/`confirm_1` map to the
  intended item regardless — both are accepted, so the mapping direction
  would not have caught a swap either way; not a gap, since R9's mismatch
  path is what tests the mapping's binding, and it already runs.

**Read in part (blast radius, judged the changed contract only):**

- [`src/tools/delete-file.ts:288-312`](../../../src/tools/delete-file.ts#L288-L312),
  [`src/tools/move.ts:244-257`](../../../src/tools/move.ts#L244-L257) — the
  `pendingRoundTrip` call sites; unchanged surrounding phase-2 mutation logic
  not re-read (covered Sound by the report above).
- `src/cli.ts:451`, `src/server.ts:134`, `src/transport.ts:175` — the three
  remaining unlocked `recomputeAllowedDirectories()` callers. All three run on
  a freshly constructed `PathGuard` before the server starts serving
  (`runPrintConfig` one-shot CLI, `buildServerContext` pre-registration,
  `startServer` before `server.connect(transport)`) — confirmed none is on a
  live per-request or per-session path, so the mutex's uncovered surface is
  unreachable while a session is live. `createHttpSession`
  ([transport.ts:396](../../../src/transport.ts#L396)) does not call
  `recomputeAllowedDirectories` at all.

**Not re-audited, named here:** the 12 files listed above that the followup
plan did not touch, and the four rewritten wire-test files
(`security.test.ts`, `directory.test.ts`, `read-write.test.ts`,
`stat.test.ts`) — both already dispositioned Sound / not-a-bug by the report
above and untouched since.

**Tells:** the two UNAWAITED tags at
[`path.ts:484-485`](../../../src/core/path.ts#L484-L485) are `runExclusive`'s
own tail-chaining lines, read above — not unawaited, stored on `this.#mutex`
and returned via `result`. The SECRET and MARKER tags repeat lines the report
above already dispositioned as test fixtures; not re-listed.
