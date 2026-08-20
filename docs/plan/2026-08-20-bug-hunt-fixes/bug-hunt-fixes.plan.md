# Plan: fix every Confirmed finding from the 2026-08-20 dev-branch bug hunt

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `8f18abb`, 2026-08-20.
> **Drift check (run first)**: `git diff --stat 8f18abb..HEAD -- src __tests__`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

An adversarial bug hunt (parallel hunt + blind-refute workflow, this session,
2026-08-20) read all 44 changed `src/` files on `dev` vs `main` and produced 21
**Confirmed** findings — each backed by a verbatim-quoted guard/caller the
refuter independently re-derived — plus 8 Suspected findings still needing a
repro before any fix is written. This plan fixes all 21 Confirmed findings.
No spec exists for this change; requirements covered: none, this is a fix.

The findings span three real risk classes: unauthenticated-reachable resource
exhaustion on the HTTP transport (event-store/watcher-registry growth, RE2
heap exhaustion), silently-wrong tool output (depth off-by-one, gitignore
bypass, basename over-match, unclamped pagination cursor), and a TOCTOU
data-loss bypass in `delete`'s confirmation flow. Fixing them closes each of
those paths without changing any documented tool contract except the two
places (`edit.diff` description, `isSafeGlobSyntax` comment) where the
contract text itself was wrong.

## Current state

Every excerpt below was re-read live against commit `8f18abb` (no drift from
the original hunt — recon confirmed all 21 line numbers still match).

### Step 1 — [`src/tools/edit.ts`](../../../src/tools/edit.ts)

- [`edit.ts:53`](../../../src/tools/edit.ts#L53) — `const MAX_MULTI_FILES = 5;` (existing sibling cap, for naming convention).
- [`edit.ts:58`](../../../src/tools/edit.ts#L58):

  ```ts
  edits: z
    .array(EditSpecSchema)
    .min(1)
    .optional()
    .describe(
      'Replacements applied to path or to every file in paths; not allowed when using files (each file carries its own edits)',
    ),
  ```

  No `.max()` — unbounded.

- [`edit.ts:72`](../../../src/tools/edit.ts#L72):

  ```ts
  edits: z.array(EditSpecSchema).min(1).describe('Replacements to apply to this specific file'),
  ```

  Same gap, per-file batch mode.

- [`edit.ts:108`](../../../src/tools/edit.ts#L108):

  ```ts
  diff: z
    .string()
    .optional()
    .describe('Unified diff of all changes (present in dryRun mode or when changes were made)'),
  ```

  `buildDiff()` is only called inside the `if (dryRun)` branch (current
  [`edit.ts:437-452`](../../../src/tools/edit.ts#L437-L452)); the real-write
  branch (`edit.ts:454-486`) never sets `.diff`. No test anywhere asserts
  `diff` on a non-dryRun write.

- Exemplar for the array cap — [`src/core/schema.ts:364`](../../../src/core/schema.ts#L364):

  ```ts
  paths: z
    .array(RequiredPath)
    .min(1)
    .max(maxBatch)
    .optional()
    .describe(`Array of file paths for batch mode (max ${String(maxBatch)}); ...`),
  ```

- Why this matters: each distinct `oldText` compiles a new RE2 pattern into
  re2-wasm's fixed, non-growable 16 MB heap
  ([`src/core/search.ts:40-45`](../../../src/core/search.ts#L40-L45)), held in
  `regexCache` until the whole edits loop's trailing `finally`
  (`edit.ts:411-416`). Heap exhaustion is a process-wide `abort()` that kills
  `search_text`/`replace_text` too.

### Step 2 — [`src/transport.ts`](../../../src/transport.ts) event store

- [`transport.ts:57`](../../../src/transport.ts#L57) — `const MAX_EVENTS_PER_STREAM = 1000;`
- [`transport.ts:77-97`](../../../src/transport.ts#L77-L97) (`InMemoryEventStore`):

  ```ts
  export class InMemoryEventStore implements EventStore {
    private readonly streams = new Map<StreamId, StoredEvent[]>();
    private readonly eventIdToStreamId = new Map<EventId, StreamId>();

    storeEvent(streamId: StreamId, message: JSONRPCMessage): Promise<EventId> {
      const eventId = randomUUID();
      let stream = this.streams.get(streamId);
      if (!stream) {
        stream = [];
        this.streams.set(streamId, stream);
      }
      stream.push({ id: eventId, message });
      this.eventIdToStreamId.set(eventId, streamId);
      if (stream.length > MAX_EVENTS_PER_STREAM) {
        const removed = stream.shift();
        if (removed) {
          this.eventIdToStreamId.delete(removed.id);
        }
      }
      return Promise.resolve(eventId);
    }
  ```

  Events _within_ a stream are FIFO-capped; the number of distinct `streams`
  keys is never bounded — only a whole-store `.clear()` at session teardown
  shrinks it, and the SDK mints a fresh `randomUUID()` stream per POST.

### Step 3 — [`src/resources.ts`](../../../src/resources.ts) subscribe leak

- [`src/resources.ts:214-`](../../../src/resources.ts#L214) `createWatcherRegistry()`:

  ```ts
  function createWatcherRegistry() {
    const watchers = new Map<string, FSWatcher>();
    const activeCallbacks = new Map<string, Set<(uri: string) => void>>();
    const desiredState = new Map<string, 'subscribed' | 'unsubscribed'>();
    // ...
    addCallback(uri: string, notify: (uri: string) => void): void {
      let callbacks = activeCallbacks.get(uri);
      if (!callbacks) {
        callbacks = new Set();
        activeCallbacks.set(uri, callbacks);
      }
      callbacks.add(notify);
      desiredState.set(uri, 'subscribed');
    },
    // ...
    remove(uri: string): void {
      desiredState.set(uri, 'unsubscribed');
      activeCallbacks.delete(uri);
      const watcher = watchers.get(uri);
      if (watcher) { dropWatcher(uri, watcher); }
    },
  ```

- [`src/resources.ts:353-369`](../../../src/resources.ts#L353-L369) (`subscribe`):

  ```ts
  async subscribe(uri, notify) {
    if (!options.pathGuard) return;

    registry.addCallback(uri, notify);

    if (registry.hasWatcher(uri)) return;
    // A cap hit before validation is reported to the caller as an outright
    // rejection; after validation it is silent (see below).
    if (registry.isAtCap()) {
      warnWatcherCap(uri);
      return false;
    }

    const filePath = extractPath(uri);
    if (!filePath) {
      throw new ResourceNotFoundError(uri, `Cannot subscribe: not a filesystem URI`);
    }
  ```

  `addCallback` runs unconditionally before validation; none of the later
  failure exits (cap-before-validate, non-filesystem URI, `NOT_FOUND`/
  `ACCESS_DENIED` catch, cap-after-validate) call `registry.remove(uri)`.
  `isAtCap()` counts only the `watchers` Map (real `FSWatcher`s), never
  `activeCallbacks`/`desiredState`.

### Step 4 — [`src/core/registrar.ts`](../../../src/core/registrar.ts) roots-sync race

- [`src/core/registrar.ts:237-253`](../../../src/core/registrar.ts#L237-L253):

  ```ts
  } finally {
    if (this.state !== 'shutting_down') {
      try {
        await this.pathGuard.setRoots(this.rootDirectories);
      } catch (error) {
        Logger.emit('warning', `Failed to apply roots to the path guard: ...`);
      }
      this.state = 'idle';
      if (this.pendingRootsUpdate) {
        this.pendingRootsUpdate = false;
        void this.updateRootsFromClient(server);
      }
    }
  }
  ```

- [`src/core/registrar.ts:262-`](../../../src/core/registrar.ts#L262) `destroy()`:

  ```ts
  destroy(): void {
    this.state = 'shutting_down';
    if (this.initTimer) { clearTimeout(this.initTimer); this.initTimer = undefined; }
    if (this._debouncedUpdate) { this._debouncedUpdate.cancel(); this._debouncedUpdate = undefined; }
  }
  ```

  The `if (this.state !== 'shutting_down')` guard is checked once, _before_
  the `await`. `destroy()` can flip `state` during that await; the code below
  it still runs unconditionally afterward.

- Constraint: `eslint.config.mjs:45` extends `eslint.configs.recommended`,
  which enables core rule `no-unsafe-finally` — **no `return`/`throw`/`break`/
  `continue` directly inside a `finally` block.** Verified live.

### Step 5 — [`src/core/errors.ts`](../../../src/core/errors.ts) + [`src/core/path.ts`](../../../src/core/path.ts) realpath misclassification

- [`src/core/errors.ts:118`](../../../src/core/errors.ts#L118) — `const ERRNO_MAP = { ... EACCES: ErrorCode.PERMISSION_DENIED, EPERM: ErrorCode.PERMISSION_DENIED, ... };` (module-local, not exported).
- [`src/core/errors.ts:137-144`](../../../src/core/errors.ts#L137-L144):

  ```ts
  // NOT_FOUND is in here (not just ENOENT) because a dangling symlink whose
  // target sits inside an allowed root surfaces as an FsError NOT_FOUND. Skipping
  // the entry is the point of a listing; rethrowing would fail the whole listing.
  export const SKIPPABLE_FS_CODES: ReadonlySet<ErrorCode> = new Set([
    ErrorCode.ACCESS_DENIED,
    ErrorCode.NOT_FOUND,
    ErrorCode.SYMLINK_NOT_ALLOWED,
  ]);
  ```

  `ErrorCode.PERMISSION_DENIED` exists (`errors.ts:13`) and is **not** in this set.

- `src/core/path.ts` `handleRealpathError` (~line 851-897): only `ENOENT` is
  special-cased; every other failure (EACCES/EPERM/ELOOP) falls through to
  `throw new FsError(ErrorCode.UNKNOWN, 'Cannot access path', ...)`.
- Consumer — `src/core/glob.ts` `isEntryAccessibleByType` (~line 56-58):
  `if (SKIPPABLE_FS_CODES.has(error.code)) return false; throw error;` — an
  `UNKNOWN` code rethrows, aborting the entire `list`/`find_files`/`tree`/
  `search_text` call on one permission-denied symlink.
- **Do not** just add `UNKNOWN` to `SKIPPABLE_FS_CODES`: `path.ts` also throws
  `ErrorCode.UNKNOWN` for genuinely non-skippable conditions on the same call
  chain (uninitialized `PathGuard`, the deliberate fail-safe non-ENOENT
  `lstat` probe, the terminal ancestor-walk failure) — widening the skip set
  to `UNKNOWN` would silently swallow those too.

### Step 6 — [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts)

- [`replace-in-files.ts:592-601`](../../../src/tools/replace-in-files.ts#L592-L601):

  ```ts
  const entries = globEntries({
    cwd: root,
    pattern: effectivePattern,
    excludePatterns: args.includeIgnored ? [] : DEFAULT_EXCLUDE_PATTERNS,
    includeHidden: args.includeHidden,
    baseNameMatch: true,
    onlyFiles: true,
    suppressErrors: true,
    ...(args.maxDepth !== undefined ? { maxDepth: args.maxDepth } : {}),
  });
  ```

  No `respectGitignore` key — always defaults to `false`
  ([`src/core/glob.ts:356`](../../../src/core/glob.ts#L356)).

- Sibling exemplars that wire it correctly:
  [`src/tools/search-content.ts:255`](../../../src/tools/search-content.ts#L255)
  `respectGitignore: !args.includeIgnored,` and
  [`src/tools/search-files.ts:143`](../../../src/tools/search-files.ts#L143)
  same line.
- [`replace-in-files.ts:543-559`](../../../src/tools/replace-in-files.ts#L543-L559) (`resolveSearchRoot`):

  ```ts
  async function resolveSearchRoot(pathValue, fs) {
    if (!pathValue) {
      return { root: fs.pathGuard.resolvePathOrRoot(undefined), filePattern: undefined };
    }
    const resolvedPath = await fs.pathGuard.validateExistingPath(pathValue);
    const { stats: fileStats } = await fs.stat(resolvedPath);
    if (fileStats.isFile()) {
      return { root: dirname(resolvedPath), filePattern: globEscape(basename(resolvedPath)) };
    }
    return { root: resolvedPath, filePattern: undefined };
  }
  ```

  With `baseNameMatch: true`, `src/core/glob.ts:271-277`
  (`normalizePattern`) rewrites the slash-free escaped basename to
  `**/${basename}`, matching every same-named file under the parent tree —
  not just the targeted file. No sibling tool routes a single-file `path`
  through `globEntries`, so there is no existing pattern to imitate; the fix
  is local to this file.

### Step 7 — [`src/core/glob.ts`](../../../src/core/glob.ts) + [`src/tools/list.ts`](../../../src/tools/list.ts) depth off-by-one

- [`src/core/glob.ts:367-378`](../../../src/core/glob.ts#L367-L378):

  ```ts
  function getRelativeDepth(relativePath: string): number {
    const len = relativePath.length;
    if (len === 0) return 0;
    let count = 0;
    for (let i = 0; i < len; i++) {
      const code = relativePath.charCodeAt(i);
      if (code === 47 || code === 92) {
        count++;
      }
    }
    return count + 1;
  }
  ```

  Single call site — [`src/core/glob.ts:395-397`](../../../src/core/glob.ts#L395-L397)
  inside `processDirentMatch`: `if (getRelativeDepth(rel) > maxDepth) return;`

- Two **different, incompatible** public `maxDepth` conventions share this
  one function:
  - `maxDepthField()` (`src/core/schema.ts`, used by `find_files`,
    `search_text`, `replace_text`) — documented **0-based**: "0 = base
    directory only, omit for unlimited". These three pass `args.maxDepth`
    straight through.
  - `src/tools/list.ts` `ListInputSchema.maxDepth`
    (`list.ts:208-212`) — `PositiveInt.max(MAX_TREE_DEPTH).default(1)`,
    documented **1-based** ("default: 1 = top-level only"), and its
    `collect()` (~`list.ts:101`) passes `options.maxDepth` straight through
    too, relying on the current `+1` bug to make its own contract work.
  - `MAX_TREE_DEPTH = 50` ([`src/core/util.ts:115`](../../../src/core/util.ts#L115)).
  - Fixing `getRelativeDepth` alone silently breaks `list`'s existing
    `maxDepth=1`/`maxDepth>1` tests in
    [`__tests__/tools/directory.test.ts`](../../../__tests__/tools/directory.test.ts).

### Step 8 — [`src/core/search.ts`](../../../src/core/search.ts) mid-walk error suppression

- [`search.ts:177-184`](../../../src/core/search.ts#L177-L184) (`scanContent`):

  ```ts
  const entries = globEntries({
    cwd: directory,
    pattern: options.filePattern ?? '**/*',
    excludePatterns: options.excludePatterns ?? [],
    includeHidden: Boolean(options.includeHidden),
    respectGitignore: Boolean(options.respectGitignore),
    maxDepth: options.maxDepth ?? 100,
  });
  ```

- [`search.ts:294-301`](../../../src/core/search.ts#L294-L301) (`searchFiles`): same shape, no `suppressErrors`.
- Both default `suppressErrors` to `false`
  ([`src/core/glob.ts:356`](../../../src/core/glob.ts#L356)); `processGlobPattern`
  (`glob.ts:467-468`) rethrows on a mid-walk error whenever it's false instead
  of `Logger.warn`-and-skip.
- Exemplars that already set it —
  [`src/tools/replace-in-files.ts:599`](../../../src/tools/replace-in-files.ts#L599)
  `suppressErrors: true,` and
  [`src/tools/calculate-hash.ts:156`](../../../src/tools/calculate-hash.ts#L156) same.
- Out of scope, flagged only: `src/tools/list.ts:95-103` has the identical
  gap (its own `globEntries()` call, no `suppressErrors`). It was not one of
  the 21 audited-and-refuted findings, so it is **not** fixed by this plan —
  see [Notes](#notes).

### Step 9 — [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts) TOCTOU

- [`delete-file.ts:211-223`](../../../src/tools/delete-file.ts#L211-L223):

  ```ts
  // TOCTOU check: re-stat the path immediately before deletion
  let currentStats: Awaited<ReturnType<GuardedFileSystem['lstat']>>;
  try {
    currentStats = await ctx.fs.lstat(validPath);
  } catch (error) {
    if (isNodeError(error) && error.code === 'ENOENT' && args.ignoreIfNotExists) {
      return { item: { path: validPath } };
    }
    return { failure: toDeleteFailure(inputPath, error) };
  }

  const currentItemType = resolveItemType(currentStats);
  if (itemType !== 'other' && currentItemType !== itemType) {
    return { failure: {/* ... */} };
  }
  ```

  Compares only the coarse category. `itemStats` (pre-elicitation stat, in
  scope since ~line 183) and `currentStats` (post-elicitation, above) are
  Node `fs.Stats` objects — `dev`/`ino`/`birthtimeMs` are already present on
  both, no new stat call needed.

- `birthtimeMs` is already used elsewhere in this codebase for identity-
  adjacent purposes: `src/tools/stat.ts:78`, `src/tools/create.ts:138`.

### Step 10 — [`src/core/path-completer.ts`](../../../src/core/path-completer.ts)

- [`path-completer.ts:9`](../../../src/core/path-completer.ts#L9) — `const MAX_COMPLETION_ITEMS = 100;` (module-scoped, already in file).
- [`path-completer.ts:270-290`](../../../src/core/path-completer.ts#L270-L290) (`findMatchesInDirectory`):

  ```ts
  const matches: string[] = [];
  if (!(await PathCompleter.isAllowedCompletionDirectory(searchDir, allowed))) return matches;
  try {
    const entries = await readdir(searchDir, { withFileTypes: true });
    if (prefix === '') {
      for (const entry of entries) {
        const fullPath = join(searchDir, entry.name);
        if (isSensitive?.(fullPath)) continue;
        matches.push(entry.isDirectory() ? `${fullPath}${sep}` : fullPath);
      }
    } else {
      const lowerPrefix = prefix.toLowerCase();
      for (const entry of entries) {
        if (entry.name.toLowerCase().startsWith(lowerPrefix)) {
          const fullPath = join(searchDir, entry.name);
          if (isSensitive?.(fullPath)) continue;
          matches.push(entry.isDirectory() ? `${fullPath}${sep}` : fullPath);
        }
      }
    }
  ```

  Full `readdir()` before either loop; the 100-item cap is only applied later
  in `completePath()` via `.slice(0, MAX_COMPLETION_ITEMS)`.

- [`path-completer.ts:233-241`](../../../src/core/path-completer.ts#L233-L241) (`findMatchingRoots`):

  ```ts
  private static findMatchingRoots(searchDir, prefix, allowed): string[] {
    const lowerPrefix = prefix.toLowerCase();
    const normalizedSearchDir = normalizePath(searchDir);
    return PathCompleter.collectAllowedRoots(allowed, (root) => {
      const rootDir = dirname(root);
      if (normalizePath(rootDir) !== normalizedSearchDir) return false;
      return basename(root).toLowerCase().startsWith(lowerPrefix);
    });
  }
  ```

  Raw `!==` on two `normalizePath()` outputs, which only lowercase the
  Windows drive letter, not the rest of the path.

- Exemplar / fix target — **exported** helper
  [`src/core/path.ts:198`](../../../src/core/path.ts#L198):

  ```ts
  export function isSamePath(left: string, right: string): boolean {
    if (left === right) return true;
    const leftResolved = normalizeCaseForComparison(resolve(left));
    const rightResolved = normalizeCaseForComparison(resolve(right));
    return leftResolved === rightResolved;
  }
  ```

  (`normalizeCaseForComparison` itself, `path.ts:194`, is module-private — use
  the exported `isSamePath` instead, not the private helper.)

- Current import at `path-completer.ts:7`:
  `import { isPathWithinDirectories, isSlash, normalizePath, toPosixPath } from './path.js';`

### Step 11 — [`src/core/path.ts`](../../../src/core/path.ts) doc comment + darwin case fold

- [`path.ts:499-506`](../../../src/core/path.ts#L499-L506):

  ```ts
  /**
   * Pure glob-syntax safety check that does not require an initialized PathGuard.
   * Returns false for absolute paths and patterns containing traversal sequences ('..').
   * This is the subset of safety enforcement suitable for schema-level validation.
   * Operational path enforcement (allowed-root containment, symlink resolution) is
   * handled by PathGuard.assertSafeGlob and the validateExistingPath family.
   */
  export function isSafeGlobSyntax(pattern: string): boolean {
  ```

  `assertSafeGlob` does not exist anywhere in the repo (`grep -rn assertSafeGlob` = 1 hit, this comment). Real enforcement:
  [`src/core/glob.ts:35-50`](../../../src/core/glob.ts#L35-L50) `isEntryAccessibleByType`, via `isPathWithinDirectories` and `pathGuard.validateExistingPathDetailed`.

- [`path.ts:124`](../../../src/core/path.ts#L124) — `const IS_WINDOWS = platform() === 'win32';`
- [`path.ts:194-196`](../../../src/core/path.ts#L194-L196):

  ```ts
  function normalizeCaseForComparison(value: string): string {
    return IS_WINDOWS ? value.toLowerCase() : value;
  }
  ```

  Called by `isSamePath` (`path.ts:198`, used by `move.ts:268`'s
  `isCaseOnlyRename`), `isPathInsideDirectory`/`isPathWithinDirectories`
  (`path.ts:230-241`), and every other case-fold site in this file — never
  folds on darwin.

- [`src/tools/move.ts:252-268`](../../../src/tools/move.ts#L252-L268) already
  branches on `platform === 'win32' || platform === 'darwin'` for the
  sibling "cannot move into own subdirectory" check two lines above the
  `isCaseOnlyRename` call, confirming darwin needs the same fold —
  `move.ts` itself needs **no code change**; fixing the shared helper covers
  `isCaseOnlyRename` and every other caller.
- CI has no macOS runner —
  [`.github/workflows/ci.yml:29`](../../../.github/workflows/ci.yml#L29):
  `os: [ubuntu-latest, windows-latest]`. A darwin-specific regression
  assertion cannot self-verify in CI; see [Notes](#notes).

### Step 12 — [`src/tools/search-content.ts`](../../../src/tools/search-content.ts) + [`src/tools/search-files.ts`](../../../src/tools/search-files.ts) cursor clamp

- [`src/core/cursor.ts:5-18`](../../../src/core/cursor.ts#L5-L18):
  `OffsetCursorSchema = z.strictObject({ offset: z.int().nonnegative() })` —
  no upper bound. `encodeOffsetCursor`/`decodeOffsetCursor` exported.
- [`src/core/util.ts:120`](../../../src/core/util.ts#L120) — `export const MAX_SEARCH_RESULTS = 10000;`
- [`search-content.ts:357-364`](../../../src/tools/search-content.ts#L357-L364):

  ```ts
  const cursorOffset = args.cursor !== undefined ? decodeOffsetCursor(args.cursor) : 0;
  const pageSize = args.maxResults;
  const fetchMax = cursorOffset + pageSize;

  const result = await searchContent(
    basePath,
    args.searchPattern,
    buildSearchContentOptions({ ...args, maxResults: fetchMax }, signal),
    fs.pathGuard,
  );
  ```

  `MAX_SEARCH_RESULTS` already imported at `search-content.ts:33`.

- [`search-files.ts:136-146`](../../../src/tools/search-files.ts#L136-L146):

  ```ts
  const cursorOffset = args.cursor !== undefined ? decodeOffsetCursor(args.cursor) : 0;
  const pageSize = args.maxResults;
  const fetchMax = cursorOffset + pageSize;
  const searchOptions: Parameters<typeof searchFiles>[3] = {
    maxResults: fetchMax,
    // ...
  };
  ```

  `MAX_SEARCH_RESULTS` already imported at `search-files.ts:24`. Byte-for-byte
  the same unclamped pattern — one bug, two call sites, fix identically in
  both.

### Step 13 — [`src/prompts.ts`](../../../src/prompts.ts)

- [`prompts.ts:111-119`](../../../src/prompts.ts#L111-L119) (`linkToPath`):

  ```ts
  function linkToPath(absPath: string): PromptMessage {
    const content: ResourceLink = {
      type: 'resource_link',
      uri: pathToFileURL(absPath).href,
      name: absPath,
      annotations: { audience: ['assistant'], priority: 1 },
    };
    return { role: 'user', content };
  }
  ```

  Called from `analyze-path` (`prompts.ts:239`) and `summarize-directory`
  (`prompts.ts:370`). The server's only registered resource contracts
  (`src/resources.ts:464-470`) are `internal://instructions`,
  `filesystem-mcp://result/{id}`, `filesystem-mcp://file/{+path}` — `file:`
  matches none.

- Exemplar encoder — [`src/core/file-uri.ts:6-13`](../../../src/core/file-uri.ts#L6-L13):

  ```ts
  export function buildFileResourceUri(validPath: string): string {
    const posix = validPath.replace(/\\/g, '/');
    return `filesystem-mcp://file/${encodeURIComponent(posix).replace(/%2F/gi, '/')}`;
  }
  ```

  Used correctly by [`src/tools/_helpers.ts:54-62`](../../../src/tools/_helpers.ts#L54-L62)
  (`buildFileResourceLink`) — not a drop-in here since that helper also
  requires `mimeType`/`size`, which `linkToPath`'s callers don't have; use
  `buildFileResourceUri` directly.

## Commands

| Purpose                                           | Command                                  | Expected on success                                                              |
| ------------------------------------------------- | ---------------------------------------- | -------------------------------------------------------------------------------- |
| Per-step static gate                              | `node scripts/tasks.mjs --quick`         | `✓  4/4 passed  (2 skipped)` (format/lint/type-check/knip; test+rebuild skipped) |
| Per-step regression test                          | `node --test --import tsx "<test file>"` | `ℹ fail 0`                                                                       |
| Full gate (Done, and after Step 13)               | `node scripts/tasks.mjs`                 | all 6 tasks pass, no failures                                                    |
| CI parity (do not use for per-step gating — slow) | `npm run check`                          | exit 0                                                                           |

Verified live on `8f18abb`: `node scripts/tasks.mjs --quick` → `✓  4/4 passed
(2 skipped)  12.5s`. `node --test --import tsx
"__tests__/unit/single-or-batch-input.test.ts"` → `ℹ pass 9`, `ℹ fail 0`.

## Scope

**In scope** — the only files to modify:

- [`src/tools/edit.ts`](../../../src/tools/edit.ts)
- [`src/transport.ts`](../../../src/transport.ts)
- [`src/resources.ts`](../../../src/resources.ts)
- [`src/core/registrar.ts`](../../../src/core/registrar.ts)
- [`src/core/errors.ts`](../../../src/core/errors.ts)
- [`src/core/path.ts`](../../../src/core/path.ts)
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts)
- [`src/core/glob.ts`](../../../src/core/glob.ts)
- [`src/tools/list.ts`](../../../src/tools/list.ts) (compensation only, Step 7)
- [`src/core/search.ts`](../../../src/core/search.ts)
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts)
- [`src/core/path-completer.ts`](../../../src/core/path-completer.ts)
- [`src/tools/search-content.ts`](../../../src/tools/search-content.ts)
- [`src/tools/search-files.ts`](../../../src/tools/search-files.ts)
- [`src/prompts.ts`](../../../src/prompts.ts)
- Matching test files under `__tests__/` — named per step below.

**Files out of scope** — leave alone even though they look related:

- [`src/tools/move.ts`](../../../src/tools/move.ts) — its finding
  (`move.ts:268`, case-only-rename on darwin) is fixed entirely inside
  `path.ts`'s shared `normalizeCaseForComparison` (Step 11); touching
  `move.ts` itself would duplicate the platform check the audit flagged as
  already-inline-elsewhere.
- [`src/core/path.ts`](../../../src/core/path.ts) `isAllowedRoot`
  (~`path.ts:981-988`) — has its own independent inline
  `IS_WINDOWS ? ... .toLowerCase() : ...` that does _not_ route through
  `normalizeCaseForComparison` and will stay darwin-blind after Step 11. Not
  one of the 21 audited findings — a follow-up, not this plan.
- [`src/tools/list.ts`](../../../src/tools/list.ts) `globEntries()` at
  `list.ts:95-103` — same missing-`suppressErrors` gap as Step 8, but not
  one of the 21 audited-and-refuted findings. Flagged for a future pass.
- The 8 **Suspected** findings from the same hunt (`list.ts:121`,
  `edit.ts:368`, `calculate-hash.ts:149`, `move.ts:248`, `cli.ts:285`,
  `cli.ts:290`, `read.ts:327`, `concurrency.ts:68`) — none has a
  verbatim-quoted "ruled out" line, so none is fit to fix yet. Each needs its
  own settle step (repro or source read) first — see [Notes](#notes).

## Steps

### 1. `src/tools/edit.ts` — cap edits arrays, fix diff description

Add near `MAX_MULTI_FILES` (`edit.ts:53`):

```ts
const MAX_EDITS_PER_FILE = 100;
```

Change [`edit.ts:58`](../../../src/tools/edit.ts#L58) to
`.array(EditSpecSchema).min(1).max(MAX_EDITS_PER_FILE).optional().describe('Replacements applied to path or to every file in paths (max 100); not allowed when using files (each file carries its own edits)')`.
Change [`edit.ts:72`](../../../src/tools/edit.ts#L72) to
`.array(EditSpecSchema).min(1).max(MAX_EDITS_PER_FILE).describe('Replacements to apply to this specific file (max 100)')`.
Change [`edit.ts:108`](../../../src/tools/edit.ts#L108)'s `.describe()` to
`'Unified diff of all changes (present only in dryRun mode)'` — no functional
change, no test currently depends on diff-on-real-write.

Add to [`__tests__/tools/edit-multi.test.ts`](../../../__tests__/tools/edit-multi.test.ts)
(the "edit tool — input validation" describe block, ~line 12): a case
passing `MAX_EDITS_PER_FILE + 1` edits via `path` and asserting `isError:
true` (mirrors `__tests__/unit/single-or-batch-input.test.ts:54`'s "enforces
maxBatch on paths"), and a sibling case doing the same via
`files: [{ path, edits }]`.

**Verify**: `node --test --import tsx "__tests__/tools/edit-multi.test.ts"` → `ℹ fail 0`, then `node scripts/tasks.mjs --quick` → `✓ 4/4 passed`.

### 2. `src/transport.ts` — bound distinct event-store streams

Add `const MAX_EVENT_STREAMS = 1000;` near `MAX_EVENTS_PER_STREAM`
(`transport.ts:57`). In `storeEvent`'s `if (!stream) { ... }` branch
(`transport.ts:84-87`), after inserting the new stream, add: if
`this.streams.size > MAX_EVENT_STREAMS`, take the oldest key via
`this.streams.keys().next().value` (Map preserves insertion order), read its
events array, delete the key from `this.streams`, and delete each of that
array's event ids from `eventIdToStreamId` — same eviction shape already
used per-event at `transport.ts:92-96`, applied to a whole stream.

Add to [`__tests__/unit/event-store.test.ts`](../../../__tests__/unit/event-store.test.ts)
(sibling to the existing "evicts the oldest event once a stream exceeds the
cap" test, lines 46-57): store `MAX_EVENT_STREAMS + 1` distinct stream ids
(one `storeEvent` call each), then assert the first stream's event id
resolves to `undefined` via `getStreamIdForEventId`.

**Verify**: `node --test --import tsx "__tests__/unit/event-store.test.ts"` → `ℹ fail 0`.

### 3. `src/resources.ts` — fix subscribe leak, dedupe callback storage

In `createWatcherRegistry()`: change `activeCallbacks` from
`Map<string, Set<(uri: string) => void>>` to
`Map<string, (uri: string) => void>`. In `addCallback()`, replace the
get-or-create-Set-then-`.add` block with `activeCallbacks.set(uri, notify);
desiredState.set(uri, 'subscribed');` (last subscribe wins, no duplicate
closures). In `notifyAll()`, replace the `for (const cb of
currentCallbacks)` loop with a single call against the one stored callback.

In `createFilesystemResource().subscribe()` (`resources.ts:353-397`): delete
the standalone `registry.addCallback(uri, notify);` at (current) line 356.
Add `registry.addCallback(uri, notify);` immediately before each `return`
that represents a **live subscription**: inside the first
`if (registry.hasWatcher(uri)) return;` block (line 358), inside the second
`hasWatcher` re-check after validation (~line 389), and immediately before
`registry.attach(uri, resolved);` (~line 395). Every other exit (cap-before-
validate, non-filesystem URI, the validate-catch block, cap-after-validate)
is left untouched and now registers no callback — no `registry.remove(uri)`
cleanup needed on those paths.

Add to [`__tests__/unit/resource-subscribe-paths.test.ts`](../../../__tests__/unit/resource-subscribe-paths.test.ts):
(1) subscribe to the same real file URI twice, then trigger the underlying
watcher's change event once and assert `sendResourceUpdated` fired exactly
once, not twice; (2) drive a failed subscribe (non-existent file) followed
by a successful subscribe to a different file, and assert the failed
attempt left no callback that fires later.

**Verify**: `node --test --import tsx "__tests__/unit/resource-subscribe-paths.test.ts"` → `ℹ fail 0`.

### 4. `src/core/registrar.ts` — re-check state after the await

In `updateRootsFromClient`'s `finally` block (`registrar.ts:237-253`), do
**not** add an early `return` inside `finally` (blocked by `no-unsafe-finally`,
verified enabled). Instead wrap the post-await block in a second guard:

```ts
} finally {
  if (this.state !== 'shutting_down') {
    try {
      await this.pathGuard.setRoots(this.rootDirectories);
    } catch (error) {
      Logger.emit('warning', `Failed to apply roots to the path guard: ...`);
    }
    if (this.state !== 'shutting_down') {
      this.state = 'idle';
      if (this.pendingRootsUpdate) {
        this.pendingRootsUpdate = false;
        void this.updateRootsFromClient(server);
      }
    }
  }
}
```

Add to [`__tests__/unit/roots-failure-recovery.test.ts`](../../../__tests__/unit/roots-failure-recovery.test.ts):
give the fake `pathGuard.setRoots` an implementation that awaits a
manually-controlled promise before resolving; start
`updateRootsFromClient` without awaiting it; fire a `roots/list_changed`
so `pendingRootsUpdate` gets queued; call `manager.destroy()` while the
`setRoots` await is still pending; let it resolve; assert `state` is not
`'idle'` and `updateRootsFromClient` was not re-invoked post-destroy.

**Verify**: `node --test --import tsx "__tests__/unit/roots-failure-recovery.test.ts"` → `ℹ fail 0`.

### 5. `src/core/errors.ts` + `src/core/path.ts` — reclassify realpath errno

In `src/core/errors.ts:118`, change `const ERRNO_MAP` to `export const
ERRNO_MAP`. In the `SKIPPABLE_FS_CODES` literal (`errors.ts:140-144`), add
`ErrorCode.PERMISSION_DENIED,` with a one-line comment: OS-level EACCES/EPERM
on a symlink target during a listing is exactly as skippable as the other
three codes.

In `src/core/path.ts`, import `ERRNO_MAP` alongside the existing
`ErrorCode, FsError, isFsError, isNodeError, rethrowIfAborted` import from
`./errors.js`. In `handleRealpathError`'s final non-ENOENT throw (~lines
888-896), replace the hardcoded `ErrorCode.UNKNOWN` with:

```ts
const code = (isNodeError(error) ? ERRNO_MAP[error.code] : undefined) ?? ErrorCode.UNKNOWN;
```

and throw `FsError(code, ...)` — leave message/details/cause unchanged so
unmapped codes still fall back to `UNKNOWN`.

Add to [`__tests__/unit/hunt-regressions.test.ts`](../../../__tests__/unit/hunt-regressions.test.ts)
(sibling to the "list: tolerates a broken symlink" block, lines 271-296):
stub `node:fs/promises` `realpath` (via `node:test`'s `mock.method`) to
throw `EACCES` for one symlink target while a sibling file exists, call
`list`, and assert the listing still succeeds and still includes the
sibling. This case is platform-independent by construction (mocked errno),
so it does not need a POSIX/win32 skip guard.

**Verify**: `node --test --import tsx "__tests__/unit/hunt-regressions.test.ts"` → `ℹ fail 0`.

### 6. `src/tools/replace-in-files.ts` — respect gitignore, fix single-file over-match

At `replace-in-files.ts:592-601`, add `respectGitignore: !args.includeIgnored,`
to the `globEntries({...})` call, matching `search-content.ts:255` and
`search-files.ts:143` exactly.

Change `resolveSearchRoot`'s return type to
`{ root: string; filePattern: string | undefined; singleFile?: string }`.
In its `isFile()` branch (`replace-in-files.ts:552-556`), return
`{ root: dirname(resolvedPath), filePattern: undefined, singleFile: resolvedPath }`.
In `handleSearchAndReplace` (~lines 589-601), when `singleFile` is set, skip
the `globEntries(...)` call and build `entries` as a one-element
`AsyncIterable<{ path: string }>` yielding `{ path: singleFile }` instead —
`processEntriesConcurrently` already accepts any such iterable, so this is a
drop-in substitute that bypasses `baseNameMatch`/exclude/hidden/gitignore
filtering (an explicit single-file target should always be processed).

Add to [`__tests__/tools/replace-text.test.ts`](../../../__tests__/tools/replace-text.test.ts):
(1) write a `.gitignore` listing `ignored.txt`, write matching content into
it, call `replace_text` with default args, assert it is left unmodified,
then repeat with `includeIgnored: true` and assert it IS modified; (2)
create `a/foo.txt` and `b/foo.txt` both containing the search pattern, call
`replace_text` with `path` pointing exactly at `a/foo.txt`, assert
`filesModified === 1` and `b/foo.txt` is unchanged.

**Verify**: `node --test --import tsx "__tests__/tools/replace-text.test.ts"` → `ℹ fail 0`.

### 7. `src/core/glob.ts` + `src/tools/list.ts` — fix depth off-by-one without breaking `list`

In `src/core/glob.ts:377`, change `return count + 1;` to `return count;`
(`getRelativeDepth` has exactly one call site in the tree, `glob.ts:397` —
grep-confirmed).

In `src/tools/list.ts`, find `collect()`'s call into the shared glob
machinery (~`list.ts:101`, currently `maxDepth: options.maxDepth,`) and
change it to `maxDepth: options.maxDepth - 1,` — `options.maxDepth` is
guaranteed `>= 1` by its `PositiveInt` schema, so the subtraction never
underflows. Do **not** change `list.ts`'s schema, description, or default —
only its internal translation into the now-0-based `globEntries` primitive.

Add to [`__tests__/tools/directory.test.ts`](../../../__tests__/tools/directory.test.ts):
a new case calling `find_files` (or `search_content`) with `maxDepth: 0`
against a fixture with one base-directory file and one nested file, asserting
the base file is returned and the nested one is not (no existing test in the
repo passes `maxDepth: 0` — grep-confirmed zero hits). Re-run this file's
existing `list` `maxDepth=1`/`maxDepth>1` assertions unchanged as the
regression guard for the `list.ts` compensation.

**Verify**: `node --test --import tsx "__tests__/tools/directory.test.ts"` → `ℹ fail 0`.

### 8. `src/core/search.ts` — suppress mid-walk glob errors

Add `suppressErrors: true,` to both `globEntries({...})` calls: `scanContent`
(~~`search.ts:183`, right after `maxDepth: options.maxDepth ?? 100,`) and
`searchFiles` (~~`search.ts:300`, same insertion point).

Add to [`__tests__/unit/search-abort.test.ts`](../../../__tests__/unit/search-abort.test.ts):
extend the existing "searchContent — skipped files are counted, not
silently dropped" block (line 54) and the "searchFiles — abort marks the
scan truncated with a reason" block (line 195) with a case each that forces
a mid-walk glob error (mock/stub the glob iterator or `node:fs/promises`
`readdir`/`glob` to throw after yielding one entry), asserting the call
resolves with the matches collected so far instead of rejecting.

**Verify**: `node --test --import tsx "__tests__/unit/search-abort.test.ts"` → `ℹ fail 0`.

### 9. `src/tools/delete-file.ts` — close the TOCTOU identity gap

At `delete-file.ts:222-223`, extend (do not replace) the existing guard with
an identity comparison using the already-in-scope `itemStats.stats` (pre-
elicitation, ~line 183/191) and `currentStats.stats` (post-elicitation,
line 214):

```ts
const identityChanged =
  itemStats.stats.dev !== currentStats.stats.dev ||
  itemStats.stats.ino !== currentStats.stats.ino ||
  itemStats.stats.birthtimeMs !== currentStats.stats.birthtimeMs;

if (itemType !== 'other' && (currentItemType !== itemType || identityChanged)) {
  // existing failure branch, unchanged
}
```

No new stat calls. `birthtimeMs` is the primary cross-platform signal
(`dev`/`ino` can read `0` on some non-POSIX filesystem drivers) — combine
all three rather than relying on `dev`/`ino` alone.

Add to [`__tests__/tools/elicitation.test.ts`](../../../__tests__/tools/elicitation.test.ts):
extend the "delete: client accepts elicitation" block (lines 83-109) with a
case whose `elicitInput` callback, between the pre- and post-elicitation
stats, removes the original directory and creates a fresh directory of the
same name with a marker file, then returns `accept`. Assert the delete call
fails and the marker file still exists (proving `performDeletion` never ran
on the swapped content).

**Verify**: `node --test --import tsx "__tests__/tools/elicitation.test.ts"` → `ℹ fail 0`.

### 10. `src/core/path-completer.ts` — cap directory scan, fix root case-fold

In `findMatchesInDirectory` (`path-completer.ts:270-290`), replace the eager
`readdir(searchDir, { withFileTypes: true })` plus two full-iteration loops
with a single streaming loop that breaks once the cap is hit:

```ts
const dir = await opendir(searchDir);
try {
  const lowerPrefix = prefix.toLowerCase();
  for await (const entry of dir) {
    if (matches.length >= MAX_COMPLETION_ITEMS) break;
    if (prefix !== '' && !entry.name.toLowerCase().startsWith(lowerPrefix)) continue;
    const fullPath = join(searchDir, entry.name);
    if (isSensitive?.(fullPath)) continue;
    matches.push(entry.isDirectory() ? `${fullPath}${sep}` : fullPath);
  }
} finally {
  await dir.close().catch(() => {});
}
```

Change the `node:fs/promises` import at the top of the file from `readdir`
to `opendir` (no other use of `readdir` in this file). Keep the existing
outer try/catch (ENOENT/EACCES swallow, `Logger.warn` otherwise) around this
block. `MAX_COMPLETION_ITEMS` is already module-scoped — no new import.

In `findMatchingRoots` (`path-completer.ts:233-241`), replace
`if (normalizePath(rootDir) !== normalizedSearchDir) return false;` with
`if (!isSamePath(rootDir, normalizedSearchDir)) return false;` (drop the now-
redundant `normalizePath(rootDir)` call). Add `isSamePath` to the existing
import from `./path.js` at `path-completer.ts:7`.

Add to [`__tests__/unit/path-completer.test.ts`](../../../__tests__/unit/path-completer.test.ts):
(1) write `MAX_COMPLETION_ITEMS + 50` files into a tmp dir, call
`completer.suggest(tmpDir + sep)`, assert `results.length === 100`; (2)
create two sibling directories under one allowed-roots parent, initialize
`PathGuard` with both as allowed roots, and confirm a root-name suggestion
whose parent-segment casing differs from the on-disk casing still surfaces
the sibling root.

**Verify**: `node --test --import tsx "__tests__/unit/path-completer.test.ts"` → `ℹ fail 0`.

### 11. `src/core/path.ts` — fix stale doc comment, fold case on darwin

Replace `path.ts:503-504`'s comment line with wording naming the real
enforcement path:

```
 * Operational path enforcement (allowed-root containment, symlink resolution) is
 * handled by isEntryAccessibleByType in src/core/glob.ts, via
 * isPathWithinDirectories and pathGuard.validateExistingPathDetailed.
```

Leave lines 499-502 and 505-506 untouched. Comment-only, zero behavior
change.

Change `normalizeCaseForComparison` (`path.ts:194-196`) to fold on darwin
too:

```ts
const IS_CASE_INSENSITIVE_FS = IS_WINDOWS || platform() === 'darwin';
// ...
function normalizeCaseForComparison(value: string): string {
  return IS_CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}
```

This fixes `isSamePath` (covers `move.ts:268`'s `isCaseOnlyRename`) and
`isPathInsideDirectory`/`isPathWithinDirectories` for every caller at once —
no change needed in `move.ts` itself.

No test change for the comment fix — the two existing `isSafeGlobSyntax`
tests in [`__tests__/unit/path-guard.test.ts`](../../../__tests__/unit/path-guard.test.ts)
(lines 58, 64) already cover that function's real (unchanged) behavior. For
the darwin fold, add to
[`__tests__/tools/move.test.ts`](../../../__tests__/tools/move.test.ts) a
case gated the same way the existing test gates on `win32`/`darwin` (lines
22-52): a genuine case-only rename (`Foo.txt` → `foo.txt`), asserting it
succeeds as a single rename with no overwrite-confirmation path taken. This
assertion only runs on a real darwin host — CI has no macOS runner
(`ci.yml:29`), so it self-verifies locally on a Mac only; the win32 leg
already exercises the un-buggy path today. State this limitation in the PR
description, do not silently skip writing the test.

**Verify**: `node --test --import tsx "__tests__/unit/path-guard.test.ts" "__tests__/tools/move.test.ts"` → `ℹ fail 0`.

### 12. `src/tools/search-content.ts` + `src/tools/search-files.ts` — clamp cursor-derived fetch size

At `search-content.ts:359`, change `const fetchMax = cursorOffset +
pageSize;` to `const fetchMax = Math.min(cursorOffset + pageSize,
MAX_SEARCH_RESULTS);` (`MAX_SEARCH_RESULTS` already imported, line 33).

At `search-files.ts:138`, the identical change: `const fetchMax =
Math.min(cursorOffset + pageSize, MAX_SEARCH_RESULTS);`
(`MAX_SEARCH_RESULTS` already imported, line 24).

Add to [`__tests__/tools/search-text-pagination.test.ts`](../../../__tests__/tools/search-text-pagination.test.ts):
extend "paginates matches across pages via cursor" with a case using
`encodeOffsetCursor(MAX_SEARCH_RESULTS * 5)` (import from
`../../src/core/cursor.js`) plus a small `maxResults`, asserting the call
still completes quickly rather than scanning past the cap. Add the mirror
case to [`__tests__/tools/find-files-pagination.test.ts`](../../../__tests__/tools/find-files-pagination.test.ts)
for `find_files`.

**Verify**: `node --test --import tsx "__tests__/tools/search-text-pagination.test.ts" "__tests__/tools/find-files-pagination.test.ts"` → `ℹ fail 0`.

### 13. `src/prompts.ts` — fix `linkToPath`'s resource URI scheme

Drop the `import { pathToFileURL } from 'node:url';` (unused after this
change — not referenced elsewhere in the file). Add
`import { buildFileResourceUri } from './core/file-uri.js';` alongside the
other core imports. In `linkToPath` (lines 111-119), replace
`uri: pathToFileURL(absPath).href,` with `uri: buildFileResourceUri(absPath),`.
Leave `name`/`annotations` untouched.

Add to [`__tests__/prompts-stdio.test.ts`](../../../__tests__/prompts-stdio.test.ts):
in the "returns analyze-path with required args over stdio transport" test
(lines 58-87), right after the existing `m1.content.type === 'resource_link'`
assertion (line 84), add `assert.strictEqual(m1.content.uri,
buildFileResourceUri(filePath))` (import `buildFileResourceUri` from
`'../src/core/file-uri.js'`).

**Verify**: `node --test --import tsx "__tests__/prompts-stdio.test.ts"` → `ℹ fail 0`, then `node scripts/tasks.mjs` (full gate) → all 6 tasks pass.

## Done

- [ ] `node scripts/tasks.mjs` exits with all 6 tasks passed (format, lint,
      type-check, knip, test, rebuild) — no skips, no failures.
- [ ] Every new `it(...)` named in Steps 1-13 is present and passing.
- [ ] `git status` shows changes only in the 15 in-scope files plus their
      named test files.
- [ ] `grep -rn assertSafeGlob src` returns zero matches.
- [ ] `grep -rn "pathToFileURL" src/prompts.ts` returns zero matches.

## STOP

Stop and report if:

- The code at any [Current state](#current-state) location does not match
  its excerpt (drift since `8f18abb`).
- A step's Verify command fails twice after one fix attempt — the second
  failure means the fix sketch's assumption is wrong, not the
  implementation.
- Fixing a finding appears to require touching a file listed as
  [out of scope](#scope).
- Step 7's `list.ts` compensation would require changing `ListInputSchema`'s
  public `maxDepth` contract (default, min, or description) — the plan
  assumes only the internal `collect()` call site changes.
- Step 4's fix cannot be expressed without a `return`/`throw` inside the
  `finally` block once actually written — re-confirm `no-unsafe-finally` is
  still active in `eslint.config.mjs` before working around it.

## Notes

- **`transport.ts:441`** (`isServerContext` dead branch) is **not** a step in
  this plan. Recon re-confirmed it is genuinely unreachable under the
  current call graph (the only HTTP-session `PathGuard` is always
  constructed with `isServerContext: true` at `server.ts:127`) and
  recommends keeping it as a cheap, correctly-worded defensive invariant —
  deleting it would remove a real safety net for a future refactor, for zero
  benefit. This finding is closed with no code change.
- **8 Suspected findings from the same hunt are deliberately excluded** from
  this plan — none has the verbatim "ruled out" quote that Confirmed status
  requires, so a fix would be guessing at unverified behavior:
  - `src/tools/list.ts:121` (Critical) — possible directory-symlink sandbox
    escape. Settle first: plant a directory symlink under an allowed root
    pointing outside all allowed dirs, `list` with `maxDepth >= 2`, check
    for leaked descendants.
  - `src/tools/edit.ts:368`, `src/tools/calculate-hash.ts:149` (Major) —
    possible TOCTOU symlink races in the read/hash path. Settle: check
    whether `GuardedFileSystem` re-validates between stat and open.
  - `src/tools/move.ts:248` (Major) — self-move short-circuit may pre-empt
    the case-only-rename branch on case-insensitive filesystems. Settle:
    repro on Windows/macOS. (Independent of Step 11's fix — that fixes the
    _comparison_, this is about which branch runs _first_.)
  - `src/cli.ts:285`, `src/cli.ts:290` (Minor) — possible stdout truncation
    from `process.exit(0)` without a flush wait. Settle: repro piping
    `--help`/`--version` through a slow consumer on Windows.
  - `src/tools/read.ts:327` (Minor) — a garbled comment ending in literal
    `--- IGNORE ---`. Settle: `git log -p` on that line for the original
    wording.
  - `src/core/concurrency.ts:68` (Minor, dormant) — `withAbort` throws
    synchronously instead of returning a rejected promise on a pre-aborted
    signal. No current call site is affected; no action needed unless a
    non-`await`ed call site appears later.

  Each needs a `diagnose`- or `verify-specs`-style settle pass before a fix
  plan is written for it — that is separate work from this plan.

- Follow-ups flagged during recon, intentionally not folded into this plan's
  scope (see [Scope](#scope) for why): `PathGuard.isAllowedRoot`'s own
  inline case-fold staying darwin-blind after Step 11, and
  `src/tools/list.ts:95-103`'s matching `suppressErrors` gap from Step 8.
- Step ordering has no cross-step dependency — all 13 touch disjoint (or,
  for Steps 7/11, deliberately paired) files and can be worked in any order;
  the numbering above is severity-then-file-locality, not a build
  requirement.
- This plan has no companion `<name>.hunt.md` — the source bug hunt ran
  entirely in-chat this session (no `docs/plan/` effort directory existed
  yet when it ran), so its findings are inlined directly into
  [Current state](#current-state) above instead of linked.

## Handoff

13 steps across 15 files — above the "≤2 files, no ordering constraint"
threshold for going straight to `run-plan`. Hand this to `plan-hunt` (a blind
refuter kills dead steps cheaper than `run-plan` discovers them) before
execution.
