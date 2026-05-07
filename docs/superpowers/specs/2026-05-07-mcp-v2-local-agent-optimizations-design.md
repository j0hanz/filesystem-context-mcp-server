# MCP v2 Local Agent Optimizations Design

## Purpose

Enhance the `@j0hanz/filesystem-mcp` server for local agentic workflows (e.g., Cursor, Claude Desktop, local agents) by providing deeper semantic context without bloating token windows, and adding proactive state synchronization to prevent stale reads and edit collisions.

## Core Features

### 1. Semantic & Structural Access (Tree-sitter AST)

Instead of returning full raw text, the server will leverage `web-tree-sitter` to parse code and extract only what the agent needs.

**Integration Points:**

- `mcp_filesystem_read`:
  - Add `symbol?: string` parameter to extract specific AST nodes (functions, classes).
  - Add `outlineOnly?: boolean` parameter to return a skeleton of imports/signatures without implementation bodies.
- `mcp_filesystem_search_content`:
  - Add `astQuery?: string` parameter to accept Tree-sitter S-expression queries, enabling 100% precise structural searches instead of fragile regex matching.

**Components:**

- `src/lib/ast-parser.ts`: A singleton that lazily loads `tree-sitter.wasm` and specific language grammars (TS, JS, Python) based on file extensions.

### 2. Proactive State Synchronization (Reactivity)

Prevent the agent from operating on an outdated mental model when files change out-of-band.

**Integration Points:**

- **Resource Subscriptions**:
  - Expose files as MCP Resources. Implement `resources/subscribe` handling.
  - Create `src/server/watch-manager.ts` (using `node:fs` watchers or `chokidar`).
  - Emit `notifications/resources/updated` to the MCP client when a watched file changes.
- **Hash-based Edit Locking (Optimistic Concurrency)**:
  - `mcp_filesystem_edit` (and `write`) tools will accept an optional `expectedHash?: string`.
  - If the current file SHA-256 does not match `expectedHash`, reject the edit with an `E_STALE_STATE` error to force the agent to re-read the file before making destructive changes.

## Trade-offs & Constraints

- **WASM Size:** Shipping `web-tree-sitter` and grammars adds bundle size. Lazy loading mitigates startup time impact.
- **File Watchers:** OS-level watchers can be resource-intensive on massive repos. Watcher will be strictly limited to the `RootsManager` allowed directories, and ideally scoped only to active subscriptions or recently read files.

## Testing Strategy

- **AST:** Unit tests mapping known TS symbols to expected start/end lines; testing outline generator against a complex class.
- **Reactivity:** Integration tests simulating external file writes (`fs.writeFile`) and asserting that the `resources/updated` notification fires, and that `expectedHash` edit locks correctly reject stale changes.
