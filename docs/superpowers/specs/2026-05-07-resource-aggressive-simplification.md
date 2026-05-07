# Resource Layer — Aggressive Simplification

**Date:** 2026-05-07
**Status:** Approved — ready for implementation planning
**Scope:** Reduce 7 resources to 2, remove subscription infrastructure, slim instructions content, remove `globalMetrics` / `onMetricsUpdate`, remove `get-tool-help` prompt. Breaking changes to internal types and test surface acceptable.

---

## Problem Statement

The current resource layer (introduced in commit `2414420`) added `ResourceContract`, `ResourceSubscriptionLifecycle`, a registry table, and a subscription-aggregating router — all modelled on the tool-contract pattern. That uniformity was a net improvement over the previous scattered approach, but the content it registers is substantially over-engineered:

- **5 of 7 resources are redundant.** `tool-catalog`, `workflows`, and `tool-info` duplicate content already embedded in `instructions`. `filesystem-file` duplicates the `read` tool with extra risk. `metrics` surfaces operational data mislabelled `audience: ['assistant']`.
- **The subscription infrastructure exists for 2 resources** — and one of those (metrics) implements `onSubscribe`/`onUnsubscribe` as empty no-ops.
- **`ResourceContract` and `ResourceSubscriptionLifecycle`** earn their keep at n=18 tools. At n=2 resources they add ceremony with no payoff.
- **`buildToolInfo()` is 300 LOC** of bespoke Zod-schema-to-markdown rendering that duplicates what `tools/list` already returns as standard JSON Schema.
- **`globalMetrics` / `onMetricsUpdate`** exist solely to feed the metrics resource. Removing the resource makes the listener mechanism a no-consumer abstraction.

---

## Design Goals

1. Retain only resources that justify the MCP resource primitive: result cache (externalized tool output) and slim instructions (session-start context).
2. Delete all content-builder modules whose output is now embedded elsewhere or no longer needed.
3. Slim `internal://instructions` to a navigation guide — role, tools overview table, constraints, error-recovery table. No per-tool reference, no workflow recipes, no tool-catalog sections.
4. Remove subscription capability declarations and all notification wiring since nothing will push updates.
5. Remove `globalMetrics`, `onMetricsUpdate`, and `metricsListeners` from observability — diagnostics still flow via `node:diagnostics_channel` for external subscribers.
6. Remove `get-tool-help` prompt — its data source (`buildToolInfo`) is deleted; `tools/list` serves discovery.
7. Simplify `createServer()` to return `{ server }` — no `ResourcesHandle` wrapping needed.

---

## Surviving Surface

### Resources (2)

| Resource     | URI                            | Type     | Description                                                               |
| ------------ | ------------------------------ | -------- | ------------------------------------------------------------------------- |
| Instructions | `internal://instructions`      | static   | Slim navigation: role, tools-overview table, constraints, error-recovery. |
| Result Cache | `filesystem-mcp://result/{id}` | template | Externalized large tool output. Hash-dedup, TTL, byte caps unchanged.     |

### Prompts (3 — down from 4)

| Prompt          | Status                                                         |
| --------------- | -------------------------------------------------------------- |
| `get-help`      | Keep — reads slim instructions, topic-filters by `##` heading. |
| `compare-files` | Keep — independent of resources.                               |
| `analyze-path`  | Keep — independent of resources.                               |
| `get-tool-help` | **Delete** — depends on removed `buildToolInfo()`.             |

### Capabilities

`resources` capability drops `subscribe: true` and `listChanged: true`. Neither notification fires. `debouncedNotificationMethods` array removed from server config.

---

## Architecture

### New file layout

```text
src/resources/
  instructions-content.ts   ← NEW: buildSlimInstructions() → ~80 lines markdown
  result.ts                 ← DELETED: handler inlined into resources.ts directly

src/resources.ts            ← REPLACED: ~30 LOC, two direct registerResource() calls

src/resources/contract.ts   ← DELETED
src/resources/shared.ts     ← DELETED
src/resources/filesystem-file.ts     ← DELETED
src/resources/metrics.ts             ← DELETED
src/resources/generated-instructions.ts  ← DELETED
src/resources/tool-catalog.ts        ← DELETED
src/resources/tool-catalog-resource.ts   ← DELETED
src/resources/workflows.ts           ← DELETED
src/resources/workflows-resource.ts  ← DELETED
src/resources/tool-info-resource.ts  ← DELETED
src/resources/tool-info.ts           ← SLIMMED: keep 5 nav helpers, delete ~250 LOC
src/resources/instructions.ts        ← DELETED (logic moved to resources.ts inline)
```

---

## Section 1: `src/resources/instructions-content.ts` (new)

Replaces the ~300-LOC `generated-instructions.ts`. Builds the slim markdown once at module load.

Content structure:

```markdown
## Role

Secure filesystem agent. Operate strictly within allowed roots.
Resolve paths before acting — never assume.

## Tools Overview

| Category | Tools                                                                     |
| -------- | ------------------------------------------------------------------------- |
| Navigate | `roots`, `ls`, `tree`, `find`                                             |
| Inspect  | `stat`, `stat_many`, `grep`, `calculate_hash`                             |
| Read     | `read`, `read_many`, `diff_files`                                         |
| Write    | `mkdir`, `write`, `edit`, `mv`, `rm`, `apply_patch`, `search_and_replace` |

Full schemas, descriptions, and annotations are in `tools/list`.

## Constraints

- Operate within allowed roots only (negotiated at startup via CLI).
- Sensitive file paths (.env, *.pem, *id_rsa\*) are denied by default.
- Enforced limits: max file size 10 MB, file search cap 500 results, content search cap 100 matches.
- When a tool returns `resourceUri`, call `resources/read` immediately —
  cached results expire on server restart.

## Error Recovery

| Error Code      | Action                                                            |
| --------------- | ----------------------------------------------------------------- |
| `ACCESS_DENIED` | Run `roots` to list allowed directories, retry with a valid path. |
| `NOT_FOUND`     | Run `ls` or `find` to verify the path.                            |
| `TOO_LARGE`     | Use head/tail, line ranges, or split across `read_many`.          |
| `TIMEOUT`       | Reduce scope, depth, or maxResults.                               |
| `INVALID_INPUT` | Re-read the tool schema in `tools/list`.                          |
```

Implementation:

```typescript
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';

import { formatToolNameList, pickAvailableToolNames } from './tool-info.js';

export function buildSlimInstructions(): string {
  // ... build the markdown table rows from available tool names, inline constraints
}

export const SLIM_INSTRUCTIONS_CONTENT = buildSlimInstructions();
```

Constants come from `../lib/constants.js` — same as today. Tool name lists come from `pickAvailableToolNames()` kept in slim `tool-info.ts`.

---

## Section 2: `src/resources/tool-info.ts` (slimmed)

Delete from this file:

- `interface ToolEntry`
- `interface JsonSchemaObject`
- `getTaskSupportLabel()`
- `toEntry()`
- `ENTRIES`
- `CONTRACTS_BY_NAME` — only consumers are deleted functions, delete it
- `getTaskCapableToolNames()`
- `buildCoreContextPack()`
- `getSharedConstraints()` — **move to `instructions-content.ts`** where it's the only consumer
- `formatTaskSupportLabel()`
- `toJsonSchemaObject()`
- `summarizeArrayType()`
- `summarizeSchemaType()`
- `formatFieldLabel()`
- `buildSchemaFieldLines()`
- `buildToolInfo()`

Keep in this file (used by slim instructions and completions):

- `getToolContracts()`
- `getSortedToolContracts()`
- `pickAvailableToolNames()`
- `formatToolNameList()`

---

## Section 3: `src/resources.ts` (replaced)

Drops: `ResourceEntry`, `ALL_RESOURCE_CONTRACTS`, `ALL_RESOURCES`, `RESOURCE_ENTRIES`, `ResourcesHandle`, lifecycle aggregator, subscribe/unsubscribe handlers.

```typescript
import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceTemplate,
} from '@modelcontextprotocol/server';

import type { ResourceStore } from './lib/resource-store.js';

import { SLIM_INSTRUCTIONS_CONTENT } from './resources/instructions-content.js';
import { type IconInfo, withDefaultIcons } from './tools/shared.js';

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
}

export { SLIM_INSTRUCTIONS_CONTENT as serverInstructionsContent };

const INSTRUCTIONS_URI = 'internal://instructions';
const RESULT_TEMPLATE = new ResourceTemplate('filesystem-mcp://result/{id}', {
  list: undefined,
});

export function registerAllResources(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  server.registerResource(
    'filesystem-mcp-instructions',
    INSTRUCTIONS_URI,
    withDefaultIcons(
      {
        title: 'Server Instructions',
        description:
          'Navigation guide for filesystem-mcp tools and constraints.',
        mimeType: 'text/markdown',
        annotations: { audience: ['assistant'], priority: 0.8 },
      },
      options.iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: SLIM_INSTRUCTIONS_CONTENT,
        },
      ],
    })
  );

  server.registerResource(
    'filesystem-mcp-result',
    RESULT_TEMPLATE,
    withDefaultIcons(
      {
        title: 'Cached Tool Result',
        description:
          'Ephemeral cached tool output. Not listed via resources/list.',
        mimeType: 'text/plain',
        annotations: { audience: ['assistant'], priority: 0.3 },
      },
      options.iconInfo
    ),
    (uri, variables): ReadResourceResult => {
      const { id } = variables;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          'Cached result expired. Re-run the tool to regenerate.'
        );
      }
      const entry = options.resourceStore.getText(uri.toString());
      return {
        contents: [
          { uri: entry.uri, mimeType: entry.mimeType, text: entry.text },
        ],
      };
    }
  );
}
```

No return value — nothing to destroy.

---

## Section 4: `src/server/bootstrap.ts` changes

**`createServer()` return type:** `Promise<{ server: McpServer }>` — remove `ResourcesHandle`.

**`buildServerCapabilities()`:** Drop `subscribe: true` and `listChanged: true` from `resources`:

```typescript
resources: {},  // was: { listChanged: true, subscribe: true }
```

**`serverConfig`:** Remove `debouncedNotificationMethods` array entirely.

**`registerAllResources()` call:** No longer needs to capture a `resourcesHandle`. Remove from both `createServer` and `startServer`.

**`startServer()` and `createHttpSession()`:** Drop `resourcesHandle.destroy()` cleanup calls. Simplify session cleanup accordingly.

**Import:** Remove `ResourcesHandle` type import. Keep `serverInstructionsContent` import from `resources.js`.

---

## Section 5: `src/lib/observability.ts` changes

Remove:

- `interface ToolMetrics`
- `export const globalMetrics`
- `type MetricsListener`
- `const metricsListeners`
- `export function onMetricsUpdate()`
- `function updateMetrics()`
- All calls to `updateMetrics()` inside `runAndObserve()` and `withToolDiagnostics()` fallback paths

Keep:

- All `node:diagnostics_channel` publishing (`CHANNELS.tool`, `CHANNELS.perf`, `CHANNELS.ops`)
- `withToolDiagnostics()` — still wraps tool execution for diagnostics
- `startPerfMeasure()`, `publishOpsTrace*()`, `getTraceContext()` — all unchanged

No changes to tool wiring — `withToolDiagnostics` is still called from every tool handler.

---

## Section 6: `src/prompts.ts` changes

Remove `registerGetToolHelpPrompt()` and everything it depends on:

- Import of `buildToolInfo` from `./resources/tool-info.js`
- `findKnownToolName()` helper
- The `GET_TOOL_HELP_PROMPT_*` constants
- The `registerGetToolHelpPrompt()` function

Keep `getSortedToolContracts()` import (still used by completions in this file).

Update `bootstrap.ts`: remove the `registerGetToolHelpPrompt(server, localIcon)` call.

---

## Section 7: Test changes

### Files to delete

- `__tests__/resources/contract.test.ts`
- `__tests__/resources/filesystem-file.test.ts`
- `__tests__/resources/metrics.test.ts`
- `__tests__/resources/` directory (empty after deletions)

### `__tests__/resources.test.ts` — update 4 tests

**`lists fixed resources and dynamic resource templates`:**

- Expect 1 static resource: `internal://instructions`
- Expect 1 template: `filesystem-mcp://result/{id}`
- Remove `staticResourceUris`, `toolInfoUris` variables

**`reads built-in resources and exposes instructions through initialize metadata`:**

- Keep: instructions resource check, `serverConfig.instructions` blurb check
- Remove: metrics resource read

**`reads tool-info template instances and get-tool-help embeds the same resource URI`:**

- Delete this test entirely

**`keeps README and server metadata in sync`:**

- Update assertion: 2 static resources (instructions + 0 listed templates)
- Update: 3 prompts
- Update README line matches (see Section 8)

### `__tests__/contract.test.ts`

- Remove or update any assertion on resource count (was 18 tools + resource counts)

### `__tests__/prompts.test.ts` and `__tests__/prompts-stdio.test.ts`

- Remove tests for `get-tool-help` prompt

### `__tests__/unit/completions.test.ts`

- Remove: completions for `internal://tool-info/{name}`, `get-tool-help` name argument

### `__tests__/http.test.ts`

- Remove: assertions referencing `internal://tool-info`, `filesystem-mcp://metrics`, `internal://workflows`, `internal://tool-catalog`

---

## Section 8: README.md changes

- Headline: `7 built-in resources` → `2 built-in resources`
- Headline: `4 built-in prompts` → `3 built-in prompts`
- Resources table: remove tool-catalog, workflows, tool-info, metrics, file rows; keep instructions + result cache
- Prompts table: remove `get-tool-help` row
- Capabilities table: `resources` evidence note: "2 resources registered, no subscribe/listChanged"
- Remove the `filesystem-mcp://file/{+path}` resource reference anywhere in the doc

---

## Estimated Impact

| Metric                                 | Before | After   |
| -------------------------------------- | ------ | ------- |
| Resources                              | 7      | 2       |
| Prompts                                | 4      | 3       |
| `src/resources/` files                 | 13     | 2       |
| `src/resources/*.ts` LOC               | ~1,126 | ~150    |
| `src/lib/observability.ts` LOC removed | —      | ~40     |
| `src/resources.ts` LOC                 | 124    | ~45     |
| `src/prompts.ts` LOC removed           | —      | ~75     |
| `__tests__/resources/` test files      | 3      | 0       |
| Net LOC removed                        | —      | ~1,200+ |

---

## Non-Goals

- Do not modify `src/lib/resource-store.ts` — the result cache implementation is correct and unchanged.
- Do not modify tool implementations — `maybeExternalizeTextContent`, `buildResourceLink`, `resource_link` content blocks all stay.
- Do not add any new resources. The simplification is the refinement.
- Do not change tool count, tool contracts, or tool behavior.
