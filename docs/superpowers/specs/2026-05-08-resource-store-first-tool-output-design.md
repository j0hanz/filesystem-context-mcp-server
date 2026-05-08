# Resource-Store-First Tool Output

**Date:** 2026-05-08
**Status:** Spec
**Scope:** All 18 tools in `src/tools/`, `src/lib/resource-store.ts`, `src/lib/mime.ts` (new), `src/tools/shared.ts`, `src/schemas/`, `src/resources.ts`, related tests.

## Problem

Tool responses currently inline file bodies as `type: 'text'` content blocks and duplicate the same body inside `structuredContent`. This produces three concrete failures:

1. **Display fidelity is poor.** Clients render every file as escaped plaintext. A `.png` read returns base64 noise; a `.ts` file has no syntax highlighting; a unified diff is rendered like prose.
2. **LLM token waste.** The body appears twice in the same response (once in `content[0].text`, once in `structuredContent.content`) and is always pushed into model context.
3. **Machine consumers parse text.** Downstream agents that want to chain calls re-parse the same body that the server already had in structured form.

The MCP v2 SDK supports five content block types (`text`, `image`, `audio`, `resource_link`, `resource`) and a `ResourceStore` already exists in this codebase (`filesystem-mcp://result/{id}`), so the protocol-native solution is available — it is not being used.

## Goals

- Every payload-producing tool returns a terse summary plus one or more `resource_link` blocks. Bodies live in the `ResourceStore`.
- `structuredContent` carries typed metadata only — never the body.
- Resource links carry accurate `mimeType` so clients render natively (syntax highlighting, image preview, diff viewer).
- Binary files (images, PDFs, blobs) flow through the same store via a new `putBlob` API.
- Test suite migrates via a single helper (`readResourceLink`) rather than per-test rewrites.

## Non-goals

- No version bump in `package.json`. Behavior changes ship without a release marker change.
- No new npm runtime dependency. Mime detection is in-tree.
- No backwards-compatibility layer for clients that read `result.content[0].text` for the body. The summary text block is the contract for those clients; bodies require `resources/read`.
- No SSE / streaming changes; this is purely about response shape.

## Architecture

### Three response patterns

Tools fall into one of three patterns based on what they produce.

**P1 — Payload tools.** Produce content the client may want to read.

| Tool             | Summary line                                           | Resource link(s)                       | `structuredContent`                                                                            |
| ---------------- | ------------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `read`           | `read: <path> · <lines> lines · <size> · <mime>`       | one link, body text/blob               | `{ path, totalLines, linesRead, size, mimeType, sha256?, encoding, isBinary, uri, expiresAt }` |
| `read-multiple`  | `read-multiple: N files · M failed · <total size>`     | one link per successful read           | `{ results: [{ path, ok, mimeType?, size?, uri?, error? }], summary }`                         |
| `list-directory` | `list-directory: <path> · N entries (D dirs, F files)` | one link, JSON listing                 | `{ path, total, dirs, files, uri, expiresAt }`                                                 |
| `tree`           | `tree: <path> · N nodes · depth D`                     | one link, JSON tree                    | `{ root, nodes, maxDepth, truncated, uri, expiresAt }`                                         |
| `search-files`   | `search-files: N matches for <pattern>`                | one link, JSON match list              | `{ pattern, matches, truncated, uri, expiresAt }`                                              |
| `search-content` | `search-content: N hits in M files`                    | one link, JSON hits with line context  | `{ pattern, hits, files, truncated, uri, expiresAt }`                                          |
| `diff-files`     | `diff: <a> ↔ <b> · ±N lines`                           | one link, unified diff (`text/x-diff`) | `{ a, b, additions, deletions, identical, uri, expiresAt }`                                    |
| `calculate-hash` | `hash: <path> · <algo>:<short>`                        | (no link — hash is the value)          | `{ path, algorithm, hash, size }`                                                              |
| `stat-many`      | `stat-many: N paths`                                   | one link, JSON stat array              | `{ count, errors, uri, expiresAt }`                                                            |

**P2 — Pure metadata.** No link; one terse text summary plus `structuredContent`.

| Tool    | Summary                          | `structuredContent`                |
| ------- | -------------------------------- | ---------------------------------- |
| `stat`  | `stat: <path> · <type> · <size>` | `{ path, type, size, mtime, ... }` |
| `roots` | `roots: N allowed`               | `{ roots: [...] }`                 |

**P3 — Action confirmations (writes).** Summary + post-state link so agents can verify without a follow-up `read`.

| Tool               | Summary                             | Link                         | `structuredContent`                                  |
| ------------------ | ----------------------------------- | ---------------------------- | ---------------------------------------------------- |
| `write-file`       | `write: <path> · <bytes> · <mime>`  | link to written content      | `{ path, size, mimeType, sha256, created, uri }`     |
| `edit-file`        | `edit: <path> · ±N lines`           | link to unified diff         | `{ path, edits, additions, deletions, sha256, uri }` |
| `apply-patch`      | `patch: N files · ±N lines`         | link to applied diff         | `{ files, additions, deletions, uri }`               |
| `replace-in-files` | `replace: N files · M replacements` | link to per-file diff bundle | `{ files, replacements, uri }`                       |
| `move-file`        | `move: <from> → <to>`               | —                            | `{ from, to }`                                       |
| `delete-file`      | `delete: <path>`                    | —                            | `{ path, deleted: true }`                            |
| `create-directory` | `mkdir: <path>`                     | —                            | `{ path, created }`                                  |

### Uniform `resource_link` block

Every link block follows this shape:

```ts
{
  type: 'resource_link',
  uri: 'filesystem-mcp://result/<id>',
  name: 'src/index.ts',          // original path or descriptive name
  title: 'Read: src/index.ts',   // optional human label
  mimeType: 'text/x-typescript',
  size: 4231,
  annotations: { audience: ['user'], priority: 0.7 },
  _meta: { expiresAt: '2026-05-08T12:34:56Z' }
}
```

`annotations.audience` is `['user']` for binary, image, and large text payloads (keeps them out of LLM context until requested). For small text payloads where a model may benefit from skimming the body, it is `['user', 'assistant']`. Implementation default is `['user']` — opt in to assistant audience per tool.

### TTL and storage caps

- **Single uniform TTL of 60 seconds.** TTL is an anti-leak / memory-cap mechanism, not a cache. It exists to cover the seconds between tool return and the client deciding to fetch.
- No per-tool TTL table. No per-call `ttlMs` override.
- Existing `ResourceStore` caps remain: `maxEntries: 64`, `maxTotalBytes: 25 MiB`, `maxEntryBytes: 10 MiB`. LRU evicts before TTL when the agent is busy.

### Mime detection (`src/lib/mime.ts`)

Single helper:

```ts
export type MimeKind = 'text' | 'binary' | 'image' | 'audio' | 'pdf';
export function detectMimeType(
  path: string,
  sample?: Buffer
): { mimeType: string; kind: MimeKind };
```

Resolution order:

1. Extension map (~80 common extensions: `.ts → text/x-typescript`, `.md → text/markdown`, `.json → application/json`, `.png → image/png`, `.jpg/.jpeg → image/jpeg`, `.pdf → application/pdf`, `.wav → audio/wav`, etc.).
2. Magic-byte sniff for binaries (PNG, JPEG, GIF, WEBP, PDF, ZIP) when extension is missing or generic.
3. Fallback: `application/octet-stream` if the sample is binary, `text/plain` otherwise.

`kind` drives whether the tool calls `putText` vs `putBlob` and whether the resource_link defaults to `audience: ['user']` only.

### `ResourceStore` extensions (`src/lib/resource-store.ts`)

Add binary support without breaking text APIs:

```ts
interface BlobResourceEntry {
  uri: string;
  name: string;
  mimeType: string;
  data: Buffer;
  hash: string; // sha256 of bytes
  size: number;
  storedAt: string;
  expiresAt: string;
}

interface ResourceStore {
  putText(params: {
    name: string;
    mimeType?: string;
    text: string;
  }): TextResourceEntry;
  putBlob(params: {
    name: string;
    mimeType: string;
    data: Buffer;
  }): BlobResourceEntry;
  getText(uri: string): TextResourceEntry;
  getBlob(uri: string): BlobResourceEntry;
  // existing: clear(), keys()
}
```

- Internal storage keeps a `kind: 'text' | 'blob'` discriminator per entry.
- Dedup hash index extends to blobs (sha256 over bytes) so identical reads share a URI.
- `getText` on a blob URI throws; `getBlob` on a text URI throws. Both with `ErrorCode.RESOURCE_NOT_FOUND`.
- `entryTtlMs` default changes from `30 * 60 * 1000` to `60 * 1000`.
- URI namespace stays `filesystem-mcp://result/{id}` — single namespace for both kinds.

### `src/tools/shared.ts` changes

- New helper:

  ```ts
  export function buildResourceResponse<T>(params: {
    summary: string;
    resources: ContentBlock[]; // resource_link blocks
    structured: T;
  }): { content: ContentBlock[]; structuredContent: T };
  ```

  Returns `{ content: [{ type: 'text', text: summary }, ...resources], structuredContent }`.

- New helper:

  ```ts
  export function putResource(params: {
    store: ResourceStore;
    name: string;
    mimeType: string;
    kind: MimeKind;
    content: string | Buffer;
  }): { entry: TextResourceEntry | BlobResourceEntry; link: ContentBlock };
  ```

  Picks `putText` or `putBlob` based on `kind`, returns the entry plus a ready-to-use `resource_link` block (with `annotations.audience` defaulted by `kind`).

- `buildToolResponse` is retained for P2 metadata-only tools.
- `maybeExternalizeTextContent` is removed (always externalize now — no threshold).
- `buildResourceLink` becomes a thin wrapper over the link-shaping logic in `putResource` and is kept for P3 tools that build their own diff/echo links.

### Schemas (`src/schemas/shared.ts` / `fields.ts`)

New shared schema:

```ts
export const ResourceLinkRef = z.strictObject({
  uri: z.string().url().describe('Resource URI; fetch via resources/read'),
  mimeType: z.string().describe('MIME type of the linked resource'),
  size: NonNegInt.describe('Resource size in bytes'),
  expiresAt: z
    .string()
    .datetime()
    .describe('ISO timestamp; resource may be evicted earlier'),
});
```

Tool output schemas drop body fields and reference `ResourceLinkRef` via the `uri` / `expiresAt` fields shown in the P1/P3 tables above.

### MCP resources entry (`src/resources.ts`)

The existing `filesystem-mcp://result/{id}` template handler routes by stored kind:

- `kind === 'text'` → returns `TextResourceContents` (`{ uri, mimeType, text }`).
- `kind === 'blob'` → returns `BlobResourceContents` (`{ uri, mimeType, blob: base64 }`).

## Migration

### Sequence

1. Land `src/lib/mime.ts` with unit tests covering extension map + magic-byte sniff.
2. Extend `ResourceStore` with blob support; lower default TTL to 60 s; unit tests for `putBlob`, `getBlob`, dedup, kind-mismatch errors.
3. Refactor `src/tools/shared.ts`: add `buildResourceResponse` and `putResource`, remove `maybeExternalizeTextContent`.
4. Add `ResourceLinkRef` to `src/schemas/shared.ts`. Update tool schemas one tool at a time, regenerating snapshots after each.
5. Refactor tool handlers in this order: `read` → `read-multiple` → `list-directory` → `tree` → `search-files` → `search-content` → `diff-files` → `calculate-hash` → `stat-many` → `stat` → `write-file` → `edit-file` → `apply-patch` → `replace-in-files` → `move-file` → `delete-file` → `create-directory` → `roots`.
6. Add `readResourceLink(client, result)` helper to `__tests__/helpers.ts` and migrate tool tests to use it.
7. Regenerate `__tests__/contract.test.ts` and `__tests__/schemas/snapshot.test.ts` snapshots.
8. Update `.github/tool-call.md` example to the new shape.

### Test helper

```ts
// __tests__/helpers.ts
export async function readResourceLink(
  client: Client,
  result: CallToolResult
): Promise<{ text?: string; blob?: Buffer; mimeType: string; uri: string }>;
```

Walks `result.content` for the first `resource_link`, calls `resources/read`, decodes `text` or `blob` (base64 → Buffer).

### Risks

- **HTTP transport session isolation.** `ResourceStore` is already per-session via `AsyncLocalStorage`. Verify no global leak introduced by `putBlob`. Mitigation: blob storage uses the same per-session map; covered by an HTTP integration test.
- **MCP Inspector behavior.** Inspector renders `resource_link` blocks as clickable links and follows them on demand. Worst case a tester sees only the summary; that is the intended UX.
- **Stdio clients without resource support.** Such clients will see the summary text block and miss the body. This is the documented contract; the summary line is intentionally machine-parseable.
- **Test churn.** ~30+ test files reference `result.content[0].text` for body assertions. The `readResourceLink` helper bounds the change to one-line replacements per assertion.

## Open questions

None outstanding from brainstorming.
