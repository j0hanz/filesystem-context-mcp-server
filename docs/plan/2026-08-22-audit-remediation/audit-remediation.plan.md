# Plan: Close the seven MCP SDK v2 audit findings

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `dbfb707`, 2026-08-22.
> **Drift check (run first)**: `git diff --stat dbfb707..HEAD -- src/core/registrar.ts src/tools/input-required.ts src/tools/define.ts src/tools/move.ts src/tools/delete-file.ts src/transport.ts src/http-policy.ts src/resources.ts __tests__/resources.test.ts __tests__/helpers.ts`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

The SDK v2 audit (`/mcp audit`) returned **no Blockers** but seven
Should-Fix / Nice-to-Have findings: the `input_required` data-loss guard and the
real HTTP server have no test coverage; two test sites use fragile `instanceof`
protocol-error checks; the deprecated `listRoots`/`getClientCapabilities` and the
hand-rolled bearer auth are deliberate but undocumented; and no decision record
exists. This plan records the deliberate decisions, fixes the two `instanceof`
sites, and adds the three missing test surfaces — so the destructive-action
guard, the full Express middleware chain, and the resource-subscription
round-trip are verified rather than inferred.

Requirements: none — this is a fix bundle, not a spec.

## Current state

The facts, inlined — every excerpt readable without opening another document.

### Finding 1 — deprecated `listRoots` / `getClientCapabilities` (deliberate, gated)

[`src/core/registrar.ts:204-235`](../../../src/core/registrar.ts#L204-L235) —
`updateRootsFromClient` calls `server.server.getClientCapabilities()` and
`server.server.listRoots()`. Both are `@deprecated` (SEP-2577). The file
disables the lint rule with a rationale comment and gates the whole
synchronizer to the legacy era:

```ts
// getClientCapabilities()/listRoots(): deprecated (SEP-2577, 2026-07-28 era);
// listRoots() throws on that era … This method is only reached on legacy-era
// connections — the serving factories gate `registerHandlers` to
// `ctx.era === 'legacy'` (stdio) or the legacy sessionful HTTP stack
/* eslint-disable @typescript-eslint/no-deprecated -- see comment above */
…
const clientCapabilities = server.server.getClientCapabilities();
…
const rootsResult = await server.server.listRoots(undefined, { timeout: ROOTS_TIMEOUT_MS });
```

There is **no forward API** to migrate to: the fetched SDK v2 docs mark Roots
"(sunset)"; the 2026-07-28 era takes allowed directories from configuration, which
`createServer` already does. So the remediation is **record + track**, not a
code change. The calls are correct on the 2025-11-25 era they serve and break
only when legacy-era support is dropped — at which point
`McpRootsSynchronizer` is deleted wholesale.

### Finding 2 — `input_required` round-trip has zero test coverage

The data-loss-prevention surface for delete / move / out-of-root grant. All
untested:

- [`src/tools/input-required.ts`](../../../src/tools/input-required.ts) —
  `requestStateCodec` (HMAC mint/verify), `buildInputRequired`,
  `pendingRoundTrip` (the one home for the R9 path-binding check),
  `readAcceptedConfirm`. Whole file, no test references
  (`grep inputRequired|pendingRoundTrip|buildInputRequired|readAcceptedConfirm|requestStateCodec __tests__/`
  → only `__tests__/helpers.ts`, an unrelated re-export).
- [`src/tools/define.ts:280-305`](../../../src/tools/define.ts#L280-L305) —
  `precheckGrant`, the out-of-root access-grant round-trip.
- [`src/tools/move.ts:278-291`](../../../src/tools/move.ts#L278-L291) and
  [`src/tools/delete-file.ts:300-317`](../../../src/tools/delete-file.ts#L300-L317)
  — the move/delete overwrite confirmations.

`pendingRoundTrip` contract (from
[`src/tools/input-required.ts:137-159`](../../../src/tools/input-required.ts#L137-L159)):

```ts
export async function pendingRoundTrip(
  opts: PendingRoundTripOpts,
): Promise<InputRequiredResult | undefined> {
  const state = opts.requestState?.();
  if (state?.op !== opts.op) {
    return buildInputRequired({ op: opts.op, paths: opts.pending }, opts.buildInputs(opts.pending));
  }
  if (!pathsEqual(state.paths, opts.pending)) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `${opts.op}: confirmation does not match the requested paths`,
    );
  }
  return undefined;
}
```

`readAcceptedConfirm` (from
[`src/tools/input-required.ts:168-176`](../../../src/tools/input-required.ts#L168-L176))
reads the retried `inputResponses` through the SDK's `inputResponse` /
`acceptedContent`. The wire shape of one accepted elicit confirmation is the
SDK's `ElicitResult`, confirmed in
`node_modules/@modelcontextprotocol/core/dist/auth-CUe6YdwF.mjs:1201`:

```ts
const ElicitResultSchema = ResultSchema.extend({
  action: z.enum(["accept", "decline", "cancel"]),
  content: z.preprocess((val) => val === null ? void 0 : val, z.record(…).optional()),
});
```

So a valid accepted-with-`confirm:true` fixture is
`{ confirm_0: { action: 'accept', content: { confirm: true } } }`; a decline is
`{ confirm_0: { action: 'decline' } }`. The `requestState` string
`buildInputRequired` returns is the opaque HMAC token the client echoes; the
test reads it off the result and round-trips it through
`requestStateCodec.verify`.

`requestStateCodec` is constructed at module scope
([`src/tools/input-required.ts:76-78`](../../../src/tools/input-required.ts#L76-L78))
from `resolveRequestStateKey()` (env `FILESYSTEM_MCP_REQUEST_STATE_KEY` or a
random 32-byte per-boot key). Tests do not need to set the env var — the random
key is fine for a single-process round-trip.

### Finding 3 — real HTTP server (`startHttpServer` / Express / era-branch) untested

[`src/transport.ts:945`](../../../src/transport.ts#L945) `startHttpServer`,
[`src/transport.ts:699`](../../../src/transport.ts#L699) `setupExpressApp`,
[`src/transport.ts:440`](../../../src/transport.ts#L440) `createHttpSession`,
[`src/transport.ts:309`](../../../src/transport.ts#L309) `HttpSessionRegistry`.
The era-branch POST router at
[`src/transport.ts:814-842`](../../../src/transport.ts#L814-L842):

```ts
app.post('/mcp', (req, res, next) => {
  const parsedBody = req.body as unknown;
  toWebRequest(req, parsedBody)
    .then((probe) => isLegacyRequest(probe, parsedBody))
    .then((legacy) => {
      if (legacy) { handlePostMcp(req, res, options, registry).catch(next); return; }
      attachListenWatchers(parsedBody, watcherPathGuard, sharedRegistry, bus)
        .catch((err) => { Logger.warn(…); })
        .then(() => modernNodeHandler(req, res, parsedBody))
        .catch(next);
    })
    .catch(next);
});
```

Bearer middleware is mounted before the route at
[`src/transport.ts:812`](../../../src/transport.ts#L812):
`app.use('/mcp', bearerAuthMiddleware(apiKey, allowedHosts.length > 0))`.
`/healthz` is registered **before** the bearer middleware
([`src/transport.ts:796`](../../../src/transport.ts#L796)) so it is open. The
modern leg is built with `legacy: 'reject'`
([`src/transport.ts:980-986`](../../../src/transport.ts#L980-L986)), so a legacy
POST that mis-routes to the modern leg returns `415`.

`startHttpServer` signature and port recovery
([`src/transport.ts:945`](../../../src/transport.ts#L945)):

```ts
export async function startHttpServer(port: number, options: ServerOptions): Promise<Server>;
```

`API_KEY` and `HTTP_HOST` are read from env inside the call
([`src/transport.ts:946-947`](../../../src/transport.ts#L947)); `port: 0` binds a
random port, recovered via `(httpServer.address() as AddressInfo).port`. The
existing in-process harness
[`__tests__/helpers.ts:82-128`](../../../__tests__/helpers.ts#L82-L128)
`createTestHttpHarness` tests the modern leg through `handler.fetch` only — it
never spawns the real Express server, so the middleware chain and era-branch are
uncovered. `StreamableHTTPClientTransport` accepts a custom `fetch`
([`__tests__/helpers.ts:108-110`](../../../__tests__/helpers.ts#L108-L110)), so
a real-HTTP client is built by pointing that `fetch` at the live URL with an
`Authorization` header added.

### Finding 4 — two `instanceof` protocol-error assertions

[`__tests__/resources.test.ts:225-240`](../../../__tests__/resources.test.ts#L225-L240):

```ts
(err: unknown) => {
  assert(err instanceof ResourceNotFoundError);   // line 226
  return true;
},
…
(err: unknown) => {
  assert(err instanceof ProtocolError);           // line 237
  return true;
},
```

`ResourceNotFoundError` and the empty-id `ProtocolError` are both thrown as
`ProtocolErrorCode.InvalidParams` (`-32602`); `ResourceNotFoundError`
additionally carries `data: { uri }`. Source confirmed:
[`src/resources.ts:423-425`](../../../src/resources.ts#L423-L425) (empty id →
`ProtocolError(ProtocolErrorCode.InvalidParams, …)`) and
[`src/resources.ts:434-435`](../../../src/resources.ts#L434-L435) (missing →
`ResourceNotFoundError`). The codebase's own convention is the `.code` check at
[`__tests__/tools.test.ts:100-106`](../../../__tests__/tools.test.ts#L100-L106):

```ts
typeof err === 'object' &&
  err !== null &&
  'code' in err &&
  (err as { code: ProtocolErrorCode }).code === ProtocolErrorCode.InvalidParams;
```

After this fix `ProtocolError` and `ResourceNotFoundError` are no longer
referenced in the file (the only other mentions are comments at lines 189, 212,
231), so the import on
[`__tests__/resources.test.ts:1`](../../../__tests__/resources.test.ts#L1)
becomes `import { ProtocolErrorCode } from '@modelcontextprotocol/server';` —
leaving the old names imported would trip lint's `max-warnings=0`.

### Finding 6 — hand-rolled bearer middleware (deliberate)

[`src/http-policy.ts:228-262`](../../../src/http-policy.ts#L228-L262)
`bearerAuthMiddleware` uses `timingSafeEqual` over SHA-256 hashes. The file
documents at
[`src/http-policy.ts:170-186`](../../../src/http-policy.ts#L170-L186) that this
is a static-secret resource server (no IdP), so `requireBearerAuth` from
`@modelcontextprotocol/express` (which expects RFC 8414 authorization-server
metadata) does not fit. Consequence: `req.auth` / `ctx.http?.authInfo` is never
populated, so per-user authorization is impossible — `PathGuard` is the sole
authorization mechanism. Deliberate and correct for the shared-secret model;
adopt `requireBearerAuth` only if the server moves to a real IdP. Remediation is
**record**, not a code change.

### Finding 5 / 7 — no decision record; subscription round-trip untested

No `docs/` directory exists (`ls docs/` → not found). Decisions live only as
inline comments. The resource-subscription protocol flow is uncovered: only the
`WatcherRegistry` unit is tested at
[`__tests__/resources.test.ts:309-366`](../../../__tests__/resources.test.ts#L309-L366).
The `resources/subscribe` + `resources/unsubscribe` handlers at
[`src/resources.ts:530-592`](../../../src/resources.ts#L530-L592) register a
watcher and publish `resource_updated`; no test drives a client `subscribe` →
file change → notification round-trip. The in-memory pair harness
`createTestClientPair` ([`__tests__/helpers.ts:49-73`](../../../__tests__/helpers.ts#L49-L73))
connects a real `Client` (with `capabilities: { roots: { listChanged: true } }`)
to the server over `InMemoryTransport` and leaves
`notifyResourceUpdated` unset, so the legacy handler takes the
`server.server.sendResourceUpdated` branch
([`src/resources.ts:553-559`](../../../src/resources.ts#L553-L559)) — exactly
the path to exercise.

## Commands

| Purpose     | Command                          | Expected on success   |
| ----------- | -------------------------------- | --------------------- |
| Static only | `node scripts/tasks.mjs --quick` | 4/4 passed, 2 skipped |
| Tests only  | `npm run test`                   | all pass, exit 0      |
| Full check  | `node scripts/tasks.mjs`         | 6/6 passed            |

`npm run test` is `node --test --import tsx "__tests__/**/*.test.ts"` — new
`__tests__/*.test.ts` files are picked up automatically.

## Scope

**In scope** — the only files to create or modify:

- `docs/mcp-decisions.md` (new)
- `__tests__/resources.test.ts` (edit two assertions + import)
- `__tests__/input-required.test.ts` (new)
- `__tests__/http-server.test.ts` (new)
- `__tests__/resources-subscribe.test.ts` (new)

**Files out of scope** — leave alone even though they look related:

- `src/core/registrar.ts` — deprecated calls are gated to legacy and correct;
  no forward API exists. Recording the decision is the fix, not editing source.
- `src/http-policy.ts` — hand-rolled bearer is deliberate for the
  shared-secret model; recording the decision is the fix.
- `src/tools/input-required.ts`, `src/tools/define.ts`, `src/tools/move.ts`,
  `src/tools/delete-file.ts` — the guard logic is the thing being _tested_,
  not changed.
- `src/transport.ts`, `src/server.ts`, `src/resources.ts` — production code
  under test; not edited.
- `__tests__/helpers.ts` — existing harnesses are reused as-is.
- `__tests__/http-transport.test.ts` — covers the in-process modern leg; the
  new `http-server.test.ts` covers the real-server gap alongside it.

## Steps

### 1. Create `docs/mcp-decisions.md` — record the deliberate decisions

Create `docs/mcp-decisions.md`. One section per decision, each: **Decision**,
**Context** (why), **Consequence** (what it costs / when to revisit). Include
at least these entries, drawing the **Context** verbatim from the linked source
comments so the record is self-contained:

- **DR-01 Both-era serving posture.** Modern 2026-07-28 leg
  (`createMcpHandler(..., { legacy: 'reject' })`,
  [`src/transport.ts:980`](../../../src/transport.ts#L980)) plus legacy 2025
  sessionful stack (`NodeStreamableHTTPServerTransport`,
  [`src/transport.ts:475`](../../../src/transport.ts#L475)); stdio serves legacy
  (`serveStdio(factory, { legacy: 'serve' })`,
  [`src/transport.ts:210`](../../../src/transport.ts#L210)). Revisit when 2025
  clients are no longer supported — then delete the sessionful stack and the era
  branch.
- **DR-02 Static API-key resource server (no IdP).** Hand-rolled
  `bearerAuthMiddleware` over `requireBearerAuth`; `ctx.http?.authInfo` is never
  populated, so `PathGuard` is the sole authorization. Context from
  [`src/http-policy.ts:170-186`](../../../src/http-policy.ts#L170-L186). Adopt
  `requireBearerAuth` + `mcpAuthMetadataRouter` only if the server moves to a
  real IdP.
- **DR-03 Per-process `requestState` key.**
  `FILESYSTEM_MCP_REQUEST_STATE_KEY` or a random 32-byte per-boot key; a restart
  invalidates in-flight `input_required` tokens, the client re-requests
  (fail-closed). Context from
  [`src/tools/input-required.ts:49-57`](../../../src/tools/input-required.ts#L49-L57).
  Revisit if HTTP scales to multi-node (then share the key across nodes).
- **DR-04 `InMemoryEventStore` resumability is per-session and lost on restart.**
  Context from
  [`src/transport.ts:447-449`](../../../src/transport.ts#L447-L449). Revisit if
  `Last-Event-ID` reconnects must survive a restart (then back the store with
  durable storage).
- **DR-05 Deprecated `listRoots` / `getClientCapabilities` (SEP-2577) — deferred
  removal.** Gated to the legacy era; no forward API exists (Roots is sunset;
  2026 era uses config, already implemented). Remove
  `McpRootsSynchronizer` wholesale when legacy-era support is dropped. Context
  from [`src/core/registrar.ts:40-45, 212-219`](../../../src/core/registrar.ts#L40-L45).
- **DR-06 `cacheHints` scope tracks auth.** `private` when `API_KEY` is set,
  `public` on loopback. Context from
  [`src/server.ts:116-129`](../../../src/server.ts#L116-L129).

Write normal prose (this is a persistent doc, not caveman). Reference each
source with a relative markdown link as above.

**Verify**: `node scripts/tasks.mjs --quick` → `4/4 passed (2 skipped)`; plus
`test -f docs/mcp-decisions.md` → exit 0.

### 2. Fix the two `instanceof` assertions (Finding 4)

In [`__tests__/resources.test.ts`](../../../__tests__/resources.test.ts):

1. Replace the import on line 1:

   ```ts
   import { ProtocolErrorCode } from '@modelcontextprotocol/server';
   ```

   (drops `ProtocolError`, `ResourceNotFoundError` — unused after this step;
   keeping them fails lint `max-warnings=0`.)

2. Replace the `ResourceNotFoundError` assertion at line 226 with a `.code` +
   `.data.uri` check (the distinguishing field per
   [`src/resources.ts:434-435`](../../../src/resources.ts#L434-L435)):

   ```ts
   (err: unknown) => {
     assert(typeof err === 'object' && err !== null && 'code' in err);
     assert.strictEqual(
       (err as { code: ProtocolErrorCode }).code,
       ProtocolErrorCode.InvalidParams,
     );
     assert.ok((err as { data?: { uri?: string } }).data?.uri);
     return true;
   },
   ```

3. Replace the `ProtocolError` assertion at line 237 with the `.code` check
   (matches
   [`src/resources.ts:423-425`](../../../src/resources.ts#L423-L425),
   InvalidParams):

   ```ts
   (err: unknown) => {
     assert(typeof err === 'object' && err !== null && 'code' in err);
     assert.strictEqual(
       (err as { code: ProtocolErrorCode }).code,
       ProtocolErrorCode.InvalidParams,
     );
     return true;
   },
   ```

**Verify**: `npm run test` → all pass (the two `resources.test.ts` cases still
green); then `node scripts/tasks.mjs --quick` → `4/4 passed`.

### 3. Add `__tests__/input-required.test.ts` — the `input_required` round-trip (Finding 2)

New file. Import the unit under test directly:

```ts
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, FsError, isFsError } from '../src/core/errors.js';
import {
  buildInputRequired,
  confirmInput,
  pendingRoundTrip,
  readAcceptedConfirm,
  requestStateCodec,
} from '../src/tools/input-required.js';
```

Cover these cases (each independently, no shared mutable state):

1. **`requestStateCodec` mint/verify round-trip.**
   `const wire = await requestStateCodec.mint({ op: 'delete', paths: ['/a','/b'] });`
   `const decoded = requestStateCodec.verify(wire);` →
   `decoded.op === 'delete'` and `decoded.paths` equals `['/a','/b']` (sorted by
   `buildInputRequired`; mint sorts too).
2. **`requestStateCodec.verify` rejects a tampered token.** Flip one character of
   `wire` (only if non-empty) → `assert.throws(() => requestStateCodec.verify(tampered))`.
3. **`pendingRoundTrip` with no `requestState` mints a fresh `input_required`.**
   `requestState: undefined` → result is `InputRequiredResult`
   (`isInputRequiredResult(result) === true`).
4. **`pendingRoundTrip` same-op + same paths returns `undefined`** (proceed).
   Build a verified state via `requestStateCodec.mint({op:'move', paths:['/x']})`
   then `requestStateCodec.verify`, pass `requestState: () => decoded`,
   `pending: ['/x']`, `op: 'move'` → result `=== undefined`.
5. **`pendingRoundTrip` same-op + different paths throws `FsError(INVALID_INPUT)`**
   (R9). `requestState` returns decoded for `paths: ['/x']`; call with
   `pending: ['/y']`, `op: 'move'` →
   `assert.throws(() => pendingRoundTrip(…), (e) => isFsError(e) && e.code === ErrorCode.INVALID_INPUT)`.
6. **`pendingRoundTrip` different-op mints fresh** (foreign-but-valid state is
   not a tamper error). `requestState` returns `{op:'grant', paths:['/x']}`;
   call with `op: 'delete'`, `pending: ['/x']` → `InputRequiredResult`.
7. **`buildInputRequired` shape.**
   `const r = await buildInputRequired({op:'delete', paths:['/a']}, [confirmInput('confirm_0','Delete /a?')]);`
   → `isInputRequiredResult(r) === true`, `r.inputRequests['confirm_0']` is
   defined, `typeof r.requestState === 'string'` and non-empty.
8. **`readAcceptedConfirm` accept-true → `true`.**
   `readAcceptedConfirm({ confirm_0: { action: 'accept', content: { confirm: true } } }, 'confirm_0')` → `true`.
9. **`readAcceptedConfirm` decline / cancel / missing-key / accept-without-confirm → `false`**
   (one assertion each): `{ action: 'decline' }`, `{ action: 'cancel' }`,
   `{}` under a different key, and `{ action: 'accept', content: {} }` (no
   `confirm`) each return `false`.

Use the `ElicitResult` fixture shape `{ action: 'accept'|'decline'|'cancel', content?: { confirm: boolean } }`
confirmed in
`node_modules/@modelcontextprotocol/core/dist/auth-CUe6YdwF.mjs:1201-1213` — do
not invent other field names.

**Verify**: `npm run test` → the new file's cases pass; `node scripts/tasks.mjs --quick` → `4/4 passed`.

### 4. Add `__tests__/resources-subscribe.test.ts` — the subscribe round-trip (Finding 7)

New file. Use the existing in-memory pair harness (legacy era →
`sendResourceUpdated` branch). Import:

```ts
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { after, before, describe, it } from 'node:test';

import { buildFileResourceUri } from '../src/core/file-uri.js';
import { cleanupTestRoot, createTestClientPair, createTestRoot, writeTestFile } from './helpers.js';
```

Flow:

1. `before`: `tmpDir = await createTestRoot();` `pair = await createTestClientPair([tmpDir]);`
   `await writeTestFile(tmpDir, 'watch.txt', 'initial');`
2. Subscribe and collect the notification URI:
   - `const uri = buildFileResourceUri(join(tmpDir, 'watch.txt'));`
   - `let received: string | undefined;`
   - `pair.client.setNotificationHandler('notifications/resources/updated', (n) => { received = (n.params as { uri: string }).uri; });`
     (confirm the notification method name against the SDK export
     `ResourceUpdatedNotification` if the handler does not fire — it is
     `notifications/resources/updated`.)
   - `await pair.client.subscribeResource({ uri });`
3. Trigger: `await writeFile(join(tmpDir, 'watch.txt'), 'changed');`
4. Poll up to 2 s for `received` to equal `uri` (the `WatcherRegistry` debounces
   ~50 ms; a fixed wait flakes on CI — mirror the poll loop at
   [`__tests__/resources.test.ts:327-333`](../../../__tests__/resources.test.ts#L327-L333)).
5. Unsubscribe: `await pair.client.unsubscribeResource({ uri });` then assert a
   second `writeFile` does not fire the handler (poll 300 ms, assert
   `received` unchanged — best-effort; flakiness here is acceptable, mark the
   assertion `assert.ok` with a short deadline and a comment).
6. `after`: `await pair.close(); await cleanupTestRoot(tmpDir);`

If `client.subscribeResource` / `unsubscribeResource` are not present on the
`Client` surface, STOP — the harness era does not expose legacy subscribe and
the step's assumption is false.

**Verify**: `npm run test` → new file passes (may be slow due to fs.watch;
allow up to 60 s); `node scripts/tasks.mjs --quick` → `4/4 passed`.

### 5. Add `__tests__/http-server.test.ts` — the real HTTP server (Finding 3)

New file. Spawn the real Express server, exercise the full middleware chain and
the era-branch over real HTTP. Import:

```ts
import { Client } from '@modelcontextprotocol/client';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { ALL_REGISTERED_TOOL_NAMES } from '../src/tools/index.js';
import { startHttpServer } from '../src/transport.js';
import { cleanupTestRoot, createTestRoot, writeTestFile } from './helpers.js';
```

`beforeEach`: create `tmpDir`, set `process.env['API_KEY'] = 'x-test-key-0123456789'`
(≥16 chars, satisfies `isSecureApiKey`), set `process.env['HTTP_HOST'] = '127.0.0.1'`,
`const httpServer = await startHttpServer(0, { cliAllowedDirs: [tmpDir] });`,
`const port = (httpServer.address() as AddressInfo).port;`,
`const base = new URL('http://127.0.0.1:port/mcp')`.
`afterEach`: `delete process.env['API_KEY']; delete process.env['HTTP_HOST'];`
then `await new Promise<void>((r) => httpServer.close(() => r()));` then
`await cleanupTestRoot(tmpDir);`.

> Note: `startHttpServer` reads `API_KEY` / `HTTP_HOST` from env at call time
> ([`src/transport.ts:946-947`](../../../src/transport.ts#L947)), so set them
> before the call and delete after.

Cases:

1. **`/healthz` is open and reports ok.**
   `const r = await fetch(new URL('http://127.0.0.1:port/healthz'));`
   `assert.strictEqual(r.status, 200);` body JSON `.status === 'ok'`.
2. **POST `/mcp` without Authorization → 401** (bearer middleware wired before
   the route, [`src/transport.ts:812`](../../../src/transport.ts#L812)).
   `const r = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });`
   `assert.strictEqual(r.status, 401);`
3. **Full MCP handshake + tool call over real HTTP with bearer** (modern leg,
   era-branch → modern). Build a client pointing at the live URL with a
   fetch that adds the header:

   ```ts
   const transport = new StreamableHTTPClientTransport(base, {
     fetch: (url, init) =>
       fetch(url, {
         ...(init as RequestInit),
         headers: {
           ...((init as RequestInit).headers as Record<string, string>),
           Authorization: 'Bearer x-test-key-0123456789',
         },
       }),
   });
   const client = new Client(
     { name: 'http-server-test', version: '1.0.0' },
     { versionNegotiation: { mode: 'auto' } },
   );
   await client.connect(transport);
   const tools = await client.listTools();
   assert.strictEqual(tools.tools.length, ALL_REGISTERED_TOOL_NAMES.length);
   const file = await writeTestFile(tmpDir, 'real.txt', 'real-http-body');
   const res = await client.callTool({ name: 'read', arguments: { path: file } });
   assert.notStrictEqual(res.isError, true);
   await client.close();
   ```

   Assert the read text block contains `'real-http-body'` (reuse
   `firstTextBlock` from `./helpers.js` if desired).

4. **Era-branch routes a 2025-era initialize to the legacy sessionful stack.**
   Send a raw 2025 initialize (no `resultType`, `protocolVersion: '2025-11-25'`):

   ```ts
   const r = await fetch(base, {
     method: 'POST',
     headers: {
       'content-type': 'application/json',
       Authorization: 'Bearer x-test-key-0123456789',
       accept: 'application/json, text/event-stream',
     },
     body: JSON.stringify({
       jsonrpc: '2.0',
       id: 1,
       method: 'initialize',
       params: {
         protocolVersion: '2025-11-25',
         capabilities: {},
         clientInfo: { name: 'legacy-probe', version: '1.0.0' },
       },
     }),
   });
   assert.strictEqual(r.status, 200);
   assert.ok(r.headers.get('mcp-session-id'), 'legacy leg must return a session id');
   ```

   A 2025 initialize that mis-routed to the modern leg (`legacy: 'reject'`)
   would return `415`, so `status === 200` plus a `mcp-session-id` header proves
   the legacy branch. If `status` is `415`, STOP — `isLegacyRequest` did not
   classify this envelope as legacy and the step's assumption is false; report
   the actual status and headers.

   > The client in case 3 negotiates 2026-07-28 and exercises the modern branch;
   > case 4 exercises the legacy branch. Together they cover the era-branch at
   > [`src/transport.ts:814-842`](../../../src/transport.ts#L814-L842).

**Verify**: `npm run test` → new file passes; `node scripts/tasks.mjs` → `6/6 passed`.

## Done

Machine-checkable. All must hold:

- [ ] `node scripts/tasks.mjs --quick` exits 0 (`4/4 passed`)
- [ ] `npm run test` exits 0, including new cases for: `input-required.test.ts`
      (codec round-trip, R9 mismatch, `readAcceptedConfirm` accept/decline),
      `resources-subscribe.test.ts` (subscribe → change → notification),
      `http-server.test.ts` (401 without bearer, handshake+callTool with bearer,
      `/healthz`, era-branch 200 + `mcp-session-id`)
- [ ] `node scripts/tasks.mjs` exits 0 (`6/6 passed`)
- [ ] `git status` shows only: `docs/mcp-decisions.md`, `docs/plan/…`,
      `__tests__/resources.test.ts`, `__tests__/input-required.test.ts`,
      `__tests__/resources-subscribe.test.ts`, `__tests__/http-server.test.ts`
      — no production source modified

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt (run the drift check first).
- `readAcceptedConfirm` fixtures in the shape `{ action, content: { confirm } }`
  do not drive `inputResponse` / `acceptedContent` as expected — re-read
  `node_modules/@modelcontextprotocol/core/dist/auth-CUe6YdwF.mjs:1201` and
  adjust the fixture before continuing.
- `client.subscribeResource` / `unsubscribeResource` are not present on the
  `@modelcontextprotocol/client` `Client` — the in-memory-pair legacy subscribe
  path is unavailable and step 4's assumption is false.
- The 2025-era initialize in step 5 returns `415` — `isLegacyRequest` did not
  classify it as legacy and the era-branch assertion is wrong; report the actual
  status and response headers.
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation.
- The fix appears to require an out-of-scope (production source) file.

## Notes

- **What a reviewer should scrutinize:** step 5 case 4 (the era-branch 2025
  initialize) is the one assertion resting on `isLegacyRequest`'s
  classification rather than a directly-observed contract — it is gated as a
  STOP condition. Step 3 case 5 (R9 mismatch) is the highest-value guard test;
  confirm it throws `INVALID_INPUT`, not a generic error.
- **Deferred (out of scope here):** the modern `subscriptions/listen` SSE stream
  over the `InMemoryServerEventBus` is not exercised end-to-end — it needs an
  SSE client parser and the SDK-owned listen router; the `WatcherRegistry` unit
  and the legacy subscribe round-trip (step 4) cover the watcher + notify
  wiring. Add a `subscriptions/listen` stream test when an SSE test helper is
  introduced. Host/Origin validation is unit-covered in `http-policy.test.ts`;
  the integration test does not re-prove it (Node `fetch` forbids overriding the
  `Host` header).
- **Rollback:** all changes are additive (one new doc, three new test files) or
  a two-line test edit — `git checkout -- . && rm -rf docs/` restores the tree.
  No production data or migrations.
