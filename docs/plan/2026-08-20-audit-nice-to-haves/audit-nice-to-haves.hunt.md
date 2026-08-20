# Hunt: 2026-08-20

Scope: uncommitted changes in the working tree — 7 files, 3649 lines. Subject is
the audit-remediation work of this session (per-session event store, idle session
eviction, elicitation era handling, 401 auth discovery, IPv6 loopback origin).

**Verdict**: one Confirmed defect, Minor — an unguarded `new URL()` on the Host
header turns a 401 into a 500, and the comment that justified omitting the guard
is factually wrong.

## Confirmed

### 1. Minor — unguarded `new URL()` on a request header

[`transport.ts:349`](../../../src/transport.ts#L349), in `protectedResourceUrl`:

```ts
return new URL(`${scheme}://${host}${MCP_PATH}`);
```

**Trigger** — any request whose `Host` contains a space or `%` (forbidden WHATWG
host code points), against a server with `API_KEY` set and no Host allowlist in
effect: wildcard bind plus `FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1`. Reached
from `bearerAuthMiddleware` through `buildAuthChallenge`, and from the
unauthenticated metadata route at [`transport.ts:961`](../../../src/transport.ts#L961).

**Impact** — `TypeError: Invalid URL` escapes into express's error path.
`errorHandlerMiddleware` ([`transport.ts:734-749`](../../../src/transport.ts#L734-L749))
maps only `err.status === 413` and `=== 400`, so the client receives 500 Internal
Server Error with no `WWW-Authenticate` header where it should receive a 401
challenge. Observed: `Host: a b` → `HTTP/1.1 500`; `Host: 127.0.0.1` →
`HTTP/1.1 401` with a well-formed challenge.

**Ruled out** — the only `try`/`catch` in the function wraps the other branch,
`FILESYSTEM_MCP_PUBLIC_URL` at
[`transport.ts:337-343`](../../../src/transport.ts#L337-L343). The sibling helper
`originHostname` at [`transport.ts:270-276`](../../../src/transport.ts#L270-L276)
applies exactly this catch pattern to the Origin header; this line does not.
Upstream host validation is conditional — verbatim from
`node_modules/@modelcontextprotocol/express/dist/index.mjs:138`:
`if (allowedHosts) app.use(hostHeaderValidation(allowedHosts));` — and
`allowedHosts` is computed as `[]` for a wildcard bind at
[`transport.ts:892-894`](../../../src/transport.ts#L892-L894).

**Root cause** is the comment directly above the line,
[`transport.ts:345-346`](../../../src/transport.ts#L345-L346): "Host is validated
upstream by the app's allowedHosts check". False for wildcard binds, and the
reason the guard was omitted.

**Fix** — guard the construction; where the resource identifier cannot be
determined, omit the `resource_metadata` parameter rather than name a wrong
resource. Correct the comment to state that upstream validation applies only when
an allowlist is configured.

**Severity** — torn between Minor and Major, taking the lower: it requires an
opted-out configuration and yields a wrong status code rather than wrong data.

## Suspected

### 2. `res.once('close')` may never fire, pinning `activeRequests` above zero

[`transport.ts:725`](../../../src/transport.ts#L725). If the response has already
closed when the listener attaches, the decrement never runs and that session
becomes permanently immune to idle eviction — the leak the session work closed.
**Settles it**: whether express invokes a route handler after a client aborts
mid-body. A `res.closed` check before attaching makes the question moot.

### 3. Attacker-supplied Host echoed into `resource` on a cacheable 200

[`transport.ts:354`](../../../src/transport.ts#L354). The metadata document
returns `{"resource":"http://evil.com/mcp",…}` with no `Cache-Control`. Unlike
the 401 — which a shared cache does not store — a 200 is heuristically cacheable.
Same opt-out gate as finding 1, so this is plausibly the documented residual
rather than a defect. **Settles it**: whether any deployment places a shared
cache in front of `/.well-known/oauth-protected-resource`.

## Dismissed

- **Response header injection into `WWW-Authenticate`** via a Host containing a
  double quote (`resource_metadata="http://x",error="insufficient_scope",…`).
  Refuted: reachable only under `FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1`,
  whose documented meaning is "no Host validation", and the corrupted challenge
  is delivered solely to the requester who supplied the Host — no third party, no
  shared-cache path for a 401, and CR/LF survives neither llhttp's request parse
  nor Node's response-header validation. Do not re-raise.
- **TDZ on the shared `session` object** referenced by `onsessioninitialized`
  before its `const` initializes ([`transport.ts:668`](../../../src/transport.ts#L668)).
  The SDK invokes that callback only from request handling
  (`server/dist/index.mjs:668`), which cannot run before `createHttpSession`
  returns.
- **Eviction race** between `sweepStale` selecting a session and `registry.remove`
  dropping it. `close()` calls `cleanup()` synchronously as its first statement,
  so there is no await between the decision and the removal.
- **`denialCache` now caches the unaskable-connection case** in
  `requestAccessGrant`, where the pre-change throw path did not. Client
  capabilities and protocol era are fixed for a session's lifetime, so the
  outcome is identical either way.
- **`SECRET` tell at `__tests__/http.test.ts:1036`** — a test fixture value, not
  a credential to any real system.
- **`== null` at [`define.ts:306`](../../../src/tools/define.ts#L306)** —
  intentional null-and-undefined check.

## Coverage

Read fully: [`move.ts`](../../../src/tools/move.ts),
[`delete-file.ts`](../../../src/tools/delete-file.ts),
[`define.ts`](../../../src/tools/define.ts),
[`event-store.test.ts`](../../../__tests__/unit/event-store.test.ts),
[`elicitation-era.test.ts`](../../../__tests__/tools/elicitation-era.test.ts),
and every changed region of [`transport.ts`](../../../src/transport.ts).

Partial: [`http.test.ts`](../../../__tests__/http.test.ts) — the complete diff plus
surrounding tests, not all 1210 lines.

Not audited: the 11 `defineTool` callers in the blast radius.
`isElicitationUnavailable` is a new export and the `ToolCtx` / `startHttpServer`
signatures are unchanged, so no contract drifted into them.

Taken on trust: express's error routing, Node's `'close'` semantics on
keep-alive connections, llhttp header validation, and SDK internals beyond the
lines quoted above.
