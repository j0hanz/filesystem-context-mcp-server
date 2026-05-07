# Resource Layer Redesign

**Date:** 2026-05-07
**Status:** Approved — ready for implementation planning
**Scope:** Full replacement of `src/resources.ts` and related registration code. No legacy code, no fallbacks. Breaking changes acceptable.

---

## Problem Statement

The current resource layer has six resources registered via standalone functions with metadata scattered inline. Unlike tools (which have `ToolContract` + `TOOL_ENTRIES`), resources have no contract type, no registry table, and no uniform pattern. Specific gaps:

- No `ResourceContract` — name, URI, title, description, mimeType, priority, and audience are repeated inline in each `register*` function
- No registry table — `bootstrap.ts` calls six individual register functions; adding a resource requires edits in two files
- `subscribe: true` and `listChanged: true` are declared in capabilities but only `metrics` uses subscriptions, wired manually in `bootstrap.ts` via a `WeakMap`
- Static content builders (`buildToolCatalog()`, `buildWorkflowGuide()`) are called on every `resources/read` — no memoization
- The resource table in `generated-instructions.ts` is hardcoded strings, not derived from contracts
- No filesystem-backed resources — the most natural use of the MCP resource primitive for a filesystem server is absent

---

## Design Goals

1. Mirror the `ToolContract` / `TOOL_ENTRIES` / `registerAllTools` pattern for resources
2. Add `filesystem-mcp://file/{+path}` — a PathGuard-enforced file resource with active `fs.watch` subscriptions
3. Uniform subscription lifecycle — each resource declares its own `createSubscription` factory; the registry aggregates them into a single router
4. Static content built once at registration, not on every read
5. Auto-derive the resource table in `generated-instructions.ts` from `ALL_RESOURCES`
6. All metrics subscription wiring moves out of `bootstrap.ts` into `metrics.ts`

---

## Architecture

### New file layout

```text
src/resources/
  contract.ts                  ← NEW: ResourceContract, ResourceSubscriptionLifecycle
  shared.ts                    ← NEW: ResourceRegistrationOptions, resourceMetadata()
  filesystem-file.ts           ← NEW: FILESYSTEM_FILE_RESOURCE + register fn
  instructions.ts              ← NEW: INSTRUCTIONS_RESOURCE + register fn
  tool-catalog-resource.ts     ← NEW: TOOL_CATALOG_RESOURCE + register fn
  workflows-resource.ts        ← NEW: WORKFLOW_GUIDE_RESOURCE + register fn
  tool-info-resource.ts        ← NEW: TOOL_INFO_RESOURCE + register fn
  result.ts                    ← NEW: RESULT_RESOURCE + register fn
  metrics.ts                   ← NEW: METRICS_RESOURCE + register fn (owns debounce)
  tool-catalog.ts              ← UNCHANGED: content builder
  generated-instructions.ts    ← MODIFIED: auto-derives resource table from ALL_RESOURCES
  workflows.ts                 ← UNCHANGED: content builder
  tool-info.ts                 ← UNCHANGED: content builder + helpers

src/resources.ts               ← REPLACED: becomes registry table (like tools.ts)
```

---

## Section 1: Core Types

### `src/resources/contract.ts`

```typescript
export interface ResourceSubscriptionLifecycle {
  onSubscribe(uri: string): void;
  onUnsubscribe(uri: string): void;
  destroy(): void;
}

export interface ResourceContract {
  name: string;
  title: string;
  description: string;
  mimeType: string;
  /** Fixed URI for static resources (e.g. 'internal://instructions'). */
  uri?: string;
  /** Human-readable URI template string for template-based resources (e.g. 'filesystem-mcp://file/{+path}'). */
  uriTemplate?: string;
  annotations: {
    audience: ('user' | 'assistant')[];
    priority: number;
  };
  createSubscription?: (
    notify: (uri: string) => void
  ) => ResourceSubscriptionLifecycle;
}
// Exactly one of `uri` or `uriTemplate` must be set on each contract.
```

- `createSubscription` is absent on static resources (instructions, catalog, workflows, tool-info, result)
- `uriTemplate` is populated on template-based resources for use in doc generation

### `src/resources/shared.ts`

```typescript
import type { PathGuard } from '../lib/path-guard.js';
import type { ResourceStore } from '../lib/resource-store.js';

import type { IconInfo } from '../tools/shared.js';

export interface ResourceRegistrationOptions {
  pathGuard: PathGuard;
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
}

export function resourceMetadata(contract: ResourceContract): {
  title: string;
  description: string;
  mimeType: string;
  annotations: { audience: ('user' | 'assistant')[]; priority: number };
} {
  return {
    title: contract.title,
    description: contract.description,
    mimeType: contract.mimeType,
    annotations: contract.annotations,
  };
}
```

---

## Section 2: Registry — `src/resources.ts`

Becomes a registry table mirroring `src/tools.ts` exactly.

```typescript
interface ResourceEntry {
  contract: ResourceContract;
  register: (server: McpServer, options: ResourceRegistrationOptions) => void;
}

const RESOURCE_ENTRIES: ResourceEntry[] = [
  { contract: INSTRUCTIONS_RESOURCE, register: registerInstructionResource },
  { contract: TOOL_CATALOG_RESOURCE, register: registerToolCatalogResource },
  {
    contract: WORKFLOW_GUIDE_RESOURCE,
    register: registerWorkflowGuideResource,
  },
  { contract: TOOL_INFO_RESOURCE, register: registerToolInfoResource },
  { contract: RESULT_RESOURCE, register: registerResultResource },
  { contract: METRICS_RESOURCE, register: registerMetricsResource },
  {
    contract: FILESYSTEM_FILE_RESOURCE,
    register: registerFilesystemFileResource,
  },
];

export const ALL_RESOURCES: ResourceContract[] = RESOURCE_ENTRIES.map(
  (e) => e.contract
);
```

### `registerAllResources`

```typescript
export interface ResourcesHandle {
  destroy(): void;
}

export function registerAllResources(
  server: McpServer,
  options: ResourceRegistrationOptions
): ResourcesHandle {
  const notify = (uri: string): void => {
    void server.server.sendResourceUpdated({ uri }).catch(() => {});
  };

  const lifecycles = RESOURCE_ENTRIES.flatMap(({ contract, register }) => {
    register(server, options);
    return contract.createSubscription
      ? [contract.createSubscription(notify)]
      : [];
  });

  server.server.setRequestHandler('resources/subscribe', async (req) => {
    for (const lc of lifecycles) lc.onSubscribe(req.params.uri);
    return {};
  });

  server.server.setRequestHandler('resources/unsubscribe', async (req) => {
    for (const lc of lifecycles) lc.onUnsubscribe(req.params.uri);
    return {};
  });

  return {
    destroy: () => {
      for (const lc of lifecycles) lc.destroy();
    },
  };
}
```

### Impact on `bootstrap.ts`

**Removed:**

- Six individual `register*Resource(server, ...)` calls
- `metricsUnsubscribers` WeakMap
- `cleanupServerMetrics` function
- `onMetricsUpdate` + `setTimeout` debounce block
- `METRICS_RESOURCE_URI` import

**Replaced with:**

```typescript
const resourcesHandle = registerAllResources(server, {
  pathGuard: rootsManager.pathGuard,
  resourceStore,
  iconInfo: localIcon,
});

// in transport.onclose / session cleanup:
resourcesHandle.destroy();
```

---

## Section 3: Filesystem File Resource

### `src/resources/filesystem-file.ts`

**URI template:** `filesystem-mcp://file/{+path}`

The `{+path}` reserved expansion (RFC 6570) allows `/` characters in the path without double-encoding. A client reads `/home/user/config.ts` via `filesystem-mcp://file//home/user/config.ts`.

**Contract:**

```typescript
export const FILESYSTEM_FILE_RESOURCE_URI_TEMPLATE =
  'filesystem-mcp://file/{+path}';

export const FILESYSTEM_FILE_RESOURCE: ResourceContract = {
  name: 'filesystem-mcp-file',
  title: 'File',
  description:
    'Read any file within allowed roots as a resource. ' +
    'Subscribe to receive notifications/resources/updated when the file changes on disk.',
  mimeType: 'text/plain',
  uriTemplate: FILESYSTEM_FILE_RESOURCE_URI_TEMPLATE,
  annotations: { audience: ['assistant'], priority: 0.4 },
  createSubscription: (notify) => createFileSubscription(notify),
};
```

**Registration:**

```typescript
const FILE_TEMPLATE = new ResourceTemplate(
  FILESYSTEM_FILE_RESOURCE_URI_TEMPLATE,
  {
    list: undefined,
  }
);

export function registerFilesystemFileResource(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  server.registerResource(
    FILESYSTEM_FILE_RESOURCE.name,
    FILE_TEMPLATE,
    withDefaultIcons(
      { ...resourceMetadata(FILESYSTEM_FILE_RESOURCE) },
      options.iconInfo
    ),
    async (uri, variables): Promise<ReadResourceResult> => {
      const rawPath = variables['path'];
      if (typeof rawPath !== 'string' || rawPath.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'path is required'
        );
      }
      const safePath = await options.pathGuard.assertWithinAllowedDirectories(
        decodeURIComponent(rawPath)
      );
      const content = await readFile(safePath, 'utf-8');
      return {
        contents: [
          { uri: uri.href, mimeType: guessMimeType(safePath), text: content },
        ],
      };
    }
  );
}
```

**Subscription lifecycle:**

```typescript
function createFileSubscription(
  notify: (uri: string) => void
): ResourceSubscriptionLifecycle {
  const watchers = new Map<string, FSWatcher>();

  function onSubscribe(uri: string): void {
    if (watchers.has(uri) || !uri.startsWith('filesystem-mcp://file/')) return;
    const decoded = decodeURIComponent(
      uri.slice('filesystem-mcp://file/'.length)
    );
    try {
      const watcher = watch(decoded, { persistent: false }, () => notify(uri));
      watcher.once('error', () => {
        watcher.close();
        watchers.delete(uri);
      });
      watchers.set(uri, watcher);
    } catch {
      // Not watchable — silent. Client gets ResourceNotFound on next read.
    }
  }

  function onUnsubscribe(uri: string): void {
    watchers.get(uri)?.close();
    watchers.delete(uri);
  }

  function destroy(): void {
    for (const watcher of watchers.values()) watcher.close();
    watchers.clear();
  }

  return { onSubscribe, onUnsubscribe, destroy };
}
```

**`guessMimeType`:**

```typescript
function guessMimeType(path: string): string {
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.html') || path.endsWith('.htm')) return 'text/html';
  if (path.endsWith('.ts') || path.endsWith('.js')) return 'text/javascript';
  return 'text/plain';
}
```

**Security invariants:**

- PathGuard runs on every `resources/read` — same boundary as all tools (allowed roots + sensitive-file denylist)
- Watcher setup does not validate the path — a missing or inaccessible path simply fails `fs.watch` silently; the security boundary is at read time via PathGuard
- `list: undefined` — no enumeration of filesystem contents via this resource
- `persistent: false` — watcher does not prevent Node.js process exit

---

## Section 4: Static Resource Upgrades

### Content memoization

Static builders are called once at registration time:

```typescript
// src/resources/tool-catalog-resource.ts
export function registerToolCatalogResource(server, options): void {
  const content = buildToolCatalog(); // once

  server.registerResource(
    TOOL_CATALOG_RESOURCE.name,
    TOOL_CATALOG_RESOURCE_URI,
    withDefaultIcons(
      { ...resourceMetadata(TOOL_CATALOG_RESOURCE) },
      options.iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: content }],
    })
  );
}
```

Same pattern applies to `instructions.ts` and `workflows-resource.ts`.

`tool-info-resource.ts` remains lazy (content is per-name, built on demand from `buildToolInfo(name)`).
`metrics.ts` remains lazy (reads live `globalMetrics` state on every read).
`result.ts` remains lazy (reads live `ResourceStore` state on every read).

### Auto-derived resource table in `generated-instructions.ts`

Replaces the hardcoded URI table in `buildInstructionsHeader()`:

```typescript
import { ALL_RESOURCES } from '../resources.js';

function buildResourceTable(): string {
  const header = '| URI | Purpose |\n| --- | ------- |';
  const rows = ALL_RESOURCES.map((r) => {
    const uri = r.uriTemplate ?? r.uri ?? r.name;
    return `| \`${uri}\` | ${r.description} |`;
  });
  return `${header}\n${rows.join('\n')}`;
}
```

`ALL_RESOURCES` is imported from `src/resources.ts`. Adding a new resource to `RESOURCE_ENTRIES` automatically includes it in the generated instructions — no separate edit to `generated-instructions.ts` required.

### Metrics resource owns its debounce — `src/resources/metrics.ts`

```typescript
export const METRICS_RESOURCE: ResourceContract = {
  name: 'filesystem-mcp-metrics',
  title: 'Tool Metrics',
  description: 'Live per-tool call/error/avgDurationMs metrics snapshot.',
  mimeType: 'application/json',
  annotations: { audience: ['assistant'], priority: 0.5 },
  createSubscription: (notify) => {
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = onMetricsUpdate(() => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => notify(METRICS_RESOURCE_URI), 500);
    });
    return {
      onSubscribe: () => {},
      onUnsubscribe: () => {},
      destroy: () => {
        clearTimeout(debounceTimer);
        unsubscribe();
      },
    };
  },
};
```

`METRICS_RESOURCE_URI` is a module-private constant in `metrics.ts`. The export from the old `resources.ts` is deleted.

---

## Constraints and invariants preserved

- PathGuard enforcement on every file resource read — never bypassed
- Sensitive-file denylist (`.env*`, SSH keys, `.git`) enforced by PathGuard at read time
- `list: undefined` on both `result/{id}` and `file/{+path}` — no filesystem enumeration
- `persistent: false` on fs.watch — no event loop retention
- `subscribe: true` + `listChanged: true` capabilities unchanged in `buildServerCapabilities()`
- HTTP sessions: `resourcesHandle.destroy()` on session close tears down all file watchers for that session
- stdio: `resourcesHandle.destroy()` called on transport close

---

## Files deleted / fully replaced

- `src/resources.ts` — replaced (registry table, no standalone register functions)

## Files modified

- `src/server/bootstrap.ts` — uses `registerAllResources`; removes metrics wiring, WeakMap, and six individual register calls
- `src/resources/generated-instructions.ts` — `buildInstructionsHeader()` uses `buildResourceTable()` derived from `ALL_RESOURCES`

## Files added

- `src/resources/contract.ts`
- `src/resources/shared.ts`
- `src/resources/filesystem-file.ts`
- `src/resources/instructions.ts`
- `src/resources/tool-catalog-resource.ts`
- `src/resources/workflows-resource.ts`
- `src/resources/tool-info-resource.ts`
- `src/resources/result.ts`
- `src/resources/metrics.ts`

## Files unchanged

- `src/resources/tool-catalog.ts`
- `src/resources/tool-info.ts`
- `src/resources/workflows.ts`
- `src/lib/resource-store.ts`
- `src/lib/observability.ts`

---

## Test coverage required

- `__tests__/resources/contract.test.ts` — all resources registered with correct metadata; analogous to `contract.test.ts` for tools
- `__tests__/resources/filesystem-file.test.ts` — read returns file content; PathGuard rejects paths outside roots; PathGuard rejects sensitive files; watcher fires `notify` on file change; `destroy()` closes all watchers
- `__tests__/resources/metrics.test.ts` — debounce fires `notify` after tool calls; `destroy()` clears timer and unsubscribes
- Existing integration tests must continue to pass unchanged
