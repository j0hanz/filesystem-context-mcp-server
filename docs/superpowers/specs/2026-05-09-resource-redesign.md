# Resource Layer Redesign

**Date:** 2026-05-09
**Status:** Approved — ready for implementation planning
**Scope:** Complete functional redesign of `src/resources.ts` and associated resource implementations, modernizing them to match the tool registry pattern.

---

## Problem Statement

The current resource implementation (`src/resources.ts`) manually registers individual resources with inline configuration. It lacks the modularity, strict typing, and centralized routing that the tool registry (`src/tools.ts`) enjoys. Furthermore, exposing local files as resources (`filesystem-mcp://file/{path}`) is partially implemented (only the subscription logic exists) and lacks critical usability features like path auto-completion and standardized `read` handlers.

---

## Design Goals

1. **Strict Contract Registry:** Implement a functional `ResourceContract` pattern mirroring `ToolContract`.
2. **Filesystem Resource:** Fully implement a `filesystem-mcp://file/{+path}` resource template that supports reading, `fs.watch` subscriptions, and path auto-completion.
3. **Centralized Routing:** Decouple MCP server registration from resource business logic.
4. **Maintainability:** Ensure easy teardown of watchers and clear separation of concerns.

---

## Architecture

### 1. Core Contract (`src/resources/contract.ts`)

A strict interface ensuring all resources define their configuration and lifecycle methods uniformly.

```typescript
import type {
  ReadResourceResult,
  ServerContext,
} from '@modelcontextprotocol/server';

export interface ResourceContract {
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;

  /** Fixed URI for static resources */
  uri?: string;
  /** Human-readable URI template string for dynamic resources */
  uriTemplate?: string;

  annotations?: {
    audience?: ('user' | 'assistant')[];
    priority?: number;
  };

  // Handlers
  read: (
    uri: URL,
    variables: Record<string, string>,
    ctx: ServerContext
  ) => Promise<ReadResourceResult> | ReadResourceResult;
  complete?: (variable: string, value: string) => Promise<string[]> | string[];

  // Subscription Lifecycle
  subscribe?: (uri: string, notify: (uri: string) => void) => void;
  unsubscribe?: (uri: string) => void;
}
// Note: Exactly one of `uri` or `uriTemplate` must be defined.
```

### 2. Filesystem Resource Implementation (`src/resources/filesystem.ts`)

Exposes the local filesystem to the LLM.

- **Template:** `filesystem-mcp://file/{+path}`
- **Read:** Validates path using `PathGuard`, determines content type using `file-content.ts` (binary vs. text), and returns `ReadResourceResult`.
- **Complete:** Uses `PathCompleter` to auto-complete directory and file names.
- **Subscribe:** Attaches a `node:fs.watch` listener to the requested file. On change, invokes the `notify(uri)` callback provided by the registry.

### 3. Registry & Router (`src/resources.ts`)

The central hub for all resources.

- Maintains the `ALL_RESOURCES` array (`filesystem`, `instructions`, `result`).
- Exports `registerAllResources(server, options)`, which loops through `ALL_RESOURCES` and calls `McpServer.registerResource` or `McpServer.registerResourceTemplate`.
- Intercepts raw JSON-RPC requests for `resources/subscribe` and `resources/unsubscribe` using `server.server.setRequestHandler`. It routes the requested URI to the matching contract's `subscribe`/`unsubscribe` methods.
- Provides a `destroy()` function to iterate over all active contracts and clear state (like closing all watchers).

---

## Edge Cases & Error Handling

- **Subscription Leaks:** The `destroy()` method returned by `registerAllResources` guarantees that when the MCP server shuts down, all `node:fs.watch` instances are closed via `contract.unsubscribe` or a general cleanup pass.
- **Path Guard Validation:** Reads and subscriptions to the filesystem resource must strict-check the path against the allowed workspace roots using `PathGuard`. Invalid paths will throw standard `ProtocolError`s or silently reject subscriptions depending on the MCP protocol's expected behavior.
- **Unsupported Variables:** Completion is only wired up for `{+path}`. Other variables will return an empty array.

---

## Future Extensibility

Because the routing is dynamic and schema-driven, adding new resources like `workspace://git-status` or `workspace://lint-errors` simply requires creating a new file conforming to `ResourceContract` and appending it to `ALL_RESOURCES`.
