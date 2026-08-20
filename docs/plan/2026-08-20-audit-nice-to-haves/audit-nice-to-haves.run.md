# Run: Accept IPv6 loopback browser origins, and record the MCP design decisions

Executing [`audit-nice-to-haves.plan.md`](audit-nice-to-haves.plan.md), started
2026-08-20 at `18f500b` (plus the uncommitted working-tree changes the plan was
written against — drift check passed: both files modified, both anchors hit).

- **1** 2026-08-20 — done. Test added first and failed `403 !== 204` at
  [`http.test.ts:788`](../../../__tests__/http.test.ts#L788), confirming it
  observes the SDK's `originValidation` middleware and not just the local
  `OPTIONS` handler. After 1a and 1b:
  `npx tsx --test __tests__/http.test.ts` → `tests 32`, `pass 32`, `fail 0`.
- **2** 2026-08-20 — done. `docs/mcp-decisions.md` written with all 16 entries
  verbatim from the plan. `node scripts/tasks.mjs --quick` →
  `4/4 passed  (2 skipped)`.

## Done

- [x] `node scripts/tasks.mjs` exits 0 — `6/6 passed  22.5s`.
- [x] `npx tsx --test __tests__/http.test.ts` — `tests 32`, `pass 32`, `fail 0`,
      including `accepts an IPv6 loopback origin in CORS preflight`.
- [x] `git status --porcelain` lists only the plan's in-scope files beyond the
      six already modified at drift-check time: `docs/` is the sole new entry
      (holding `mcp-decisions.md` plus this effort directory).
- [~] `grep -cF '::1' src/transport.ts` returns **3**, where the checklist
  predicted `2`. Not a defect and not a STOP condition: the two code sites
  are [`transport.ts:195`](../../../src/transport.ts#L195) (new) and
  [`transport.ts:262`](../../../src/transport.ts#L262) (pre-existing); the
  third hit is prose in the comment rewritten by step 1b at
  [`transport.ts:898`](../../../src/transport.ts#L898). The plan's count was
  written before that comment existed.

## Deviations

- None affecting behavior. One Done-box count was off by one for the reason
  above; both code sites the box was written to check are present.
