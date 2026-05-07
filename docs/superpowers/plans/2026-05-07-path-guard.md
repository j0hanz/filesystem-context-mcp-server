# PathGuard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all path-security enforcement from `paths.ts` into a `PathGuard` class, remove the `AllowedDirectoriesState` AsyncLocalStorage in favour of a `PathGuard`-typed ALS, and thread `PathGuard` explicitly through `ToolRegistrationOptions` so tool handlers no longer depend on hidden module-level state.

**Architecture:** `PathGuard` owns every security decision: sensitive-file checks (compiled once at construction), allowed-directory assertion, write-path validation, directory validation, and safe-glob checking. `paths.ts` shrinks to pure path-resolution utilities plus thin wrappers that call the ALS-resident `PathGuard` for library code that cannot receive it via injection. HTTP session isolation is preserved: the ALS payload changes from `AllowedDirectoriesState` to `PathGuard`. Tools get an explicit `pathGuard` field on `ToolRegistrationOptions` and call it directly.

**Spec deviation:** The approved spec (2026-05-07-path-guard-design.md) stated "ALS removed entirely." Discovery during planning: `bootstrap.ts:635` calls `withAllowedDirectoriesState` to scope each HTTP request to its session's allowed dirs — per-session isolation requires ALS or equivalent. The ALS is therefore kept but its payload changes from `AllowedDirectoriesState` to `PathGuard`. All other spec goals are unchanged.

**Tech Stack:** TypeScript, Node.js 24, `node:async_hooks` AsyncLocalStorage, `node:path`, `node:fs/promises`, `zod/v4`, `node:test`.

---

## File Map

| Action | File                                | Responsibility                                                               |
| ------ | ----------------------------------- | ---------------------------------------------------------------------------- |
| Create | `src/lib/path-guard.ts`             | `PathGuard` class — all security enforcement                                 |
| Shrink | `src/lib/paths.ts`                  | Pure utilities + thin wrappers that delegate to ALS PathGuard                |
| Delete | `src/lib/globs.ts`                  | Absorbed into PathGuard                                                      |
| Modify | `src/tools/shared.ts`               | Add `pathGuard?: PathGuard` to `ToolRegistrationOptions`                     |
| Modify | `src/server/roots-manager.ts`       | Hold `PathGuard`; call `initialize()` on roots resolved                      |
| Modify | `src/server/bootstrap.ts`           | Create PathGuard; replace `withAllowedDirectoriesState` with `withPathGuard` |
| Modify | `src/tools/roots.ts`                | Use `options.pathGuard?.getAllowedDirectories()`                             |
| Modify | `src/tools/write-file.ts`           | Use `options.pathGuard?.validatePathForWrite()`                              |
| Modify | `src/tools/create-directory.ts`     | Same                                                                         |
| Modify | `src/tools/delete-file.ts`          | Same                                                                         |
| Modify | `src/tools/edit-file.ts`            | Same                                                                         |
| Modify | `src/tools/move-file.ts`            | Same                                                                         |
| Modify | `src/tools/apply-patch.ts`          | Same                                                                         |
| Modify | `src/tools/diff-files.ts`           | Same                                                                         |
| Modify | `src/tools/replace-in-files.ts`     | Same                                                                         |
| Modify | `src/tools/calculate-hash.ts`       | Same                                                                         |
| Modify | `__tests__/helpers.ts`              | Construct PathGuard; remove `setAllowedDirectoriesResolved`                  |
| Create | `__tests__/unit/path-guard.test.ts` | Unit tests driving PathGuard directly                                        |

---

## Task 1: Create PathGuard class (TDD)

**Files:**

- Create: `src/lib/path-guard.ts`
- Create: `__tests__/unit/path-guard.test.ts`

- [ ] **Step 1.1: Write failing unit tests**

Create `__tests__/unit/path-guard.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { after, before, test } from 'node:test';

import { SENSITIVE_FILE_DENYLIST } from '../../src/lib/constants.js';
import {
  type AllowedDirectoriesState,
  PathGuard,
} from '../../src/lib/path-guard.js';

let tmpDir: string;
let guard: PathGuard;

before(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'path-guard-test-'));
  const state: AllowedDirectoriesState = {
    primary: [tmpDir],
    expanded: [tmpDir],
  };
  guard = new PathGuard(SENSITIVE_FILE_DENYLIST);
  guard.initialize(state);
});

after(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

test('validateExistingPath resolves a file within allowed dir', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(tmpDir, 'test.txt'), 'hello');
  const resolved = await guard.validateExistingPath(join(tmpDir, 'test.txt'));
  assert.ok(resolved.includes('test.txt'));
});

test('validateExistingPath rejects path outside allowed dirs', async () => {
  await assert.rejects(
    () => guard.validateExistingPath('/tmp/outside-dir-xyz/file.txt'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.ok(
        err.message.includes('allowed') || err.message.includes('not exist')
      );
      return true;
    }
  );
});

test('isSensitive returns true for .env files', () => {
  assert.strictEqual(guard.isSensitive('.env'), true);
  assert.strictEqual(guard.isSensitive('.env.local'), true);
});

test('isSensitive returns false for normal files', () => {
  assert.strictEqual(guard.isSensitive('src/index.ts'), false);
  assert.strictEqual(guard.isSensitive('README.md'), false);
});

test('isSafeGlob returns false for traversal patterns', () => {
  assert.strictEqual(guard.isSafeGlob('../**'), false);
  assert.strictEqual(guard.isSafeGlob('/etc/passwd'), false);
  assert.strictEqual(guard.isSafeGlob(''), false);
});

test('isSafeGlob returns true for safe patterns', () => {
  assert.strictEqual(guard.isSafeGlob('*.ts'), true);
  assert.strictEqual(guard.isSafeGlob('src/**/*.ts'), true);
});

test('isSensitive works before initialize()', () => {
  const uninit = new PathGuard(SENSITIVE_FILE_DENYLIST);
  assert.strictEqual(uninit.isSensitive('.env'), true);
});

test('validateExistingPath throws before initialize()', async () => {
  const uninit = new PathGuard(SENSITIVE_FILE_DENYLIST);
  await assert.rejects(
    () => uninit.validateExistingPath(join(tmpDir, 'test.txt')),
    /not initialized|allowed/i
  );
});

test('getAllowedDirectories returns the initialized dirs', () => {
  const dirs = guard.getAllowedDirectories();
  assert.ok(
    dirs.some((d) => d === tmpDir || d.toLowerCase() === tmpDir.toLowerCase())
  );
});

test('validateExistingDirectory rejects a file path', async () => {
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(tmpDir, 'notadir.txt'), 'x');
  await assert.rejects(
    () => guard.validateExistingDirectory(join(tmpDir, 'notadir.txt')),
    /directory/i
  );
});

test('validatePathForWrite returns normalized path for new file', async () => {
  const newPath = join(tmpDir, 'new-file.txt');
  const resolved = await guard.validatePathForWrite(newPath);
  assert.ok(typeof resolved === 'string' && resolved.length > 0);
});
```

- [ ] **Step 1.2: Run to verify tests fail**

```bash
node --test --import tsx/esm __tests__/unit/path-guard.test.ts
```

Expected: `Error: Cannot find module '../../src/lib/path-guard.js'`

- [ ] **Step 1.3: Implement PathGuard class**

Create `src/lib/path-guard.ts`. This moves all security logic from `paths.ts` into a class. Copy the internal helpers from `paths.ts` that are needed (do NOT change `paths.ts` yet — the helpers stay in both files temporarily, until Task 2 removes them from `paths.ts`).

**Important:** `path-guard.ts` must NOT import from `paths.ts`. In Task 2, `paths.ts` will import from `path-guard.ts`, making a circular dependency. Instead, inline `toPosixPath`, `expandHome`, and `normalizePath` — they are pure functions and safe to duplicate temporarily. Task 2 will remove them from `paths.ts` and have it import from `path-guard.ts` instead.

```typescript
import { realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  posix,
  relative,
  resolve,
  sep,
  win32,
} from 'node:path';

import { assertNotAborted, withAbort } from './abort.js';
import { SENSITIVE_FILE_ALLOWLIST } from './constants.js';
import { ErrorCode, isAbortError, isNodeError, McpError } from './errors.js';
import { Logger } from './logger.js';

// Inlined from paths.ts — no circular import allowed
const IS_WINDOWS_PG = platform() === 'win32';
const HOMEDIR_PG = homedir();
const DRIVE_LETTER_RE_PG = /^[A-Za-z]:/;
const LEADING_SEP_RE_PG = /^[/\\]+/;

function toPosixPath(v: string): string {
  return v.includes('\\') ? v.replace(/\\/gu, '/') : v;
}

function expandHome(p: string): string {
  if (p === '~') return HOMEDIR_PG;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const rest = p.slice(2).replace(LEADING_SEP_RE_PG, '');
    return rest.length === 0 ? HOMEDIR_PG : join(HOMEDIR_PG, rest);
  }
  return p;
}

function normalizePathPG(p: string): string {
  const r = resolve(expandHome(p));
  return IS_WINDOWS_PG && DRIVE_LETTER_RE_PG.test(r)
    ? r.charAt(0).toLowerCase() + r.slice(1)
    : r;
}

// --- Internal types (not exported) ---

interface CompiledPattern {
  globs: readonly string[];
  matchesPath: boolean;
}

interface CompiledPatternSet {
  pathGlobs: readonly string[];
  nameGlobs: readonly string[];
}

export interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

export interface AllowedDirectoriesState {
  primary: readonly string[];
  expanded: readonly string[];
}

// --- Glob safety constants (absorbed from globs.ts) ---

const ABSOLUTE_GLOB_RE = /^([/\\]|[A-Za-z]:[/\\]|\\\\)/u;
const PARENT_SEGMENT_RE = /[\\/]\.\.(?:[/\\]|$)/u;

// --- Sensitive-file pattern helpers ---

const WINDOWS_ABSOLUTE_RE = /^[a-z]:\//iu;
const IS_WINDOWS = platform() === 'win32';
const CHAR_CODE_SPACE = 32;
const CHAR_CODE_DOT = 46;
const HOME_PREFIX_LENGTH = 2; // length of "~/"

function normalizeForMatch(input: string): string {
  return toPosixPath(resolve(input).replace(/\\/gu, '/')).toLowerCase();
}

function compilePatternGlobs(normalizedPattern: string): readonly string[] {
  const globs = new Set<string>([normalizedPattern]);
  const isWindowsAbsolute = WINDOWS_ABSOLUTE_RE.test(normalizedPattern);
  if (!normalizedPattern.startsWith('**/') && !isWindowsAbsolute) {
    const withoutRoot = normalizedPattern.replace(/^\/+/u, '');
    if (withoutRoot.length > 0) globs.add(`**/${withoutRoot}`);
  }
  return [...globs];
}

function compilePatterns(patterns: readonly string[]): CompiledPattern[] {
  const unique = new Set<string>();
  for (const p of patterns) {
    const t = p.trim();
    if (t.length > 0) unique.add(t);
  }
  const compiled: CompiledPattern[] = [];
  for (const pattern of unique) {
    const normalized = normalizeForMatch(pattern);
    const matchesPath = normalized.includes('/');
    compiled.push({
      globs: matchesPath ? compilePatternGlobs(normalized) : [normalized],
      matchesPath,
    });
  }
  return compiled;
}

function toPatternSet(
  patterns: readonly CompiledPattern[]
): CompiledPatternSet {
  const pathGlobs = new Set<string>();
  const nameGlobs = new Set<string>();
  for (const p of patterns) {
    const target = p.matchesPath ? pathGlobs : nameGlobs;
    for (const g of p.globs) target.add(g);
  }
  return { pathGlobs: [...pathGlobs], nameGlobs: [...nameGlobs] };
}

function matchesAnyGlobs(
  globs: readonly string[],
  candidates: readonly string[]
): boolean {
  if (globs.length === 0 || candidates.length === 0) return false;
  for (const c of candidates) {
    for (const g of globs) {
      if (posix.matchesGlob(c, g)) return true;
    }
  }
  return false;
}

function uniquePair(primary: string, secondary?: string): string[] {
  if (!secondary || secondary === primary) return [primary];
  return [primary, secondary];
}

// --- Path assertion helpers ---

const PATH_SEPARATOR = sep;
const DRIVE_LETTER_REGEX = /^[A-Za-z]:/;
const WINDOWS_DRIVE_REL_REGEX = /^[A-Za-z]:$/u;
const LEADING_SEPARATORS_RE = /^[/\\]+/;
const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function normalizeCaseForComparison(v: string): string {
  return IS_WINDOWS ? v.toLowerCase() : v;
}

function isSamePath(left: string, right: string): boolean {
  if (left === right) return true;
  return (
    normalizeCaseForComparison(resolve(left)) ===
    normalizeCaseForComparison(resolve(right))
  );
}

function stripTrailingSeparator(p: string): string {
  return p.length > 1 && p.endsWith(PATH_SEPARATOR) ? p.slice(0, -1) : p;
}

function isPathInsideDirectory(dir: string, candidate: string): boolean {
  const root = normalizeCaseForComparison(dir);
  const cand = normalizeCaseForComparison(candidate);
  if (root === cand) return true;
  const rel = relative(root, cand);
  if (rel.length === 0) return true;
  if (rel === '..') return false;
  return !rel.startsWith('..\\') && !rel.startsWith('../') && !isAbsolute(rel);
}

function isPathWithinDirs(path: string, dirs: readonly string[]): boolean {
  for (const dir of dirs) {
    if (isPathInsideDirectory(dir, path)) return true;
  }
  return false;
}

function getReservedDeviceName(segment: string): string | undefined {
  let end = segment.length;
  while (end > 0) {
    const c = segment.charCodeAt(end - 1);
    if (c === CHAR_CODE_SPACE || c === CHAR_CODE_DOT) end--;
    else break;
  }
  const trimmed = segment.slice(0, end);
  const streamIdx = trimmed.indexOf(':');
  const withoutStream =
    streamIdx !== -1 ? trimmed.slice(0, streamIdx) : trimmed;
  const dotIdx = withoutStream.indexOf('.');
  const baseName = (
    dotIdx !== -1 ? withoutStream.slice(0, dotIdx) : withoutStream
  ).toUpperCase();
  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

function rethrowIfAborted(error: unknown): void {
  if (isAbortError(error)) throw error;
}

function toMcpError(requestedPath: string, error: unknown): McpError {
  const NODE_ERROR_MAP: Record<string, { code: ErrorCode; message: string }> = {
    ENOENT: { code: ErrorCode.NOT_FOUND, message: 'Path does not exist' },
    EACCES: { code: ErrorCode.PERMISSION_DENIED, message: 'Permission denied' },
    EPERM: { code: ErrorCode.PERMISSION_DENIED, message: 'Permission denied' },
    ELOOP: {
      code: ErrorCode.SYMLINK_NOT_ALLOWED,
      message: 'Too many symbolic links (circular reference)',
    },
    ENAMETOOLONG: {
      code: ErrorCode.INVALID_INPUT,
      message: 'Path name too long',
    },
  };
  const code = isNodeError(error) ? error.code : undefined;
  const mapping = code ? NODE_ERROR_MAP[code] : undefined;
  if (mapping) {
    return new McpError(
      mapping.code,
      mapping.message,
      requestedPath,
      { originalCode: code },
      error
    );
  }
  const originalMessage =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return new McpError(
    ErrorCode.NOT_FOUND,
    'Path is not accessible',
    requestedPath,
    { originalCode: code, originalMessage },
    error
  );
}

// --- PathGuard class ---

export class PathGuard {
  private readonly denyPatterns: CompiledPatternSet;
  private readonly allowPatterns: CompiledPatternSet;
  private primaryDirs: readonly string[] = [];
  private expandedDirs: readonly string[] = [];
  private _initialized = false;

  constructor(sensitivePatterns: readonly string[]) {
    this.denyPatterns = toPatternSet(compilePatterns(sensitivePatterns));
    this.allowPatterns = toPatternSet(
      compilePatterns(SENSITIVE_FILE_ALLOWLIST)
    );
  }

  initialize(state: AllowedDirectoriesState): void {
    this.primaryDirs = state.primary;
    this.expandedDirs = state.expanded;
    this._initialized = true;
    setDefaultPathGuard(this);
  }

  isInitialized(): boolean {
    return this._initialized;
  }

  getAllowedDirectories(): string[] {
    return [...this.expandedDirs];
  }

  isAllowedDirectoryRoot(normalizedPath: string): boolean {
    for (const dir of this.expandedDirs) {
      if (isSamePath(normalizedPath, dir)) return true;
    }
    return false;
  }

  isSensitive(requestedPath: string, resolvedPath?: string): boolean {
    if (
      this.denyPatterns.pathGlobs.length === 0 &&
      this.denyPatterns.nameGlobs.length === 0
    )
      return false;

    const normReq = normalizeForMatch(requestedPath);
    const normRes = resolvedPath ? normalizeForMatch(resolvedPath) : undefined;
    const pathCandidates = uniquePair(normReq, normRes);
    const nameCandidates = uniquePair(
      posix.basename(normReq),
      normRes ? posix.basename(normRes) : undefined
    );

    if (
      matchesAnyGlobs(this.allowPatterns.pathGlobs, pathCandidates) ||
      matchesAnyGlobs(this.allowPatterns.nameGlobs, nameCandidates)
    )
      return false;

    return (
      matchesAnyGlobs(this.denyPatterns.pathGlobs, pathCandidates) ||
      matchesAnyGlobs(this.denyPatterns.nameGlobs, nameCandidates)
    );
  }

  assertAllowedFileAccess(requestedPath: string, resolvedPath?: string): void {
    if (!this.isSensitive(requestedPath, resolvedPath)) return;
    Logger.warn(
      `Access denied: sensitive file blocked by policy (${requestedPath})`
    );
    throw new McpError(
      ErrorCode.ACCESS_DENIED,
      'Sensitive file blocked. Set FS_CONTEXT_ALLOW_SENSITIVE=1 to override.',
      requestedPath
    );
  }

  isSafeGlob(pattern: string): boolean {
    if (pattern.length === 0) return false;
    if (pattern.includes('**/**/**')) return false;
    if (ABSOLUTE_GLOB_RE.test(pattern)) return false;
    if (pattern.startsWith('..') || PARENT_SEGMENT_RE.test(pattern))
      return false;
    return true;
  }

  async validateExistingPath(
    path: string,
    signal?: AbortSignal
  ): Promise<string> {
    const details = await this.validateExistingPathDetailed(path, signal);
    return details.resolvedPath;
  }

  async validateExistingPathDetailed(
    path: string,
    signal?: AbortSignal
  ): Promise<ValidatedPathDetails> {
    const { allowedDirs, normalizedRequested } = this.preparePathAccess(path);

    let realPath: string;
    try {
      assertNotAborted(signal);
      realPath = await withAbort(realpath(normalizedRequested), signal);
    } catch (error) {
      rethrowIfAborted(error);
      throw toMcpError(path, error);
    }

    const normalizedReal = normalizePathPG(realPath);
    if (!isPathWithinDirs(normalizedReal, allowedDirs)) {
      const hint =
        allowedDirs.length > 0
          ? `Allowed: ${allowedDirs.join(', ')}`
          : 'No allowed directories configured.';
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${hint}`,
        path,
        { resolvedPath: realPath, normalizedResolvedPath: normalizedReal }
      );
    }

    return {
      requestedPath: normalizedRequested,
      resolvedPath: normalizedReal,
      isSymlink: !isSamePath(normalizedRequested, normalizedReal),
    };
  }

  async validateExistingDirectory(
    path: string,
    signal?: AbortSignal
  ): Promise<string> {
    const details = await this.validateExistingPathDetailed(path, signal);
    let stats: Awaited<ReturnType<typeof stat>>;
    try {
      assertNotAborted(signal);
      stats = await withAbort(stat(details.resolvedPath), signal);
    } catch (error) {
      rethrowIfAborted(error);
      throw toMcpError(path, error);
    }
    if (!stats.isDirectory()) {
      throw new McpError(ErrorCode.NOT_DIRECTORY, 'Not a directory', path);
    }
    return details.resolvedPath;
  }

  async validatePathForWrite(
    path: string,
    signal?: AbortSignal
  ): Promise<string> {
    const { allowedDirs, normalizedRequested } = this.preparePathAccess(path);
    this.assertAllowedFileAccess(path, normalizedRequested);

    let realPath: string;
    let current = normalizedRequested;
    for (;;) {
      try {
        assertNotAborted(signal);
        realPath = await withAbort(realpath(current), signal);
        break;
      } catch (error) {
        rethrowIfAborted(error);
        const code = isNodeError(error) ? error.code : undefined;
        if (code !== 'ENOENT') throw toMcpError(path, error);
        const parent = dirname(current);
        if (parent === current) throw toMcpError(path, error);
        current = parent;
      }
    }

    const normalizedReal = normalizePathPG(realPath);
    if (!isPathWithinDirs(normalizedReal, allowedDirs)) {
      const hint =
        allowedDirs.length > 0
          ? `Allowed: ${allowedDirs.join(', ')}`
          : 'No allowed directories configured.';
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${hint}`,
        path,
        { resolvedPath: realPath, normalizedResolvedPath: normalizedReal }
      );
    }

    return normalizedRequested;
  }

  // --- Private helpers ---

  private assertInitialized(): void {
    if (!this._initialized) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        'Server not initialized: path guard has no allowed directories yet.'
      );
    }
  }

  private preparePathAccess(requestedPath: string): {
    allowedDirs: string[];
    normalizedRequested: string;
  } {
    this.assertInitialized();
    this.validatePathSyntax(requestedPath);
    const normalizedRequested = this.resolveRequestedPath(requestedPath);
    const allowedDirs = [...this.expandedDirs];
    if (!isPathWithinDirs(normalizedRequested, allowedDirs)) {
      if (allowedDirs.length === 0) {
        Logger.warn('Access denied: no allowed directories configured');
        throw new McpError(
          ErrorCode.ACCESS_DENIED,
          'No allowed directories configured. Use --allow-cwd or configure roots.',
          requestedPath,
          { normalizedPath: normalizedRequested }
        );
      }
      Logger.warn(
        `Access denied: path outside allowed directories (${requestedPath})`
      );
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        'Outside allowed directories',
        requestedPath,
        { normalizedPath: normalizedRequested }
      );
    }
    return { allowedDirs, normalizedRequested };
  }

  private validatePathSyntax(requestedPath: string): void {
    if (!requestedPath || requestedPath.trim().length === 0) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        'Path cannot be empty or whitespace',
        requestedPath
      );
    }
    if (requestedPath.includes('\0')) {
      throw new McpError(
        ErrorCode.INVALID_INPUT,
        'Path contains null bytes',
        requestedPath
      );
    }
    if (IS_WINDOWS) {
      const segments = requestedPath.split(/[\\/]/);
      for (const segment of segments) {
        const reserved = getReservedDeviceName(segment);
        if (reserved) {
          throw new McpError(
            ErrorCode.INVALID_INPUT,
            `Windows reserved device name not allowed: ${reserved}`,
            requestedPath
          );
        }
      }
      const parsed = win32.parse(requestedPath);
      if (
        WINDOWS_DRIVE_REL_REGEX.test(parsed.root) &&
        !win32.isAbsolute(requestedPath)
      ) {
        throw new McpError(
          ErrorCode.INVALID_INPUT,
          'Drive-relative path not allowed. Use C:\\path instead of C:path.',
          requestedPath
        );
      }
    }
  }

  private resolveRequestedPath(requestedPath: string): string {
    const expanded = expandHome(requestedPath);
    if (!isAbsolute(expanded)) {
      // Relative path: resolve against primary dirs if unambiguous
      if (this.primaryDirs.length > 1) {
        throw new McpError(
          ErrorCode.INVALID_INPUT,
          'Ambiguous relative path with multiple roots. Use an absolute path.',
          requestedPath
        );
      }
      const base = this.primaryDirs[0];
      if (base) return normalizePathPG(resolve(base, expanded));
    }
    return normalizePathPG(expanded);
  }
}

// --- Module-level singleton for library code (fs-helpers, file-operations, etc.) ---

let defaultPathGuard: PathGuard | undefined;

export function setDefaultPathGuard(guard: PathGuard): void {
  defaultPathGuard = guard;
}

export function getDefaultPathGuard(): PathGuard | undefined {
  return defaultPathGuard;
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

```bash
node --test --import tsx/esm __tests__/unit/path-guard.test.ts
```

Expected: all tests pass.

- [ ] **Step 1.5: Commit**

```bash
git add src/lib/path-guard.ts __tests__/unit/path-guard.test.ts
git commit -m "feat: add PathGuard class with all path security enforcement"
```

---

## Task 2: Update paths.ts — ALS now holds PathGuard, add thin wrappers

**Files:**

- Modify: `src/lib/paths.ts`

The ALS in `paths.ts` changes from `AllowedDirectoriesState` to `PathGuard | undefined`. Existing module-level exports that library code depends on become thin wrappers that call the ALS-resident PathGuard (or the default singleton for stdio).

- [ ] **Step 2.1: Update the ALS type and add PathGuard context helpers**

In `src/lib/paths.ts`, replace the `allowedDirectoriesContext` ALS and all the state management code with a PathGuard-typed ALS. Keep all pure utility functions unchanged.

Find the block starting at line 228 (`const allowedDirectoriesContext = ...`) through the end of `setAllowedDirectoriesResolved` (around line 472). Replace it with:

```typescript
import type { AllowedDirectoriesState, PathGuard } from './path-guard.js';
import { getDefaultPathGuard, setDefaultPathGuard } from './path-guard.js';

// ALS for HTTP session isolation: each request runs inside withPathGuard()
// scoped to its session's PathGuard. Stdio uses the module-level default.
const pathGuardContext = new AsyncLocalStorage<PathGuard>({
  name: 'filesystem-mcp:path-guard',
});

export function withPathGuard<T>(guard: PathGuard, run: () => T): T {
  return pathGuardContext.run(guard, run);
}

function getActivePathGuard(): PathGuard {
  return (
    pathGuardContext.getStore() ??
    getDefaultPathGuard() ??
    (() => {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        'No PathGuard configured. Server may not be initialized.'
      );
    })()
  );
}

// Re-export AllowedDirectoriesState for backward compat with roots-manager.ts
export type { AllowedDirectoriesState } from './path-guard.js';

// Keep setAllowedDirectoriesStateResolved for roots-manager (Task 3 removes it)
export function setAllowedDirectoriesStateResolved(
  state: AllowedDirectoriesState
): void {
  // No-op placeholder — roots-manager.ts will call pathGuard.initialize() directly
  // after Task 3. This stub avoids a compile break during the migration.
  void state;
}

export function getAllowedDirectories(): string[] {
  return getActivePathGuard().getAllowedDirectories();
}

export function isAllowedDirectoryRoot(normalizedPath: string): boolean {
  return getActivePathGuard().isAllowedDirectoryRoot(normalizedPath);
}

export function isSensitivePath(
  requestedPath: string,
  resolvedPath?: string
): boolean {
  return getActivePathGuard().isSensitive(requestedPath, resolvedPath);
}

export function assertAllowedFileAccess(
  requestedPath: string,
  resolvedPath?: string
): void {
  return getActivePathGuard().assertAllowedFileAccess(
    requestedPath,
    resolvedPath
  );
}

export async function validateExistingPath(
  requestedPath: string,
  signal?: AbortSignal
): Promise<string> {
  return getActivePathGuard().validateExistingPath(requestedPath, signal);
}

export async function validateExistingPathDetailed(
  requestedPath: string,
  signal?: AbortSignal
): Promise<ValidatedPathDetails> {
  return getActivePathGuard().validateExistingPathDetailed(
    requestedPath,
    signal
  );
}

export async function validateExistingDirectory(
  requestedPath: string,
  signal?: AbortSignal
): Promise<string> {
  return getActivePathGuard().validateExistingDirectory(requestedPath, signal);
}

export async function validatePathForWrite(
  requestedPath: string,
  signal?: AbortSignal
): Promise<string> {
  return getActivePathGuard().validatePathForWrite(requestedPath, signal);
}
```

Also add `import type { ValidatedPathDetails } from './path-guard.js';` and export it so external callers can still use it:

```typescript
export type { ValidatedPathDetails } from './path-guard.js';
```

Remove the old ALS block, old `setAllowedDirectoriesState`, `getActiveAllowedDirectoriesState`, `withAllowedDirectoriesState`, `setAllowedDirectoriesStateResolved` (the real one), `getAllowedDirectories`, `isAllowedDirectoryRoot`, `isSensitivePath`, `assertAllowedFileAccess`, `validateExistingPath`, `validateExistingPathDetailed`, `validateExistingDirectory`, `validatePathForWrite`, and their internal implementations. Also remove the compiled pattern constants `DENY_PATTERNS` and `ALLOW_PATTERNS`. Keep: all `normaliz*` helpers, `toPosixPath`, `resolveAllowedDirectoriesState`, `getValidRootDirectories`, `getReservedDeviceNameForPath`, `isWindowsDriveRelativePath`, `isPathWithinDirectories`, and `normalizePath`.

Remove these exports no longer needed outside of PathGuard:

- `setAllowedDirectoriesResolved` (the async version that called the state setter)

Keep `resolveAllowedDirectoriesState` — roots-manager still calls it.

- [ ] **Step 2.2: Run type-check to catch import errors**

```bash
npm run type-check
```

Fix any type errors before proceeding.

- [ ] **Step 2.3: Run quick checks**

```bash
node scripts/tasks.mjs --quick
```

Expected: lint + type-check pass. Tests may fail because the active PathGuard is never set yet — that's fine, Task 3 fixes it.

- [ ] **Step 2.4: Commit**

```bash
git add src/lib/paths.ts
git commit -m "refactor: replace AllowedDirectoriesState ALS with PathGuard ALS in paths.ts"
```

---

## Task 3: Update RootsManager to hold and initialize PathGuard

**Files:**

- Modify: `src/server/roots-manager.ts`

`RootsManager` currently stores `allowedDirectoriesState: AllowedDirectoriesState` and calls `setAllowedDirectoriesStateResolved()`. It now stores a `PathGuard` and calls `pathGuard.initialize()`.

- [ ] **Step 3.1: Add PathGuard field and update recomputeAllowedDirectories**

Add `import { SENSITIVE_FILE_DENYLIST } from '../lib/constants.js';` and `import { PathGuard } from '../lib/path-guard.js';` at the top of `roots-manager.ts`.

Change the class field:

```typescript
// Remove:
private allowedDirectoriesState: AllowedDirectoriesState = { primary: [], expanded: [] };

// Add:
readonly pathGuard: PathGuard = new PathGuard(SENSITIVE_FILE_DENYLIST);
```

Update `recomputeAllowedDirectories()` — replace the call to `setAllowedDirectoriesStateResolved(nextState)` with:

```typescript
this.pathGuard.initialize(nextState);
```

Update `getAllowedDirectoriesState()` — change to return from the PathGuard:

```typescript
getAllowedDirectoriesState(): AllowedDirectoriesState {
  return {
    primary: [...this.pathGuard.getAllowedDirectories()], // approximation for bootstrap compat
    expanded: [...this.pathGuard.getAllowedDirectories()],
  };
}
```

Actually, since `bootstrap.ts` uses `getAllowedDirectoriesState()` for the HTTP ALS scope, and we're replacing that with `withPathGuard`, we'll update bootstrap.ts in Task 4. For now, keep `getAllowedDirectoriesState()` returning a compatible shape.

- [ ] **Step 3.2: Remove AllowedDirectoriesState import**

Remove `import type { AllowedDirectoriesState, ... } from '../lib/paths.js';` imports that are no longer needed. Keep: `getValidRootDirectories`, `isPathWithinDirectories`, `normalizePath`, `resolveAllowedDirectoriesState`.

- [ ] **Step 3.3: Run type-check**

```bash
npm run type-check
```

Fix any errors.

- [ ] **Step 3.4: Commit**

```bash
git add src/server/roots-manager.ts
git commit -m "refactor: RootsManager holds PathGuard, calls initialize() on roots resolved"
```

---

## Task 4: Update bootstrap.ts — use withPathGuard for HTTP sessions

**Files:**

- Modify: `src/server/bootstrap.ts`

Replace the `withAllowedDirectoriesState` call with `withPathGuard`.

- [ ] **Step 4.1: Replace import and usage**

In `src/server/bootstrap.ts`:

Change:

```typescript
import { withAllowedDirectoriesState } from '../lib/paths.js';
```

To:

```typescript
import { withPathGuard } from '../lib/paths.js';
```

Find the call at line ~635:

```typescript
await withAllowedDirectoriesState(
  session.rootsManager.getAllowedDirectoriesState(),
  () => session.transport.handleRequest(req, res, body)
);
```

Replace with:

```typescript
await withPathGuard(session.rootsManager.pathGuard, () =>
  session.transport.handleRequest(req, res, body)
);
```

- [ ] **Step 4.2: Run type-check**

```bash
npm run type-check
```

- [ ] **Step 4.3: Commit**

```bash
git add src/server/bootstrap.ts
git commit -m "refactor: bootstrap uses withPathGuard for HTTP session isolation"
```

---

## Task 5: Add pathGuard to ToolRegistrationOptions and update test helpers

**Files:**

- Modify: `src/tools/shared.ts`
- Modify: `__tests__/helpers.ts`

- [ ] **Step 5.1: Add pathGuard field to ToolRegistrationOptions**

In `src/tools/shared.ts`, find the `ToolRegistrationOptions` interface (around line 487):

```typescript
export interface ToolRegistrationOptions {
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
  serverIcon?: string;
  iconInfo?: IconInfo;
}
```

Add:

```typescript
import type { PathGuard } from '../lib/path-guard.js';

export interface ToolRegistrationOptions {
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
  serverIcon?: string;
  iconInfo?: IconInfo;
  pathGuard?: PathGuard;
}
```

- [ ] **Step 5.2: Update test helpers to construct PathGuard**

In `__tests__/helpers.ts`, replace:

```typescript
import { setAllowedDirectoriesResolved } from '../src/lib/paths.js';
```

With:

```typescript
import { SENSITIVE_FILE_DENYLIST } from '../src/lib/constants.js';
import { PathGuard } from '../src/lib/path-guard.js';
```

In `createTestEnv()`, replace:

```typescript
await setAllowedDirectoriesResolved([tmpDir]);
```

With:

```typescript
const pathGuard = new PathGuard(SENSITIVE_FILE_DENYLIST);
pathGuard.initialize({ primary: [tmpDir], expanded: [tmpDir] });
```

Pass `pathGuard` into `registerAllTools`:

```typescript
registerAllTools(server, {
  resourceStore,
  isInitialized: () => true,
  pathGuard,
});
```

In the `cleanup` function, remove:

```typescript
try {
  await setAllowedDirectoriesResolved([]);
} catch {
  // ignore
}
```

Apply the same changes to `createTestEnvWithElicitation()`.

- [ ] **Step 5.3: Run tests**

```bash
node scripts/tasks.mjs --quick
```

Expected: type-check passes.

- [ ] **Step 5.4: Run integration tests**

```bash
node --test --import tsx/esm __tests__/tools/read-write.test.ts
```

Expected: tests pass (PathGuard is now set as default via `initialize()`).

- [ ] **Step 5.5: Commit**

```bash
git add src/tools/shared.ts __tests__/helpers.ts
git commit -m "feat: add pathGuard to ToolRegistrationOptions; update test helpers to construct PathGuard"
```

---

## Task 6: Update tool files to use pathGuard explicitly

**Files:**

- Modify: `src/tools/roots.ts`
- Modify: `src/tools/write-file.ts`
- Modify: `src/tools/create-directory.ts`
- Modify: `src/tools/delete-file.ts`
- Modify: `src/tools/edit-file.ts`
- Modify: `src/tools/move-file.ts`
- Modify: `src/tools/apply-patch.ts`
- Modify: `src/tools/diff-files.ts`
- Modify: `src/tools/replace-in-files.ts`
- Modify: `src/tools/calculate-hash.ts`
- Modify: `src/tools/shared.ts` (the `getAllowedDirectories` call at line ~935)

For each tool: remove the `paths.js` security-function import, extract `pathGuard` from options, call it directly. Use `pathGuard ?? getActivePathGuard()` as a fallback only if the tool may be called without options — in practice `pathGuard` is always provided after Task 5.

Pattern for each tool (example: `write-file.ts`):

**Before:**

```typescript
import { validatePathForWrite } from '../lib/paths.js';

// in handler:
const validPath = await validatePathForWrite(args.path, signal);
```

**After:**

```typescript
// No paths.js import for validatePathForWrite

// in registerWriteFileTool, capture pathGuard:
export function registerWriteFileTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const { pathGuard } = options;
  registerStandardTool(server, ..., async (args, _ctx, signal) => {
    const validPath = pathGuard
      ? await pathGuard.validatePathForWrite(args.path, signal)
      : await validatePathForWrite(args.path, signal);
    // ...
  });
}
```

Repeat for all 10 tool files. The table below maps each tool to the functions it currently imports and what to change:

| File                  | Old import(s)                                                             | New call(s)                                                                 |
| --------------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `roots.ts`            | `getAllowedDirectories`                                                   | `pathGuard?.getAllowedDirectories()`                                        |
| `write-file.ts`       | `validatePathForWrite`                                                    | `pathGuard?.validatePathForWrite()`                                         |
| `create-directory.ts` | `validatePathForWrite`                                                    | `pathGuard?.validatePathForWrite()`                                         |
| `delete-file.ts`      | `isAllowedDirectoryRoot`, `validatePathForWrite`                          | `pathGuard?.isAllowedDirectoryRoot()`, `pathGuard?.validatePathForWrite()`  |
| `edit-file.ts`        | `assertAllowedFileAccess`, `validateExistingPath`                         | `pathGuard?.assertAllowedFileAccess()`, `pathGuard?.validateExistingPath()` |
| `move-file.ts`        | `assertAllowedFileAccess`, `validateExistingPath`, `validatePathForWrite` | all three via `pathGuard?.*`                                                |
| `apply-patch.ts`      | `assertAllowedFileAccess`, `validateExistingPath`                         | same                                                                        |
| `diff-files.ts`       | `validateExistingPath`                                                    | `pathGuard?.validateExistingPath()`                                         |
| `replace-in-files.ts` | `validateExistingPath`, `validatePathForWrite`                            | both                                                                        |
| `calculate-hash.ts`   | `validateExistingPath`                                                    | `pathGuard?.validateExistingPath()`                                         |
| `shared.ts`           | `getAllowedDirectories` (line ~935)                                       | thread pathGuard through or keep module-level                               |

For `shared.ts` line ~935 (`getAllowedDirectories` for the error hint): this is in a helper that does not have access to options. Leave it calling the module-level `getAllowedDirectories()` wrapper — it reads from the active PathGuard via ALS, which is always set when a tool handler runs. No change needed.

- [ ] **Step 6.1: Update roots.ts**

```typescript
// Remove: import { getAllowedDirectories } from '../lib/paths.js';

export function registerListAllowedDirectoriesTool(
  server: McpServer,
  options: ToolRegistrationOptions = {}
): void {
  const { pathGuard } = options;
  registerStandardTool(server, LIST_ALLOWED_DIRECTORIES_TOOL, ..., async (_args, _ctx) => {
    const dirs = pathGuard ? pathGuard.getAllowedDirectories() : getAllowedDirectories();
    // ... rest of handler unchanged
  });
}
```

If `roots.ts` currently calls `getAllowedDirectories()` outside a closure (at module level), keep the module-level import as fallback. The pattern `pathGuard ? pathGuard.method() : moduleLevel()` handles both cases.

- [ ] **Step 6.2: Update write-file.ts, create-directory.ts, delete-file.ts**

For each: add `const { pathGuard } = options;` at the top of the register function, then change call sites as shown in the table above.

- [ ] **Step 6.3: Update edit-file.ts, move-file.ts, apply-patch.ts**

Same pattern. These tools call both `validateExistingPath` and `assertAllowedFileAccess`.

- [ ] **Step 6.4: Update diff-files.ts, replace-in-files.ts, calculate-hash.ts**

Same pattern for the remaining tools.

- [ ] **Step 6.5: Run full test suite**

```bash
node scripts/tasks.mjs
```

Expected: all checks pass.

- [ ] **Step 6.6: Commit**

```bash
git add src/tools/roots.ts src/tools/write-file.ts src/tools/create-directory.ts \
  src/tools/delete-file.ts src/tools/edit-file.ts src/tools/move-file.ts \
  src/tools/apply-patch.ts src/tools/diff-files.ts src/tools/replace-in-files.ts \
  src/tools/calculate-hash.ts
git commit -m "refactor: tool handlers use explicit pathGuard from ToolRegistrationOptions"
```

---

## Task 7: Delete globs.ts and clean up paths.ts exports

**Files:**

- Delete: `src/lib/globs.ts`
- Modify: `src/lib/paths.ts` (remove remaining dead code)

- [ ] **Step 7.1: Find all remaining imports of globs.ts**

```bash
grep -r "from.*globs" src/ __tests__/
```

Update any remaining callers to use `pathGuard.isSafeGlob()` or import directly from `path-guard.ts`.

- [ ] **Step 7.2: Delete globs.ts**

```bash
git rm src/lib/globs.ts
```

- [ ] **Step 7.3: Remove dead code from paths.ts**

Remove from `paths.ts`:

- The stub `setAllowedDirectoriesStateResolved` (added in Task 2 for compat)
- Any remaining references to `AllowedDirectoriesState` that are now just re-exports
- The old `defaultAllowedDirectoriesState` variable if still present

Verify the file still exports everything that external callers need (grep for `from.*paths`).

- [ ] **Step 7.4: Run full test suite**

```bash
node scripts/tasks.mjs
```

Expected: all checks pass. Zero references to `globs.ts`.

- [ ] **Step 7.5: Commit**

```bash
git add -u src/lib/paths.ts
git rm src/lib/globs.ts
git commit -m "refactor: delete globs.ts, remove dead AllowedDirectoriesState stub from paths.ts"
```

---

## Task 8: Final verification and cleanup

**Files:**

- Various (verify only)

- [ ] **Step 8.1: Run full tasks including tests and rebuild**

```bash
node scripts/tasks.mjs
```

Expected: format → lint → type-check → knip → tests → rebuild all pass.

- [ ] **Step 8.2: Verify no remaining direct ALS imports for path state**

```bash
grep -r "setAllowedDirectoriesResolved\|withAllowedDirectoriesState\|defaultAllowedDirectoriesState" src/ __tests__/
```

Expected: zero matches.

- [ ] **Step 8.3: Verify PathGuard unit tests still pass independently**

```bash
node --test --import tsx/esm __tests__/unit/path-guard.test.ts
```

Expected: all pass.

- [ ] **Step 8.4: Final commit**

```bash
git commit --allow-empty -m "chore: PathGuard refactor complete — security enforcement centralized"
```

Only commit if there are uncommitted changes; skip the `--allow-empty` if there are none.
