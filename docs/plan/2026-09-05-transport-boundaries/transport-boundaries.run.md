# Run: Bound HTTP ingestion and clean up closed stdio connections

Executing [transport-boundaries.plan.md](transport-boundaries.plan.md), started
2026-09-05 at `70e2d8fd`.

- **Orientation** 2026-09-05 - drift command produced no changes. Initial status
  contained only this effort directory; no previous run log existed. Starting
  step 1.

## Seams

- HTTP POST admission through the real server: unsupported unfinished uploads,
  absent parsed bodies, authentication precedence, and accepted JSON framing.
- Stdio connection lifetime through the public host and real subprocess:
  automatic wire closure, pending filesystem preparation, and late context
  initialization. Deferred filesystem-boundary operations will run their real
  implementations after release; SDK wire mocks isolate runner stdio only.

## Steps

- **1** 2026-09-05 - done. The unfinished text/plain regression first failed on
  its 3-second response deadline, then passed with early media-type rejection.
  The unframed JSON regression first exposed the adapter's parse-error message,
  then passed with explicit undefined-body rejection. Added compatibility cases
  for missing media type, empty-body framing, charset handling, and auth order.
  The plan's exact transport regression command exited 0: 60 passed, 0 failed,
  0 cancelled. No deviations. Starting step 2.

- **2** 2026-09-05 - **STOP, incomplete**. Added readonly typed raw-child access,
  an immediately registered reusable child-close promise, and `STDIO-014`.
  The test observes the matching subscription acknowledgement, writes the SDK
  limit plus one byte without a newline, confirms the overflow diagnostic, and
  requires natural exit with stdin still open. Failure cleanup kills only its
  own child and awaits harness closure.
  - Red: `node scripts\tasks.mjs test '--test-name-pattern=STDIO-014'`
    exited 1 at the natural-exit 5000ms deadline (23 passed, 1 failed, no
    cancellations). Acknowledgement and overflow assertions had passed.
  - Applied only the first cleanup slice: shared idempotent connection cleanup
    on returned close and chained wire close, cancellation of tracked listens,
    registry destruction, and active-context disposal without the blanket
    disposal catch. The same targeted command remained red at natural exit.
  - Investigation found an additional Windows lifetime blocker: a standalone
    Node child with only a stdin data listener and end listener remains alive
    after `process.stdin.pause()`, reporting `PipeWrap`; a diagnostic variant
    with `process.stdin.unref()` exits naturally with code 0. This reproduction
    has no watchers or application code. Thus the current natural-exit test
    cannot isolate remaining watchers as its sole cause. No stdin-unref change
    was made to production or the regression to hide this new ownership issue.
  - Exact step-2 Verify command was run after that fix attempt:
    `node scripts\tasks.mjs test '--test-name-pattern=Real HTTP Server integration|Stdio Transport|Stdio subscription lease lifecycle|HTTP watcher|HTTP per-connection|HTTP duplicate listen|HTTP re-listen|subscriptions/listen graceful close|Client roots seeding'`
    exited 1: **60 passed, 1 failed, 0 cancelled**. Only `STDIO-014` failed,
    again at natural exit; existing transport cases passed.
  - STOP condition: two post-fix regression runs failed after the cleanup
    attempt. No green evidence, deterministic barrier tests, late-factory
    disposal, or post-close continuation guards are claimed. Step 2 remains
    unfinished; the new paused-stdin ownership finding needs resolution before
    continuing. HTTP files were not modified by this step.

- **3** 2026-09-05 - **STOP, not started** because step 2 did not satisfy its
  gate. Final static and reviewer handoffs have not been performed.

## Done

Incomplete. The HTTP step is implemented; stdio changes are partial and remain
in the worktree. The subscribed subprocess natural-exit requirement is blocked
by Windows stdin pipe lifetime independently of watcher cleanup. The plan must
resolve that ownership assumption before execution resumes. Only the five
implementation files allowed by the plan and this effort directory are changed.

## Review cuts applied 2026-09-05

Applied the requested ponytail cuts without resuming the blocked plan:
connection cleanup now cancels states and clears the listen map before registry
destruction; the overflow case uses `node:events.once` and the native exit tuple.
Also narrowed the optional pipe-error code before its existing membership
assertion so the touched test type-checks.

The existing stdio net (excluding the already-blocked `STDIO-014`) passed before
and after: 36 passed, 0 failed. The static gate now exits 0. The Windows stdin
lifetime blocker remains unresolved; no claim of a green overflow regression
or completed step 2 is made. Structure handoff: the two cuts reuse existing
ownership and a standard-library primitive, with no added abstraction.
