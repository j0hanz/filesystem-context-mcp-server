# MCP v2 Schema/SDK Hygiene — Design Spec

**Date:** 2026-05-07
**Subproject:** 1 of 4 (in MCP v2 refinement series)
**Status:** Approved

## Context

The codebase is on `@modelcontextprotocol/{server,client,node} ^2.0.0-alpha.2` and uses MCP v2 idioms throughout (`McpServer`, `registerTool`, `NodeStreamableHTTPServerTransport`). Two pieces of accumulated drift remain from the v1→v2 transition:

1. **`zod` import path.** All Zod imports use the bare `zod` specifier. The v2 SDK bundles its own `zod/v4` namespace internally; using `zod` (vs. `zod/v4`) at boundaries can lead to two zod instances coexisting and produces confusing type errors at the SDK boundary.
2. **Custom `completion/complete` request handler.** [src/completions.ts](../../../src/completions.ts) installs a `setRequestHandler('completion/complete', ...)` that re-implements logic the v2 SDK provides natively via `completable()` (for prompt args) and `ResourceTemplate({ complete })` (for template variables). The custom handler also harvests cross-tool enum values that no prompt/resource currently exercises (effectively dead code).

This subproject removes both forms of drift. It is the smallest, lowest-risk piece of a four-part refinement series and intentionally lays groundwork that subsequent subprojects (Express integration, elicitation/sampling/subscriptions, task-system audit) build on.

## Goals

- Use `zod/v4` everywhere so the project's Zod instance matches the SDK's bundled instance.
- Replace the custom `completion/complete` request handler with v2-native `completable()` and `ResourceTemplate.complete` wiring on each prompt/resource that needs it.
- Preserve current path-completion UX (rate limit, per-server cache, allowed-directory enforcement, named-root resolution, context-arg awareness).
- Delete code that is unreachable today (cross-tool enum harvesting, the global ref-name dispatch table).

## Non-Goals

- HTTP transport refactor (deferred to subproject #2).
- Elicitation, sampling, or resource subscriptions (deferred to subproject #3).
- Re-evaluating per-tool `taskSupport` levels (deferred to subproject #4).
- Adding tool-input completion. The MCP `completion/complete` request only takes `ref/prompt` or `ref/resource` references; tool-input completion is not part of the protocol.
- Behavioral changes to which paths get suggested or how named roots resolve.

## Architecture

```
src/
├── completions.ts                   ← DELETED
├── lib/
│   └── path-completer.ts            ← NEW: extracted FS-walking + WeakMap cache
├── prompts.ts                       ← MODIFIED: completable() on each path/topic/name arg
├── resources.ts                     ← MODIFIED: ResourceTemplate({ complete: { name } })
└── server/bootstrap.ts              ← MODIFIED: drop registerCompletions(server, ...) call
```

### Invariants preserved

- The `completions: {}` capability stays declared on the server. Clients that detect support for completions continue to detect it.
- The `McpServer` auto-dispatches `completion/complete` based on which prompts and resources have completable args declared. No custom request handler.
- Per-server (per-HTTP-session) cache isolation is preserved via a `WeakMap<McpServer, CompletionState>` keyed by the McpServer instance threaded through closures at registration time.

### Closure-captured server pattern

`completable()` callbacks receive `(value, ctx?)` and do not get the `McpServer` instance. To preserve per-server cache isolation, registration functions capture `server` in closure when wiring the completable:

```ts
export function registerAnalyzePathPrompt(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerPrompt('analyze-path', {
    argsSchema: z.strictObject({
      path: completable(z.string(), (value, ctx) =>
        completePath(value, { server, contextArguments: ctx?.arguments })
      ),
    }),
    // ...
  });
}
```

This avoids both `AsyncLocalStorage` (overkill) and a global cache (would pollute across HTTP sessions).

## Per-prompt and per-resource wiring

### [src/prompts.ts](../../../src/prompts.ts)

| Prompt          | Arg        | New wiring                                                                                                                                               |
| --------------- | ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get-help`      | `topic`    | `completable(z.string().optional(), v => filterTopics(topics, v))` — `topics` derived once at registration from `extractTopicCompletions(instructions)`. |
| `get-tool-help` | `name`     | `completable(z.string().min(1), v => filterTools(toolNames, v))` — `toolNames` derived once from `getSortedToolContracts()`.                             |
| `analyze-path`  | `path`     | `completable(z.string(), (v, ctx) => completePath(v, { server, argumentName: 'path', contextArguments: ctx?.arguments }))`                               |
| `compare-files` | `original` | `completable(z.string(), (v, ctx) => completePath(v, { server, argumentName: 'original', contextArguments: ctx?.arguments }))`                           |
| `compare-files` | `modified` | `completable(z.string(), (v, ctx) => completePath(v, { server, argumentName: 'modified', contextArguments: ctx?.arguments }))`                           |

Existing helper utilities `filterTopics` and `filterTools` are tiny prefix filters added to `prompts.ts` (or a small `prompts/completion-filters.ts` if they need to be shared).

### [src/resources.ts](../../../src/resources.ts)

| Template                       | Variable | New wiring                                                                                                          |
| ------------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `internal://tool-info/{name}`  | `name`   | `new ResourceTemplate('internal://tool-info/{name}', { list, complete: { name: v => filterTools(toolNames, v) } })` |
| `filesystem-mcp://result/{id}` | `id`     | unchanged — no `complete` (ephemeral, opaque IDs)                                                                   |

### Behavior changes vs. today

These are intentional and visible:

- **Completion requests for arg names a prompt/resource doesn't declare → return empty.** Today the global handler dispatches purely on arg name, so e.g. `complete({ ref: { name: 'get-help' }, argument: { name: 'path' } })` returns path suggestions even though `get-help` has no `path` arg. After this change it returns empty. This is correct behavior per the protocol.
- **Cross-tool enum harvesting deleted.** The `buildEnumArgumentValues` / `getEnumCompletions` machinery in `completions.ts` scans every tool's input schema for enum values. Nothing in current prompts/resources triggers it. Removed entirely.
- **Topic completion narrows to `get-help` only.** Today any prompt with a `topic`-named arg would receive section-header completions; after this change, only `get-help` does. No other prompt has a `topic` arg today, so this is a no-op in practice.

## `path-completer.ts` API

```ts
// src/lib/path-completer.ts
import type { McpServer } from '@modelcontextprotocol/server';

export interface CompletePathOptions {
  /** McpServer instance for WeakMap cache isolation. Cache is disabled if absent. */
  server?: McpServer;
  /** Argument name (e.g., 'path', 'source', 'destination'). Drives context-key selection. */
  argumentName?: string;
  /** Sibling argument values from completion ctx — enables `modified` to resolve relative to `original`, etc. */
  contextArguments?: Record<string, string>;
}

export async function completePath(
  value: string,
  options?: CompletePathOptions
): Promise<string[]>;
```

Returns `string[]` — the SDK wraps the return value into the `CompletionResult` envelope (`values`, `total`, `hasMore`).

### Internals (relocated from `completions.ts`)

Moved verbatim, with minor adjustments:

- All path-resolution helpers: `getPathCompletions`, `findMatchesInDirectory`, `resolveContextBaseDirectory`, named-root parsing (`parseNamedRootInput`, `findAllowedRootByName`, `resolveNamedRootPath`, `resolveNamedRootContext`), `isAllowedCompletionDirectory`, `getSearchContext`, `findRootPrefixMatches`, `findMatchingRoots`, etc.
- `WeakMap<McpServer, CompletionState>` cache + `COMPLETION_RATE_LIMIT_MS = 100` rate-limit + `MAX_COMPLETION_CACHE_KEYS = 128` cap.
- Cache-key derivation: `JSON.stringify({ argumentName, value, contextArguments })`. The `ref` field present in today's key drops out — per-prompt wiring already isolates by prompt name implicitly.
- Cap on results: `MAX_COMPLETION_ITEMS = 100` is enforced inside the helper before returning. The SDK's outer envelope still reports `total`/`hasMore` correctly when wrapped.

### What's deleted from today's `completions.ts`

- `setRequestHandler('completion/complete', ...)` block — SDK auto-dispatches.
- `handleTopicAndToolCompletions` (predefined ref→completer table) — replaced by per-prompt `completable()`.
- `buildEnumArgumentValues` / `getEnumCompletions` / `extractEnumValuesFromSchema` / `intersectEnumValueSets` — unreachable from any current prompt/resource.
- `parseResourceReference` / `extractTemplateVariables` / `isPathArgumentFromReference` / `serializeCompletionRef` — only relevant to the global ref-aware dispatch we're removing.

## `zod/v4` migration

Mechanical change: `import { z } from 'zod'` → `import { z } from 'zod/v4'`.

Files touched (verify via `grep -rln "from 'zod'" src/`):

- `src/lib/zod-codecs.ts`
- `src/pkg-info.ts`
- `src/prompts.ts`
- `src/lib/file-operations/search.ts`
- `src/schemas.ts`
- `src/server/roots-manager.ts`
- `src/tools/shared.ts`
- (any others surfaced by grep at implementation time)

`completions.ts` is being deleted, so its zod import doesn't need migration.

`package.json` already pins `zod ^4.4.3`; no dependency change needed.

## Tests

### Update [`__tests__/unit/completions.test.ts`](../../../__tests__/unit/completions.test.ts)

The two existing tests use `ref: { type: 'ref/prompt', name: 'get-help' }` with `argument: { name: 'path' }`. After the migration, `get-help` has no `path` arg, so this would return empty.

- Retarget the rate-limit test to `name: 'analyze-path'` with `argument: { name: 'path' }`.
- Retarget the context-collision test to `name: 'compare-files'` with `argument: { name: 'modified' }` and a context `arguments: { original: '...' }`.

Tests for predefined topic/tool-name completions remain valuable — keep them and retarget to the actual prompts/resources that own those completions (`get-help` for topics, `get-tool-help` and `internal://tool-info/{name}` for tool names).

### New contract test in [`__tests__/contract.test.ts`](../../../__tests__/contract.test.ts)

For each prompt and resource template in the public set:

- Assert that prompts with `path`, `original`, `modified`, `source`, `destination` args have `completable()` wrapped on those args.
- Assert that resource templates whose URI contains `{name}` declare a `complete.name` callback.

This catches regressions where someone adds a new prompt arg or template variable and forgets to wire completion. Failure mode caught: silent loss of completion UX.

### Tests that pass unchanged

- `prompts.test.ts`, `resources.test.ts`, `tool-registration.test.ts`, all tool tests, `roots-manager.test.ts`, `task-store.test.ts`, etc. — none depend on completion internals.

## Migration risks (call-outs for reviewers)

1. **Loose-dispatch quirk being removed.** Any client today that relies on undeclared arg-name dispatch (e.g. asking for `path` completion on `get-help`) will get empty results after this change. This is a visible behavior change but matches the protocol spec.
2. **Cross-tool enum scan removal.** If a future prompt adds an enum-named arg expecting it to auto-resolve from tool schemas, that won't work. Document in the new contract test that enum completions must be declared explicitly via `completable(z.enum([...]), v => ...)`.
3. **Two zod copies during migration.** A partial migration where some files use `zod` and others use `zod/v4` could surface type errors at boundaries. Land the zod migration as a single commit (or single PR) covering all files at once.
4. **`completable` context-arg passing — verify at implementation time.** The wiring for `compare-files` assumes `completable(schema, (value, ctx) => ...)` receives sibling argument values via `ctx.arguments`. This matches the MCP `completion/complete` request shape (which carries `params.context.arguments`), but the exact SDK signature for `completable` callbacks should be confirmed against `@modelcontextprotocol/server@2.0.0-alpha.2` types before implementing. If the SDK does not surface context to `completable` callbacks, fall back to context-less completions for `compare-files` and document the small UX regression (typing `modified` no longer suggests entries relative to `original`'s directory).

## Ordering and atomicity

Recommended commit/PR breakdown:

1. **Commit 1:** Add `src/lib/path-completer.ts` with the relocated logic. No call sites yet.
2. **Commit 2:** Wire `completable()` into `prompts.ts` and `ResourceTemplate.complete` into `resources.ts`. Both new and old completion paths exist; SDK uses the new ones, the custom handler is still installed but redundant.
3. **Commit 3:** Delete `src/completions.ts` and remove its import + `registerCompletions(...)` call from `bootstrap.ts`.
4. **Commit 4:** Migrate `zod` → `zod/v4` across all files in one shot.
5. **Commit 5:** Update tests (`completions.test.ts` retarget + new contract test).

This sequence keeps each commit independently buildable and testable. If something breaks, the bisect window is narrow.

## Verification checklist

- [ ] `node scripts/tasks.mjs` passes (format, lint, type-check, knip, test, rebuild).
- [ ] Manual `npm run inspector` smoke test: confirm completion suggestions appear for `analyze-path`'s `path` arg, `get-tool-help`'s `name` arg, and the `internal://tool-info/{name}` template.
- [ ] Grep confirms zero remaining `import { z } from 'zod'` (only `'zod/v4'`).
- [ ] Grep confirms zero remaining references to deleted `completions.ts` symbols.
- [ ] New contract test passes; deliberately remove a `completable()` wrapper and confirm the contract test fails.

## Out of scope (subprojects #2–#4)

- **#2 HTTP/transport hardening:** replace custom HTTP server in `bootstrap.ts` with `createMcpExpressApp()` from `@modelcontextprotocol/express`; add stateless JSON response mode endpoint.
- **#3 Protocol features:** elicitation prompts on destructive tools (`rm`, `write`, `edit`, `mv`, `apply_patch`); sampling-powered help/summarization; subscribable `metrics` and `roots` resources.
- **#4 Task-system audit:** re-evaluate `taskSupport: 'forbidden'` on long-runners (`find`, `grep`, `apply_patch`, `search-and-replace`, `read_many`, `tree`); decide whether to use the configured `InMemoryTaskMessageQueue`.
