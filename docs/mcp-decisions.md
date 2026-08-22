# MCP Architectural Decision Records

This document records deliberate architectural decisions, trade-offs, and deferred migrations across the MCP SDK v2 implementation in this server.

---

## DR-01: Both-era serving posture

### Decision

Serve both modern (2026-07-28 era) and legacy (2025-11-25 era) clients over HTTP and stdio:

- The HTTP endpoint (`/mcp`) branches incoming requests based on protocol probe:
  - Modern requests route to `createMcpHandler(..., { legacy: 'reject' })` ([`src/transport.ts:980`](../src/transport.ts#L980)).
  - Legacy requests route to the sessionful stack backed by `NodeStreamableHTTPServerTransport` ([`src/transport.ts:475`](../src/transport.ts#L475)).
- Stdio serves legacy protocol clients via `serveStdio(factory, { legacy: 'serve' })` ([`src/transport.ts:210`](../src/transport.ts#L210)).

### Context

Clients in the ecosystem are transitioning across MCP protocol versions. Supporting both eras enables smooth interoperability with current and older MCP client implementations without forcing an immediate ecosystem-wide migration.

### Consequence

Maintaining dual-era support requires keeping the sessionful HTTP stack, the era-branch router in `POST /mcp`, and legacy synchronizers alongside the modern streamable HTTP stack.
**Revisit when**: 2025-era clients are fully retired in the client ecosystem. At that point, delete the legacy sessionful stack, `HttpSessionRegistry`, and the era-branch router.

---

## DR-02: Static API-key resource server (no IdP)

### Decision

Use a hand-rolled `bearerAuthMiddleware` ([`src/http-policy.ts:228-262`](../src/http-policy.ts#L228-L262)) based on constant-time comparison (`timingSafeEqual`) instead of `requireBearerAuth` from `@modelcontextprotocol/express`.

### Context

From [`src/http-policy.ts:170-186`](../src/http-policy.ts#L170-L186):

> This server is a resource server with no authorization server: `API_KEY` is a static secret the operator hands out of band, not an issued token. So the metadata document deliberately omits `authorization_servers` — RFC 9728 §2 makes it optional, and its absence is the accurate statement that a token cannot be obtained from an endpoint. `mcpAuthMetadataRouter` from `@modelcontextprotocol/express` is the tool for the IdP-backed case: it requires RFC 8414 authorization-server metadata, and inventing an issuer with endpoints that answer nothing would send clients into a flow that cannot complete. Adopt it if this ever moves to a real IdP.
>
> What discovery buys here: a client hitting 401 learns the resource identifier and that the credential goes in the Authorization header, instead of a bare challenge plus a 404 on the well-known path.

### Consequence

`req.auth` / `ctx.http?.authInfo` is never populated with user identity, meaning per-user authorization policies cannot be enforced. `PathGuard` serves as the sole authorization mechanism for filesystem boundaries.
**Revisit when**: The deployment moves to a central identity provider (IdP) issuing OAuth/OIDC tokens; then adopt `requireBearerAuth` and `mcpAuthMetadataRouter`.

---

## DR-03: Per-process `requestState` key

### Decision

Sign and verify `requestState` tokens using an HMAC key derived from `FILESYSTEM_MCP_REQUEST_STATE_KEY` or a random 32-byte secret generated in-memory at process boot ([`src/tools/input-required.ts:49-57`](../src/tools/input-required.ts#L49-L57)).

### Context

From [`src/tools/input-required.ts:49-57`](../src/tools/input-required.ts#L49-L57):

> HMAC key for the requestState codec. Read once from `FILESYSTEM_MCP_REQUEST_STATE_KEY` (UTF-8, must be >=32 bytes); a random 32-byte key is generated at boot when the env var is unset or too short. A per-process key is correct here because one process serves every round of a flow (stdio is single-process; HTTP runs a single node with `InMemoryEventStore` — decision record 11). A server restart invalidates in-flight tokens; the client re-requests, which is fail-closed and safe.

### Consequence

A server restart invalidates any pending in-flight `input_required` confirmation tokens. The client will encounter an invalid token error and must initiate the destructive operation again to receive a fresh token (fail-closed security posture).
**Revisit when**: The server is scaled horizontally across multiple nodes behind a load balancer without sticky sessions, requiring a shared cluster-wide key or key management service.

---

## DR-04: `InMemoryEventStore` resumability is per-session and lost on restart

### Decision

Use `InMemoryEventStore` scoped to individual sessions in the legacy sessionful HTTP stack ([`src/transport.ts:447-449`](../src/transport.ts#L447-L449)).

### Context

From [`src/transport.ts:447-449`](../src/transport.ts#L447-L449):

> Scoped to this session: see the InMemoryEventStore doc comment.

The event store buffers server-sent events for reconnecting clients using the `Last-Event-ID` header during transient network disconnects.

### Consequence

Events buffered in `InMemoryEventStore` do not survive a server restart or process crash. Reconnecting clients whose sessions existed before restart must establish a new connection.
**Revisit when**: Resumable SSE streams are required to persist across process restarts, which would necessitate backing the event store with durable storage (e.g., Redis or disk).

---

## DR-05: Deprecated `listRoots` / `getClientCapabilities` (SEP-2577) — deferred removal

### Decision

Retain calls to `@deprecated` `server.server.getClientCapabilities()` and `server.server.listRoots()` inside `updateRootsFromClient` ([`src/core/registrar.ts:40-45, 212-219`](../src/core/registrar.ts#L40-L45)), gated strictly to legacy connections.

### Context

From [`src/core/registrar.ts:40-45, 212-219`](../src/core/registrar.ts#L40-L45):

> `Root` is deprecated (SEP-2577, 2026-07-28 era) in favor of passing paths via tool parameters/resource URIs/config. The MCP Roots protocol remains the live, negotiated mechanism on the 2025-11-25 era and works correctly there; on the 2026-07-28 era the roots synchronizer is not armed (allowed directories come from configuration), so these helpers only run on legacy.
>
> getClientCapabilities()/listRoots(): deprecated (SEP-2577, 2026-07-28 era); listRoots() throws on that era (the push-style server→client request model is replaced by `input_required` there). This method is only reached on legacy-era connections — the serving factories gate `registerHandlers` to `ctx.era === 'legacy'` (stdio) or the legacy sessionful HTTP stack, so `updateRootsFromClient` never runs on a modern instance. The calls stay correct on the 2025-11-25 era they serve.

There is no forward API to migrate to since Roots is sunset in favor of configuration and `input_required`.

### Consequence

`@typescript-eslint/no-deprecated` must be explicitly disabled on these call sites.
**Revisit when**: Legacy 2025-11-25 era support is removed from the codebase. At that time, delete `McpRootsSynchronizer` and all associated helpers wholesale.

---

## DR-06: `cacheHints` scope tracks auth

### Decision

Set `cacheHints` `cacheScope` dynamically: `'private'` when `API_KEY` is configured, `'public'` for local/unauthenticated loopback use ([`src/server.ts:116-129`](../src/server.ts#L116-L129)).

### Context

From [`src/server.ts:116-129`](../src/server.ts#L116-L129):

> 'private' under auth: a shared CDN must not serve the (identical) tool and prompt rosters to other clients when a bearer is required. 'public' stays correct for loopback dev. stdio ignores HTTP cache hints either way. Agrees with bearerAuthMiddleware by construction: assertHttpBindingPolicy throws at startup for any empty/<16-char API_KEY, so a truthy key here is exactly the case the bearer guard enforces — the two reads cannot diverge.

### Consequence

Shared intermediate caches (e.g. CDNs or forward proxies) will not cache tool and prompt rosters across different clients when authentication is enabled, preventing cross-tenant leakage.
**Revisit when**: Fine-grained per-tool caching policies or custom multi-tenant authorization tiers are introduced.
