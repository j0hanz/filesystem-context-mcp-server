# MCP Decision Record — 2026-08-21

SEP-2577 era migration: remove deprecated `listRoots` / `getClientCapabilities` /
`elicitInput`, move server to the 2026-07-28 modern protocol era. Existing server
behavior unchanged unless noted; this migration only touches the deprecated surfaces.

1. Scope: server exposing guarded filesystem tools. (established)
2. Transport: stdio + Streamable HTTP. (established, unchanged)
3. Auth: custom bearer — static `API_KEY`, `verifyAccessToken`/`timingSafeEqual` on
   SHA-256 digests, non-loopback bind refused without key. (established, unchanged)
4. Tool Surface: many simple tools (read/write/search/diff/patch + subtools). (established)
5. Input Schemas: `zod ^4.2.0` via `import * as z from 'zod/v4'`. (established)
6. Interaction: multi-round-trip — destructive confirmations return `input_required`
   and the client re-calls with responses. (asked)
7. Prompts: completable (`completable(...)` + `PathCompleter`). (established)
8. Error Strategy: protocol errors only. (default)
9. Distribution: npm (`@j0hanz/filesystem-mcp`). (established)
10. Testing: 1 test per tool. (default)
11. Session/Resumability: `EventStore`-backed resumable sessions on HTTP
    (`InMemoryEventStore`, single-node). (established, unchanged)
12. Notifications: `subscriptions/listen` — `resources: { subscribe: true }`. (established)
13. Era / Protocol Revision: modern only — `legacy: 'reject'`, drop the 2025-11-25
    fallback path. (asked)
14. Runtime: Node ≥24, ESM-first, `"type":"module"`. (established)
15. Staging: one-shot — all three deprecated surfaces in one branch/PR. (asked)
16. Elicitation: `input_required` result type — on `elicitInput` throw (or unconditionally
    on modern era), return `input_required`; client re-calls with responses. No client
    `elicitation` capability dependency. (asked)
