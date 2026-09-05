# Plan: Bound HTTP ingestion and clean up closed stdio connections

> **Executor rules**: work the steps in order. Use test-first development for
> steps 1 and 2: demonstrate each regression failing before applying its fix.
> Run every Verify command and confirm its expected result before moving on.
> On a STOP condition, report the condition, step, and evidence.
>
> **Written against** commit `70e2d8fd`, 2026-09-05.
> **Handoff**: READY FOR run-plan. The [independent review and follow-up](transport-boundaries.plan-hunt.md)
> resolved the initial fixture findings; implementation has not started.
> **Drift check (run first)**:
> `git diff --stat 70e2d8fd..HEAD -- src\transport\http.ts src\transport\stdio.ts __tests__\http-server.test.ts __tests__\stdio.test.ts __tests__\helpers.ts`
> Compare [Current state](#current-state) against live code for every flagged
> file. Also run `git status --short`: preserve pre-existing changes, and STOP
> on conflicting changes. The author's working tree was clean before this plan.

## Goal

Fix two independently refuted, confirmed Major transport defects. Unsupported
HTTP content types currently bypass the configured body limit because the
Node adapter buffers an unparsed request before rejecting it. Automatic SDK
stdio closure currently leaves application-owned watchers alive, potentially
keeping a disconnected process running indefinitely.

Requirements covered: none, this is a fix. Keep supported JSON traffic,
authentication, subscriptions, legacy roots seeding, and public exports intact.
Do not implement unrelated findings or change dependencies.

## Current state

### HTTP ingestion

[`setupExpressApp`](../../../src/transport/http.ts#L117-L138) configures
`jsonLimit` on the SDK Express factory:

```ts
const app = createMcpExpressApp({
  host: httpHost,
  jsonLimit: `${MAX_REQUEST_BODY_BYTES}b`,
```

The existing default limit is 4 MiB, read at module initialization from
`FS_MAX_REQUEST_BYTES`. The installed
[`createMcpExpressApp`](../../../node_modules/@modelcontextprotocol/express/dist/index.mjs#L134-L151)
mounts the JSON parser before its Host and Origin validators. The parser
[`skips content types it does not recognize`](../../../node_modules/body-parser/lib/read.js#L46-L65),
leaving the parsed body undefined.

[`http.ts:193-201`](../../../src/transport/http.ts#L193-L201):

```ts
app.post('/mcp', (req: Request, res: Response, next: NextFunction) => {
  void (async () => {
    const parsedBody = req.body as unknown;
    // ...
    if (!isStructurallyValidListen(parsedBody)) {
      await modernNodeHandler(req, res, parsedBody);
      return;
```

The installed
[`toNodeHandler`](../../../node_modules/@modelcontextprotocol/node/dist/index.mjs#L272-L285)
awaits request conversion before calling the SDK HTTP handler.
[`toWebRequest`](../../../node_modules/@modelcontextprotocol/node/dist/index.mjs#L349-L358)
reads an undefined parsed body without a byte bound:

```js
if (method !== "GET" && method !== "HEAD") if (parsedBody === void 0) {
  const decoder = new TextDecoder();
  let collected = "";
  for await (const chunk of req) collected += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
```

The SDK's
[`content-type rejection`](../../../node_modules/@modelcontextprotocol/server/dist/index.mjs#L1326-L1331)
is therefore too late. Its existing response is HTTP 415, JSON-RPC error
`-32000`, message `Unsupported Media Type: Content-Type must be application/json`,
and null request ID.

The exported
[`isJsonContentType`](../../../node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs#L7017-L7042)
accepts case-insensitive `application/json` with parameters. Importantly, it
also accepts some malformed parameter sections. Do not infer that such a
header bypasses the installed parser: the independent review found that
`application/json; charset=` is parsed normally. Keep a defensive undefined-body
guard so no raw-reader sentinel reaches either adapter call in the POST route.

Empty-body framing matters. The
[`JSON parser`](../../../node_modules/body-parser/lib/types/json.js#L74-L80)
returns `{}` when it parses zero bytes. With `Content-Length: 0`, the existing
SDK response is HTTP 400 InvalidRequest (`-32600`), not ParseError. A request
without either Content-Length or Transfer-Encoding instead leaves the body
undefined. Preserve the first case and explicitly reject the second with
HTTP 400 ParseError (`-32700`).

### Stdio ownership

[`startServer`](../../../src/transport/stdio.ts#L117-L150) creates one shared
registry and an asynchronous server factory:

```ts
const registry = createWatcherRegistry();
const factory: McpServerFactory = async ({ era }) => {
  await ensurePathGuard();
  const c = await createServer(options, {
    watcherRegistry: registry,
    pathGuard,
    era,
    ...(config.apiKey !== undefined ? { apiKey: config.apiKey } : {}),
  });
  activeCtx = c;
```

[`stdio.ts:295-307`](../../../src/transport/stdio.ts#L295-L307) owns cleanup only
in the wrapper explicitly returned to the caller:

```ts
    close: async () => {
      for (const id of [...listens.keys()]) releaseListen(id);
      registry.destroy();
      try {
        activeCtx?.disposeRuntimeState();
```

The remainder clears the active context and awaits SDK handle closure.

The installed
[`StdioServerTransport`](../../../node_modules/@modelcontextprotocol/server/dist/stdio.mjs#L30-L75)
closes itself on buffer overflow or an output error. It pauses stdin and calls
its own close callback; it does not end stdin. The SDK
[`wire.onclose`](../../../node_modules/@modelcontextprotocol/server/dist/stdio.mjs#L539-L548)
closes the SDK instance, not the application context.

[`FilesystemServerContext.disposeRuntimeState`](../../../src/server.ts#L62-L73)
is separately idempotent. The
[`CLI shutdown triggers`](../../../src/index.ts#L20-L32) handle stdin end/close
and signals, but not this paused-stdin transport closure.

[`prepareListenWatchers`](../../../src/transport/shared.ts#L88-L105) awaits each
acquisition. The
[`registry acquisition ladder`](../../../src/core/watcher-registry.ts#L296-L326)
checks destruction after path validation, and
[`registry destruction`](../../../src/core/watcher-registry.ts#L333-L351)
clears watchers and bookkeeping. Nevertheless, the transport must suppress
queued delivery, replies, and late context activation after teardown.

### Conventions and fixtures

- Error envelopes must use
  [`sendJsonRpcError`](../../../src/http-policy.ts#L33-L43), not another serializer.
  Follow the existing
  [`HTTP parse-error handling`](../../../src/transport/http.ts#L66-L86).
- Chain existing lifecycle callbacks, as in
  [`makeHttpModernFactory`](../../../src/transport/http.ts#L108-L113).
  Use `finally` where necessary so either callback throwing cannot skip the
  other cleanup. Do not swallow unexpected disposal errors.
- Extend the real-server cases in
  [`http-server.test.ts`](../../../__tests__/http-server.test.ts#L21-L139)
  and the real subprocess lifecycle cases in
  [`stdio.test.ts`](../../../__tests__/stdio.test.ts#L144-L177).
  Preserve their isolated roots and `finally` cleanup.
- Reuse
  [`bootHttpTest`](../../../__tests__/helpers.ts#L291-L348),
  [`createRawStdioServer`](../../../__tests__/helpers.ts#L399-L463), and their
  existing synthetic credential fixture; never paste credential values here.
  The raw harness currently has no child-process access and attaches its
  close waiter only when closing, which would hang after an already-exited child.
- [`waitFor`](../../../__tests__/helpers.ts#L59-L65) does not throw on timeout:
  callers must assert the final condition.
- Follow [`AGENTS.md`](../../../AGENTS.md): commands go through the
  [`task runner`](../../../scripts/tasks.mjs#L57-L64), which always appends the
  entire test glob. Select by test name, not a positional test filename.

## Commands

Run from the repository root in PowerShell.

| Purpose | Command | Expected on success |
| --- | --- | --- |
| Transport regression gate | [Regression command](#regression-command) | Exit 0, no failed or cancelled cases; every newly added regression appears by name. |
| Static gate | `node scripts\tasks.mjs --quick` | Exit 0: build, source/test type checking, lint, formatting, and unused-code analysis succeed. |
| Scope review | `git status --short` | Only the implementation allowlist and this effort's documentation artifacts differ from the recorded pre-execution status. |

All commands above and the drift command were run against the baseline.
The transport gate reported 53 passes, 0 failures, and 0 cancellations.
These are baseline results, not evidence that the proposed regression cases
already exist or pass.

### Regression command

```powershell
node scripts\tasks.mjs test '--test-name-pattern=Real HTTP Server integration|Stdio Transport|Stdio subscription lease lifecycle|HTTP watcher|HTTP per-connection|HTTP duplicate listen|HTTP re-listen|subscriptions/listen graceful close|Client roots seeding'
```

## Scope

**In scope** - the only implementation files to modify:

- [`src/transport/http.ts`](../../../src/transport/http.ts)
- [`src/transport/stdio.ts`](../../../src/transport/stdio.ts)
- [`__tests__/http-server.test.ts`](../../../__tests__/http-server.test.ts)
- [`__tests__/stdio.test.ts`](../../../__tests__/stdio.test.ts)
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts), only the raw stdio
  harness and directly needed types.

This [effort directory](.) may also contain planning/review/execution records.
Do not treat those records as permission to modify more application files.

**Files out of scope** - leave alone even though they look related:

- [`src/transport/shared.ts`](../../../src/transport/shared.ts): the shared
  acquisition contract is already suitable; changing it would widen both legs.
- [`src/core/watcher-registry.ts`](../../../src/core/watcher-registry.ts):
  destruction and the post-await stale guard already exist; preserve lease semantics.
- [`src/server.ts`](../../../src/server.ts): context cleanup is already
  idempotent; the missing ownership wiring belongs in the transport.
- [`src/resources.ts`](../../../src/resources.ts): preserve legacy resource
  leases and shared-registry ownership.
- [`src/index.ts`](../../../src/index.ts): do not hide the leak by forcing
  process exit or relying on CLI-only shutdown; embedders need cleanup too.
- [`src/http-policy.ts`](../../../src/http-policy.ts): reuse its response helper;
  auth, rate limits, CORS, and binding policies are not being redesigned.
- [`src/transport.ts`](../../../src/transport.ts): no public transport API changes.
- [`scripts/tasks.mjs`](../../../scripts/tasks.mjs): no runner changes.
- [`package.json`](../../../package.json): no dependency or release changes.
- [`SDK Node adapter`](../../../node_modules/@modelcontextprotocol/node/dist/index.mjs),
  [`SDK stdio implementation`](../../../node_modules/@modelcontextprotocol/server/dist/stdio.mjs),
  and other installed dependencies: fix the integration boundary, not vendored code.

## Steps

### 1. Reject unparsed HTTP requests before the adapter reads them

In [`http-server.test.ts`](../../../__tests__/http-server.test.ts), add cases
inside the existing `Real HTTP Server integration` suite so the verified
selector includes them. Work test-first.

Use Node's built-in HTTP client for an unfinished upload: flush headers, write
a small chunk, deliberately do not end the request, and wait at most 3 seconds
for the error response. Use a declared content length greater than 4 MiB without
actually allocating or transmitting a huge payload. Register error listeners
before writing, clear deadlines, and destroy the request in `finally`.
The old implementation must fail because it waits for the remainder of the
body, not because the assertion accepts any connection error.

Cover these independently:

- `text/plain` and absent Content-Type: early 415 with the exact existing SDK
  message, code `-32000`, and null ID.
- A completed valid modern request with `application/json; charset=`: preserve
  the installed parser/SDK's acceptance. Do not use this header as an early
  rejection fixture: it reaches the bounded JSON parser.
- Bodyless `application/json` with an explicit `Content-Length: 0`: preserve
  HTTP 400 InvalidRequest (`-32600`), since the parser supplies `{}`.
- Bodyless `application/json` without Content-Length or Transfer-Encoding:
  HTTP 400 ParseError (`-32700`). Use the Node HTTP client's header flush before
  ending to keep it from synthesizing zero-length framing, and explicitly set
  `useChunkedEncodingByDefault = false` before flushing. Assert the outgoing
  headers have neither framing header. This exercises the undefined-body guard;
  it must not hang or invent a success-shaped replacement body.
- Normal `application/json; charset=utf-8`: still serves a valid modern
  request. Existing valid-JSON oversize and malformed-JSON cases must retain
  413 and 400 respectively.
- An unauthenticated unsupported-type request on a protected bind still gets
  401; the new gate must not move ahead of authentication.

In [`setupExpressApp`](../../../src/transport/http.ts#L187-L201), add admission
checks at the start of the POST handler, before watcher preparation or either
adapter invocation, but after the existing auth/rate/Origin chain:

1. Reuse the SDK
   [`isJsonContentType`](../../../node_modules/@modelcontextprotocol/server/dist/src-CX2iR2pK.mjs#L7039-L7042)
   export. Reject unsupported or missing content types with the existing 415
   envelope described above via
   [`sendJsonRpcError`](../../../src/http-policy.ts#L33-L43).
   Name a local server-defined error constant rather than misusing the existing
   method-not-allowed constant merely because both codes are `-32000`.
2. If the captured parsed body is undefined, return HTTP 400 with
   `ProtocolErrorCode.ParseError`, `Invalid JSON in request body`, and null ID.
   This covers the unframed empty request and defensively closes any other
   parser-skipped raw-body path. Do not pass undefined to the adapter or
   manufacture `{}`/null as a replacement body. Do not reject an actual
   parser-produced `{}` here: let the SDK return its existing InvalidRequest.
3. Leave the configured JSON parser limit and valid-body routing untouched.
   The load-bearing invariant is that every adapter call receives the
   already-parsed body, never the raw-reader sentinel.

**Verify**:
`node scripts\tasks.mjs test '--test-name-pattern=Real HTTP Server integration|Stdio Transport|Stdio subscription lease lifecycle|HTTP watcher|HTTP per-connection|HTTP duplicate listen|HTTP re-listen|subscriptions/listen graceful close|Client roots seeding'`
-> exit 0; all new HTTP cases appear and pass alongside the existing cases.

### 2. Give stdio one connection cleanup path

First extend
[`RawStdioTestContext`](../../../__tests__/helpers.ts#L399-L404) with readonly,
properly typed access to its spawned child. In
[`createRawStdioServer`](../../../__tests__/helpers.ts#L407-L463), register a
single child-close promise immediately after spawning. Reuse it in teardown
so closing an already-exited harness cannot miss the close event. Preserve the
existing send, receive, and orderly stdin-end behavior for current callers.
Do not add production transport injection options.

Add regressions under `Stdio subscription lease lifecycle` in
[`stdio.test.ts`](../../../__tests__/stdio.test.ts#L144):

- Establish a real acknowledged file subscription, attach the child-exit
  observer, then write more than the exported SDK input-buffer limit as raw
  bytes without a newline. Keep the child's stdin open. Require natural exit
  within 5 seconds, without calling the returned harness close operation,
  ending stdin, or sending a signal before the assertion. Do not await an
  unbounded drain after the server stops reading. Drain/capture stderr and
  assert that buffer overflow, not a startup failure, caused wire closure.
- Bound failure cleanup: if the child did not exit, terminate only that
  spawned child and await the retained close promise. Make expected pipe
  closure errors explicit; do not silently accept arbitrary child errors.
- After natural exit, closing the harness twice must settle. Existing
  cancellation, shared-URI, rejected-listen, and first-request-listen cases
  remain required.
- Add deterministic lifecycle cases for closure while path preparation and
  factory initialization are suspended. Use Node's built-in per-test method
  mocks and deferred promises, not scheduling sleeps: capture the SDK wire by
  mocking its public start method, intercept sends rather than writing test
  protocol traffic to the runner's stdout, and use the real close callback.
  Defer
  [`PathGuard.recomputeAllowedDirectories`](../../../src/core/path.ts#L865)
  for initialization and
  [`PathGuard.validateExistingPath`](../../../src/core/path.ts#L329)
  for admission. Spy on
  [`FilesystemServerContext.disposeRuntimeState`](../../../src/server.ts#L62)
  without replacing its implementation. Resolve the barrier only after closure.
  Assert no late acknowledgement and that any context produced late is disposed
  before explicitly closing the host handle. Restore mocks and release barriers
  in `finally`. Keep these cases serial and entirely inside the existing suite.

Then change [`startServer`](../../../src/transport/stdio.ts#L117):

1. Introduce connection-closed state before asynchronous factory work.
   Extract idempotent connection cleanup from the returned close wrapper.
   Mark pending listen states cancelled, release tracked leases, destroy the
   shared registry, dispose the active context, and clear its reference.
   Set the closed state before callbacks or awaits can resume.
2. After the SDK installs its callback, wrap the wire's close callback and
   preserve the previous SDK callback. Run connection cleanup for automatic
   closure too. Preserve both callbacks using `finally`; do not recursively
   call the public close operation from that callback.
3. The returned close operation invokes the same cleanup and still awaits the
   SDK handle's close. Preserve graceful SDK listen-completion delivery; do
   not disable outbound sends globally merely because cleanup has begun.
4. Prevent queued admission and post-await continuations from delivering a
   listen or sending an error response after closure. In particular, check
   closure after
   [`prepareListenWatchers`](../../../src/transport/shared.ts#L88)
   and before either success delivery or failed-preparation replies.
   Expected teardown suppression is not an excuse to swallow unrelated
   exceptions: keep the existing error-reporting path for live connections.
5. A factory that resolves after connection cleanup must dispose its context
   immediately and must not assign it to the active-context reference.
   Also chain per-instance context disposal to the instance's close callback,
   following the
   [`HTTP factory pattern`](../../../src/transport/http.ts#L108-L113).
   **Do not destroy the connection registry in that per-instance hook**:
   the SDK may discard a discovery probe before choosing the legacy era.
   Only connection cleanup owns registry destruction.
6. Preserve the public signature, legacy roots hooks, stable notification sink,
   and ref-counted listen release. Remove the existing blanket disposal catch
   rather than copying it into the new lifecycle path.

**Verify**:
`node scripts\tasks.mjs test '--test-name-pattern=Real HTTP Server integration|Stdio Transport|Stdio subscription lease lifecycle|HTTP watcher|HTTP per-connection|HTTP duplicate listen|HTTP re-listen|subscriptions/listen graceful close|Client roots seeding'`
-> exit 0; natural-exit and late-continuation regressions appear and pass,
with no failed/cancelled cases or stranded child processes.

### 3. Close the handoff gates

Run the static gate and review the diff against the [Scope](#scope) allowlist.
Do not use repository-wide autofix to repair unrelated files. If formatting
needs correction, limit edits to this effort's changed files.

**Verify**: `node scripts\tasks.mjs --quick` -> exit 0.

**Verify**: `git status --short` -> no newly changed files outside the
implementation allowlist and this effort's documentation directory.

## Done

- [ ] The transport regression command in [Commands](#commands) exits 0 with
      every new regression included by name and no failures/cancellations.
- [ ] Unsupported and parser-skipped HTTP uploads receive their error before
      the upload ends; supported JSON retains existing parser limits.
- [ ] The subscribed stdio child exits naturally after SDK buffer overflow
      while its input remains open.
- [ ] Deterministic close-during-initialization/admission cases leave no late
      acknowledgement or undisposed late context.
- [ ] Repeated close settles and existing subscription/legacy behavior passes.
- [ ] `node scripts\tasks.mjs --quick` exits 0.
- [ ] `git status --short` satisfies the scope gate.

## STOP

Stop and report if:

- A live Current state excerpt differs, or another worktree change conflicts
  with an implementation file.
- A step's verification fails twice after one fix attempt.
- A fix appears to require an out-of-scope implementation file.
- The installed SDK no longer installs its wire callbacks synchronously, or
  no longer exposes the content-type predicate with the semantics cited here.
- The HTTP regression cannot distinguish an early HTTP error from a timeout,
  connection reset, or an error only after the request body ends.
- The stdio regression exits only because its test ended stdin or killed the
  process, or cannot show that a subscription was acknowledged first.
- Lifecycle wiring destroys the registry when only a discovery probe instance
  closes, suppresses graceful completion, or activates a context after closure.

## Notes

Reviewers should scrutinize empty-body framing and the undefined-body sentinel,
not just the ordinary text/plain case, and distinguish connection ownership
from instance ownership on stdio. No persistence migration, data deletion,
dependency upgrade, new public option, or forced CLI exit is part of this fix.

The [initial independent review and follow-up](transport-boundaries.plan-hunt.md) identified
two HTTP fixture assumptions. This revision preserves parser-produced empty
objects and malformed-but-accepted headers, and tests the real unframed
undefined-body path separately. The original review remains as the record;
the follow-up cleared the revised plan with no remaining findings.

Handoff route: plan-hunt completed; ready for run-plan. This has two
behavior-changing steps plus a final gate, so it received a blind review rather
than immediate execution. No implementation was performed while authoring or
reviewing the plan.
