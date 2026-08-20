# MCP Decision Record — 2026-08-20

1. Scope: server exposing 12 tools. (asked)
2. Transport: stdio by default, Streamable HTTP under `--port`. (asked)
3. Auth: custom bearer — static `API_KEY`, constant-time compare, no
   authorization server. Loopback binds may run unauthenticated; non-loopback
   binds refuse to start without a key. (asked)
4. Tool Surface: few big with settings — every tool takes batch input plus an
   option set. (asked)
5. Input Schemas: zod ^4.4.3 via `zod/v4`, with a precomputed draft-2020-12 JSON
   Schema published to clients. (asked)
6. Interaction: progress and cancellation. Multi-round-trip `inputRequired` is
   deliberately not adopted. (asked)
7. Prompts: completable — 4 prompts with argument completion. (asked)
8. Error Strategy: both channels — tool handlers return `isError`, resource and
   prompt callbacks throw `ProtocolError`. (asked)
9. Distribution: npm as `@j0hanz/filesystem-mcp`, plus a stdio Docker image.
   (asked)
10. Testing: node:test — per-tool, unit, and HTTP integration. (asked)
11. Session/Resumability: `EventStore`-backed resumable sessions, one store per
    session. (asked)
12. Notifications: resource subscriptions with `resources/updated`; no `logging`
    capability, since every diagnostic goes to stderr. (asked)
13. Era / Protocol Revision: 2025-era only — hand-wired
    `NodeStreamableHTTPServerTransport`, no `createMcpHandler`. (asked)
14. Runtime: Node ≥ 24, ESM-only. (asked)
15. Staging: one-shot — already on split v2 packages. (default)
16. Elicitation: `ctx.mcpReq.elicitInput` in form mode, with a shared
    unavailable-connection fallback. (asked)
