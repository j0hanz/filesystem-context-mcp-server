# `list` Tool Redesign

**Date:** 2026-05-11
**Status:** Approved design, ready for implementation plan
**Scope:** Merge `ls` and `tree` into a single redesigned `list` tool. Breaking change.

## Goal

Replace `src/tools/list-directory.ts` and `src/tools/tree.ts` with one streamlined tool
`src/tools/list.ts` that lists directory contents and emits both a flat JSON `entries[]`
and a markdown ASCII tree rendering of those entries.

This is a redesign, not a merge. Schemas, semantics, and code are simplified.

## Non-goals

- Filtering by glob pattern (use `find`)
- Sort options (always dirs-first, alphabetical)
- Symlink target resolution
- Cursor-based pagination
- Per-entry stat metadata (use `stat`)

## Contract

### Input

```ts
{
  path?: string;          // default: workspace root
  maxDepth?: number;      // 1..MAX_TREE_DEPTH (10), default 1 (flat)
  maxEntries?: number;    // 1..MAX_LIST_ENTRIES, default DEFAULT_LIST_MAX_ENTRIES (1000)
  includeHidden?: boolean; // default false
  includeIgnored?: boolean;// default false (gitignore-aware)
}
```

Depth controls recursion: `maxDepth=1` lists top level only; `>1` recurses.

### Output

```ts
{
  ok: true,
  path: string,                          // absolute, normalized
  entries: Array<{
    name: string,
    relativePath: string,                // POSIX, relative to `path`
    type: 'file' | 'directory' | 'symlink' | 'other',
  }>,
  markdown: string,                      // ASCII tree of the same entries
  entryCount: number,                    // entries.length
  totalEntries: number,                  // total found before maxEntries cap
  totalFiles: number,
  totalDirectories: number,
  resourceUri?: string,                  // present when truncated (full result stored)
}
```

Truncation: when `totalEntries > entryCount`, the full result (entries + markdown)
is stored via `resourceStore` and `resourceUri` is returned. Inline response stays bounded.

### Markdown format

Box-drawing characters, raw names (no trailing `/`):

```text
src
├── cli.ts
├── config.ts
├── core
├── index.ts
└── transport.ts
```

## Architecture

```text
handleList(args, ctx)
  ├─ normalize & validate path (PathGuard)
  ├─ collect(rootPath, opts) → CollectedEntry[]   (single DFS, dirs-first/alpha)
  ├─ renderMarkdown(rootName, entries) → string   (pure)
  ├─ tally counts (totalFiles, totalDirectories)
  └─ buildResponse → maybe putResource()
```

Two pure helpers + one handler. Target ~150 LoC.

- `collect`: single DFS using existing `globEntries` from `core/fs.ts`. Honors
  `maxDepth`, stops at `maxEntries`, applies hidden/ignored filters. Returns flat
  array sorted dirs-first then alphabetical at each level.
- `renderMarkdown`: groups the flat sorted array by parent path on the fly,
  emits `├──`, `└──`, `│` lines.

## Errors & limits

- Invalid path / not a directory → `McpError(NOT_DIRECTORY)`.
- Outside allowed roots → `ACCESS_DENIED` (raised by `normalizePath` in PathGuard).
- Timeout → `withTimedAbortSignal(DEFAULT_SEARCH_TIMEOUT_MS)`.
- `maxEntries` hit → no error; `truncated` implied via `resourceUri` presence and
  `totalEntries > entryCount`.
- `maxDepth` hit → silent; deeper entries not enumerated.

Limits (reuse `core/util.ts` constants):

- `maxDepth`: 1..`MAX_TREE_DEPTH` (10), default 1
- `maxEntries`: 1..`MAX_LIST_ENTRIES`, default `DEFAULT_LIST_MAX_ENTRIES` (1000)

## Testing

New file `__tests__/tools/list.test.ts`:

- Flat default (`maxDepth=1`) returns top-level only, dirs-first/alpha.
- `maxDepth=3` recurses; `relativePath` is POSIX (`core/path.ts`).
- `markdown` matches expected ASCII tree format.
- `includeHidden` toggles dotfile visibility.
- `includeIgnored` toggles gitignore filtering.
- `maxEntries` truncation populates `resourceUri` and `totalEntries > entryCount`.
- `totalFiles + totalDirectories === totalEntries`.
- Non-directory path → `NOT_DIRECTORY`.
- Path outside roots → `ACCESS_DENIED`.
- Aborted signal → `TIMEOUT`.

Remove or migrate `__tests__/tools/directory.test.ts` cases scoped to `ls`/`tree`.
Regenerate `__tests__/schemas/__snapshots__/tool-schemas.json`.

## Migration

1. Create `src/tools/list.ts`.
2. Delete `src/tools/list-directory.ts` and `src/tools/tree.ts`.
3. Update `src/tools.ts`: remove the two old imports, add `./tools/list.js`.
4. Regenerate schema snapshot.
5. Replace/remove `__tests__/tools/directory.test.ts`; add `__tests__/tools/list.test.ts`.
6. Workspace search for `'ls'` / `'tree'` tool-name references (resources/instructions,
   README, prompts) and update to `'list'`.
7. `node scripts/tasks.mjs` until green.

## Breaking changes (intentional)

Removed inputs: `sortBy`, `cursor`, `pattern`, `excludePatterns`, `includeSymlinkTargets`,
`includeSizes`, `mode`.

Removed outputs: `nextCursor`, `continuation`, nested `tree`/`children`, separate `ascii`
field (now `markdown`), per-entry `size`/`modified`/`symlinkTarget`.

Renamed tool: `ls` + `tree` → `list`.
