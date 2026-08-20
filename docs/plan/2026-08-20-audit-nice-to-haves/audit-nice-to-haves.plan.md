# Plan: Accept IPv6 loopback browser origins, and record the MCP design decisions

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `18f500b` **plus uncommitted working-tree changes**
> from an audit session, 2026-08-20. `HEAD` has not moved since those edits, so
> a plain SHA diff will not show them.
>
> **Drift check (run first)**:
>
> ```
> git diff --stat -- src/transport.ts __tests__/http.test.ts
> grep -n "evictionReason\|protectedResourceMetadata" src/transport.ts
> ```
>
> Expect `src/transport.ts` and `__tests__/http.test.ts` to appear as modified,
> and both greps to hit. If `evictionReason` or `protectedResourceMetadata` is
> missing, the working tree is not the one this plan was written against — that
> is a [STOP](#stop) condition. Then compare [Current state](#current-state)
> against the live code for every file listed there.

## Goal

Two loose ends from an MCP SDK v2 audit of this server, neither of which
changes how the server behaves for any client that works today.

1. `[::1]` is accepted as a bind host but rejected as a browser `Origin`. A
   browser client served from `http://[::1]:<port>` gets a `403` from the SDK's
   origin validation, while the identical page on `http://localhost:<port>`
   works. The two spellings of loopback should behave the same.
2. There is no `docs/mcp-decisions.md`. This server has made a dozen non-obvious
   MCP design choices — hand-wired sessions instead of `createMcpHandler`, no
   `logging` capability, a static bearer key instead of OAuth — and each one
   currently survives only as a comment next to the code that implements it. The
   `mcp-hub` tooling looks for that file and reports its absence on every edit.

Requirements covered: none, this is a fix plus a document.

## Current state

### IPv6 loopback origin

Loopback **hosts** already include the IPv6 spelling —
[`transport.ts:259-264`](../../../src/transport.ts#L259-L264):

```ts
export function isLoopbackHttpHost(host: string): boolean {
  const normalizedHost = host.trim().toLowerCase();
  return (
    normalizedHost === '127.0.0.1' || normalizedHost === 'localhost' || normalizedHost === '[::1]'
  );
}
```

Loopback **origins** do not —
[`transport.ts:194-196`](../../../src/transport.ts#L194-L196):

```ts
const ALLOWED_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u,
];
```

That regex backs [`isOriginAllowed()`](../../../src/transport.ts#L287-L291), which
the app's own `OPTIONS /mcp` handler calls at
[`transport.ts:934`](../../../src/transport.ts#L934) to decide whether to reflect
`Access-Control-Allow-Origin`.

**The regex is not the load-bearing half.** The SDK's `originValidation`
middleware runs app-wide and rejects first, with `403`, before any route handler
is reached. It is armed from this list —
[`transport.ts:902-907`](../../../src/transport.ts#L902-L907):

```ts
const allowedOriginHostnames = (
  process.env['FILESYSTEM_MCP_ALLOWED_ORIGINS'] ?? 'localhost,127.0.0.1'
)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
```

which is passed as `allowedOrigins` at
[`transport.ts:909-916`](../../../src/transport.ts#L909-L916). Proof that the SDK
layer rejects first: the existing test at
[`http.test.ts:773-788`](../../../__tests__/http.test.ts#L773-L788) sends
`Origin: https://evil.com` and asserts **403**, a status the local `OPTIONS`
handler never emits.

Two facts verified against the installed SDK, both load-bearing:

- `localhostAllowedHostnames()` from `@modelcontextprotocol/server` returns
  `["localhost","127.0.0.1","[::1]"]`. It is **already imported** at
  [`transport.ts:19`](../../../src/transport.ts#L19) and already used for the
  host list at [`transport.ts:891`](../../../src/transport.ts#L891).
- `new URL('http://[::1]:3000').hostname` is `"[::1]"` — brackets included, so it
  compares equal to the list entry above with no normalization step.

Test convention to imitate: raw-socket requests via `rawHttpRequest`, one server
per case pushed onto `servers`, as in
[`http.test.ts:756-771`](../../../__tests__/http.test.ts#L756-L771).

### Decision record

`docs/` does not exist in this repo. The `mcp-planning` skill defines the file as
a dated section appended to `docs/mcp-decisions.md`, listing all 16 decisions,
each tagged `(asked)` or `(default)`. Values for this server, each verifiable at
the linked location, are given in [Step 2](#2-record-the-mcp-design-decisions).

## Commands

| Purpose    | Command                                 | Expected on success                   |
| ---------- | --------------------------------------- | ------------------------------------- |
| Quick gate | `node scripts/tasks.mjs --quick`        | `4/4 passed  (2 skipped)`             |
| Full gate  | `node scripts/tasks.mjs`                | `6/6 passed`                          |
| HTTP suite | `npx tsx --test __tests__/http.test.ts` | `pass 31`, `fail 0` (32 after step 1) |

Run checks through `scripts/tasks.mjs`, never the raw npm scripts — that is the
convention in [`CLAUDE.md`](../../../CLAUDE.md).

## Scope

**In scope** — the only files to modify:

- [`src/transport.ts`](../../../src/transport.ts)
- [`__tests__/http.test.ts`](../../../__tests__/http.test.ts)
- `docs/mcp-decisions.md` (new)

**Files out of scope** — leave alone even though they look related:

- [`src/resources.ts`](../../../src/resources.ts) — the audit flagged the
  `desiredState` map at
  [`resources.ts:205`](../../../src/resources.ts#L205) as never pruned. Do not
  "fix" it. The entry set to `'unsubscribed'` at
  [`resources.ts:339`](../../../src/resources.ts#L339) is read after an `await`
  by the in-flight subscribe at
  [`resources.ts:303`](../../../src/resources.ts#L303) to abort a subscription
  that was cancelled mid-validation. Deleting the entry makes that check read
  `undefined`, the guard stops firing, and an `fs.watch` handle leaks for a URI
  the client already unsubscribed — trading a bounded map of short strings for an
  unbounded OS handle leak. See [Notes](#notes).
- [`src/core/path.ts`](../../../src/core/path.ts) — `isLoopbackHttpHost` lives in
  `transport.ts`, not here; path normalization is unrelated to HTTP origins.
- [`__tests__/unit/http-auth-guard.test.ts`](../../../__tests__/unit/http-auth-guard.test.ts)
  — unit-tests the pure policy functions. The behavior that changes in step 1 is
  the SDK middleware's, which only an HTTP-level test observes.

## Steps

### 1. Treat `[::1]` as loopback for origins, as it already is for hosts

Two edits in [`src/transport.ts`](../../../src/transport.ts), both required —
the first alone changes nothing observable, because the SDK middleware rejects
before the local handler runs.

**1a.** At [`transport.ts:194-196`](../../../src/transport.ts#L194-L196), extend
the pattern to the bracketed IPv6 literal. The brackets are regex-escaped:

```ts
const ALLOWED_ORIGIN_PATTERNS: readonly RegExp[] = [
  /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/u,
];
```

**1b.** At [`transport.ts:902-907`](../../../src/transport.ts#L902-L907), source
the default from the SDK helper rather than a hand-written string, so the default
tracks whatever the SDK considers loopback:

```ts
const originsEnv = process.env['FILESYSTEM_MCP_ALLOWED_ORIGINS'];
const allowedOriginHostnames = originsEnv
  ? originsEnv
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s.length > 0)
  : localhostAllowedHostnames();
```

Keep the comment block above it; update its "Default to the localhost set"
sentence to name `localhostAllowedHostnames()`. One deliberate behavior change to
note in the comment: `FILESYSTEM_MCP_ALLOWED_ORIGINS=""` now reads as unset (the
localhost set) rather than as an empty list, which matches how
[`parseAllowedHostsEnv`](../../../src/transport.ts#L342-L347) already treats an
all-empty value.

**1c.** Add a test to [`__tests__/http.test.ts`](../../../__tests__/http.test.ts)
directly after
[`http.test.ts:771`](../../../__tests__/http.test.ts#L771), mirroring the case
above it:

```ts
it('accepts an IPv6 loopback origin in CORS preflight', async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-http-'));
  const server = await startHttpServer(0, { cliAllowedDirs: [tempDir] });
  servers.push(server);
  const port = getServerPort(server);

  // http://[::1]:<port> is the same loopback as http://localhost:<port>;
  // isLoopbackHttpHost has always accepted it as a bind host.
  const response = await rawHttpRequest({
    port,
    method: 'OPTIONS',
    path: '/mcp',
    headers: { origin: 'http://[::1]:3000' },
  });

  assert.equal(response.statusCode, 204);
  assert.equal(response.headers['access-control-allow-origin'], 'http://[::1]:3000');
});
```

Before applying 1a/1b, run this test and confirm it fails with `403` — that
proves it observes the SDK middleware and not just the local handler.

**Verify**: `npx tsx --test __tests__/http.test.ts` → `pass 32`, `fail 0`

### 2. Record the MCP design decisions

Create `docs/mcp-decisions.md` with exactly this content. Every value below was
read out of the code at the linked location — transcribe them, do not re-derive:

```markdown
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
```

Verification pointers for a reviewer, not for the file: 12 tools in
[`tools/index.ts:15-28`](../../../src/tools/index.ts#L15-L28); capability set and
the no-logging rationale in
[`server.ts:103-112`](../../../src/server.ts#L103-L112); hand-wired transport at
[`transport.ts:592`](../../../src/transport.ts#L592); bearer policy at
[`transport.ts:313-328`](../../../src/transport.ts#L313-L328); Node engine in
[`package.json`](../../../package.json).

**Verify**: `node scripts/tasks.mjs --quick` → `4/4 passed  (2 skipped)`
(Prettier reformats the new Markdown in the `format` task; that is expected and
is not a failure.)

## Done

Machine-checkable. All must hold:

- [ ] `node scripts/tasks.mjs` exits 0 and prints `6/6 passed`
- [ ] `npx tsx --test __tests__/http.test.ts` exits 0 with `pass 32`, `fail 0`,
      including the new IPv6 preflight case
- [ ] `git status --porcelain` lists only `src/transport.ts`,
      `__tests__/http.test.ts`, and `docs/mcp-decisions.md` beyond the
      already-modified files named in the drift check
- [ ] `grep -cF '::1' src/transport.ts` returns `2` — it returns `1` today, the
      host check at [`transport.ts:262`](../../../src/transport.ts#L262); step 1a
      adds the origin pattern as the second. Match on `::1`, not on `[::1]`: the
      regex source escapes its brackets as `\[::1\]`, so a fixed-string search
      for the bracketed form misses it, and an unescaped one reads the brackets
      as a character class and matches hundreds of lines.

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt, or the drift-check greps miss.
- The new preflight test still returns `403` after both 1a and 1b are applied.
  That would mean the SDK's `validateOriginHeader` normalizes the bracketed
  hostname differently than `new URL().hostname` does, and the fix needs a
  different shape than a list entry.
- The new preflight test **passes before** 1a/1b are applied — it is then not
  observing the middleware, and proves nothing.
- A step's verification fails twice after one fix attempt.
- The fix appears to require a file outside [Scope](#scope) — in particular, any
  change under [`src/resources.ts`](../../../src/resources.ts).

## Notes

- Scrutinize 1b: it changes the meaning of an empty
  `FILESYSTEM_MCP_ALLOWED_ORIGINS`, and it widens the default origin set by one
  entry. Both are intended; neither loosens anything beyond loopback, which the
  host policy has always accepted.
- Deliberately deferred: the `desiredState` pruning flagged by the audit. It is
  bounded by the number of distinct URIs subscribed within one session, holds
  only a short string and an enum per entry, and sessions are now evicted on an
  idle timeout — so the map cannot outlive an abandoned client. A safe prune
  needs a per-URI in-flight counter so the race guard at
  [`resources.ts:303`](../../../src/resources.ts#L303) keeps working; that is
  more moving parts than the leak justifies. Revisit only if a profiler names it.
- No rollback section: both steps are additive edits to source and a new
  document, with no migration and no production data. `git checkout --
src/transport.ts __tests__/http.test.ts && rm -r docs/` reverses everything.
