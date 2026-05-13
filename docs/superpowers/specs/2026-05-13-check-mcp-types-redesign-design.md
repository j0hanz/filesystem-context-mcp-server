# check-mcp-types.mjs Redesign

**Date:** 2026-05-13
**Status:** Approved
**Scope:** `scripts/check-mcp-types.mjs` only

---

## Problem

The script has three pain points:

1. **Stale catalog drift** — the static `TYPE_GROUPS` / `RUNTIME_GROUPS` maps are manually maintained. After an SDK upgrade, new symbols land in "Uncategorized" and removed symbols silently stay in the catalog with a permanent zero hit-count.
2. **Noise in "unused"** — 298/381 symbols are reported as unused. A large fraction are `@mcp/client` OAuth/middleware/core exports that a server project structurally never uses. They inflate the unused count and bury the symbols that actually matter.
3. **No test/prod signal** — "used" means any hit in any file. There is no way to tell whether a type is used in production source (`src/`) or only in the test suite (`__tests__/`).

---

## Goals

- Preserve the human-curated symbol groupings (do not generate catalog from SDK).
- Auto-validate the catalog against the installed SDK on every run.
- Filter client-only symbols from the default "unused" view.
- Split "used" into "prod" and "test-only" buckets.
- No breaking changes to existing `--json` consumers (additive fields only).

---

## Approach: Unified catalog object (Approach 2)

Replace the two separate `TYPE_GROUPS` / `RUNTIME_GROUPS` maps with a single `CATALOG` array. Add a `relevance` field per entry. Track `srcHits` and `testHits` separately during scanning. Add a catalog health section comparing `CATALOG` against live SDK exports.

---

## Section 1 — Catalog data structure

### Catalog before

```js
const TYPE_GROUPS    = { "Tools": ["Tool", "CallToolResult", ...], ... };
const RUNTIME_GROUPS = { "@mcp/server: core classes": ["McpServer", ...], ... };
```

### Catalog after

```js
const CATALOG = [
  { name: 'McpServer', group: '@mcp/server: core classes', kind: 'runtime', relevance: 'server' },
  { name: 'CallToolResult', group: 'Tools', kind: 'type', relevance: 'shared' },
  {
    name: 'discoverOAuthMetadata',
    group: '@mcp/client: oauth',
    kind: 'runtime',
    relevance: 'client',
  },
  // ... all ~381 entries
];
```

### Relevance values

| Value      | Meaning                                | Which groups                                                                                                                                            |
| ---------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `"server"` | Only a server implementation uses this | All `@mcp/server:*` runtime groups, `@mcp/node`, `@mcp/express`                                                                                         |
| `"client"` | Only a client implementation uses this | All `@mcp/client:*` groups (core, oauth, middleware)                                                                                                    |
| `"shared"` | Both sides need this (protocol types)  | All type groups (JSON, JSON-RPC, Tools, Prompts, Resources, Elicitation, Sampling, Roots, Tasks, Logging, etc.), plus `@mcp/server: protocol constants` |

### Migration

The existing `TYPE_GROUPS` entries all become `kind: "type", relevance: "shared"` (protocol types used by both sides). The `RUNTIME_GROUPS` entries get `kind: "runtime"` and a `relevance` assigned per-group as above.

`buildSymbolCatalog()` simplifies to iterating `CATALOG` directly instead of transforming two maps. `loadDynamicExports()` is retained for the health-check phase.

---

## Section 2 — Scanning & test/prod split

### Scanning before

Single hit map. `scanFile(filePath, scanner, hits)` writes all occurrences into `hits`.

### Scanning after

Two hit maps, one per scan target:

```js
const srcHits = new Map(); // files under src/
const testHits = new Map(); // files under __tests__/ and scripts/
```

`scanFile` gains a `target: "src" | "test"` parameter derived from the file path before the call. The destination map is selected by `target`; the internal scan logic is unchanged.

### Symbol classification at report time

| `srcHits` | `testHits` | Classification                           |
| --------- | ---------- | ---------------------------------------- |
| > 0       | any        | `"prod"` — used in production code       |
| 0         | > 0        | `"test-only"` — referenced only in tests |
| 0         | 0          | `"unused"`                               |

### JSON schema additions (backward-compatible)

Each entry gains:

- `srcCount: number` — hit count across `src/` files
- `testCount: number` — hit count across `__tests__/` and `scripts/` files
- `relevance: "server" | "client" | "shared"`
- `totalCount` retained as `srcCount + testCount`

---

## Section 3 — Catalog health validation

`loadDynamicExports()` reads every installed `@modelcontextprotocol/*` package's `.d.mts` and returns the live SDK export surface. After scanning, `buildReport()` computes:

```js
const catalogNames = new Set(catalog.map((e) => e.name));
const liveNames = new Set(loadDynamicExports().keys());

const newSymbols = [...liveNames].filter((n) => !catalogNames.has(n));
const staleSymbols = catalog.filter((e) => !liveNames.has(e.name));
```

**`newSymbols`** — SDK exports not in `CATALOG`. These need to be added with correct group + relevance.
**`staleSymbols`** — `CATALOG` entries the SDK no longer exports. These should be removed.

The health result is included in all output formats (text, markdown, JSON). Exit code remains `0` in all cases — the script is a report tool, not a build gate.

### JSON schema addition

```json
"health": {
  "newSymbols":   [{ "name": "ExperimentalMcpServerTasks", "kind": "runtime" }],
  "staleSymbols": [{ "name": "CompatibilityCallToolResult", "group": "Tools", "kind": "type" }]
}
```

---

## Section 4 — Report output & CLI flags

### Summary block (text)

```text
Scanned files  : 97
Total symbols  : 381 (277 types, 104 runtime)  [83 server/shared, 298 client-only]
Used (prod)    : 41
Used (test-only): 42
Unused         : 83  (298 client-only hidden — use --all to show)
Catalog health : 2 new, 1 stale
```

### Output sections (in order)

1. **Used — prod** — symbols with `srcCount > 0`; filtered to `server`/`shared` by default. Sorted by `srcCount` desc. Each entry shows `srcCount` and `testCount` separately.
2. **Used — test-only** — symbols with `srcCount = 0, testCount > 0`; always shown for `server`/`shared` (notable: test imports that production code never uses). Hidden for `client` unless `--all`.
3. **Unused** — `server`/`shared` only by default; `client` appended with `--all`.
4. **Catalog health** — `[NEW]` / `[STALE]` entries, or `✓ Catalog is in sync with installed SDK`.

### CLI flags

| Flag                  | Existing | Change                                                        |
| --------------------- | -------- | ------------------------------------------------------------- |
| `--json`              | ✓        | Unchanged (additive fields only)                              |
| `--markdown` / `--md` | ✓        | Unchanged (new sections added)                                |
| `--out <file>`        | ✓        | Unchanged                                                     |
| `--all`               | ✗        | **New** — include `client`-relevance symbols in unused output |

No flags are removed or renamed.

---

## Non-goals

- Import-path precision (parsing actual `import { X }` statements) — regex word-boundary matching is retained.
- Integration into `tasks.mjs` as a build gate — the script stays standalone.
- Auto-generating the catalog from `.d.mts` — the static catalog is preserved.

---

## Files changed

| File                          | Change                     |
| ----------------------------- | -------------------------- |
| `scripts/check-mcp-types.mjs` | All changes contained here |

No other files are touched.
