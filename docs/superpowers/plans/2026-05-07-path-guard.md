# PathGuard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract all path-security enforcement from `paths.ts` into a `PathGuard` class, replace the `AllowedDirectoriesState` ALS with a `PathGuard`-typed ALS, and thread `PathGuard` as a **required** field through `ToolRegistrationOptions` so every tool handler calls it directly with no fallbacks.

**Architecture:** `PathGuard` owns every security decision: sensitive-file checks (compiled once at construction), allowed-directory assertion, write-path validation, directory validation, and safe-glob checking. `paths.ts` shrinks to pure path-resolution utilities plus thin wrappers that call the ALS-resident `PathGuard` — needed only by library code (`fs-helpers`, `file-operations/*`) that cannot receive injection. HTTP session isolation is preserved: the ALS payload changes from `AllowedDirectoriesState` to `PathGuard`. Tools get a **required** `pathGuard: PathGuard` field on `ToolRegistrationOptions` and call it directly — no optional chaining, no fallbacks.

**Spec deviation:** The approved spec stated "ALS removed entirely." Discovery during planning: `bootstrap.ts:635` calls `withAllowedDirectoriesState` to scope each HTTP request to its session's allowed dirs — per-session isolation requires ALS or equivalent. The ALS is therefore kept but its payload changes from `AllowedDirectoriesState` to `PathGuard`. All other spec goals are unchanged.

**Tech Stack:** TypeScript, Node.js 24, `node:async_hooks` AsyncLocalStorage, `node:path`, `node:fs/promises`, `node:test`.

---

## File Map

| Action | File                                | Responsibility                                                                                                    |
| ------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Create | `src/lib/path-guard.ts`             | `PathGuard` class — all security enforcement                                                                      |
| Shrink | `src/lib/paths.ts`                  | Pure utilities + thin wrappers that delegate to ALS PathGuard                                                     |
| Delete | `src/lib/globs.ts`                  | Absorbed into PathGuard                                                                                           |
| Modify | `src/server/roots-manager.ts`       | Hold `PathGuard`; call `initialize()` on roots resolved; drop `getAllowedDirectoriesState()`                      |
| Modify | `src/server/bootstrap.ts`           | Replace `withAllowedDirectoriesState` with `withPathGuard`; pass `pathGuard` to tool/resource/prompt registration |
| Modify | `src/tools/shared.ts`               | `pathGuard: PathGuard` required on `ToolRegistrationOptions`                                                      |
| Modify | `src/tools/roots.ts`                | Call `options.pathGuard.getAllowedDirectories()` directly                                                         |
| Modify | `src/tools/write-file.ts`           | Call `options.pathGuard.validatePathForWrite()` directly                                                          |
| Modify | `src/tools/create-directory.ts`     | Same                                                                                                              |
| Modify | `src/tools/delete-file.ts`          | Same                                                                                                              |
| Modify | `src/tools/edit-file.ts`            | Same                                                                                                              |
| Modify | `src/tools/move-file.ts`            | Same                                                                                                              |
| Modify | `src/tools/apply-patch.ts`          | Same                                                                                                              |
| Modify | `src/tools/diff-files.ts`           | Same                                                                                                              |
| Modify | `src/tools/replace-in-files.ts`     | Same                                                                                                              |
| Modify | `src/tools/calculate-hash.ts`       | Same                                                                                                              |
| Modify | `__tests__/helpers.ts`              | Construct `PathGuard`; pass as required; remove `setAllowedDirectoriesResolved`                                   |
| Create | `__tests__/unit/path-guard.test.ts` | Unit tests driving `PathGuard` directly                                                                           |

---

## Task 1: Create PathGuard class (TDD)

**Files:**

- Create: `src/lib/path-guard.ts`
- Create: `__tests__/unit/path-guard.test.ts`

- [ ] **Step 1.1: Write failing unit tests**

Create `__tests__/unit/path-guard.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
  await writeFile(join(tmpDir, 'test.txt'), 'hello');
  const resolved = await guard.validateExistingPath(join(tmpDir, 'test.txt'));
  assert.ok(resolved.includes('test.txt'));
});

test('validateExistingPath rejects path outside allowed dirs', async () => {
  await assert.rejects(
    () => guard.validateExistingPath('/tmp/outside-xyz-impossible/file.txt'),
    (err: unknown) => {
      assert.ok(err instanceof Error);
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
  await writeFile(join(tmpDir, 'notadir.txt'), 'x');
  await assert.rejects(
    () => guard.validateExistingDirectory(join(tmpDir, 'notadir.txt')),
    /directory/i
  );
});

test('validatePathForWrite returns normalized path for new file', async () => {
  const newPath = join(tmpDir, 'new-file.txt');
  const result = await guard.validatePathForWrite(newPath);
  assert.ok(typeof result === 'string' && result.length > 0);
});
```

- [ ] **Step 1.2: Run to verify tests fail**

```bash
node --test --import tsx/esm __tests__/unit/path-guard.test.ts
```

Expected: `Error: Cannot find module '../../src/lib/path-guard.js'`

- [ ] **Step 1.3: Implement PathGuard class**

Create `src/lib/path-guard.ts`. This moves all security logic from `paths.ts` into a class.

**Critical:** `path-guard.ts` must NOT import from `paths.ts`. In Task 3, `paths.ts` will import from `path-guard.ts` — a circular dependency would result. Inline `toPosixPath`, `expandHome`, and `normalizePath` as private utilities. They are pure functions and safe to duplicate; Task 3 removes them from `paths.ts`.

```typescript
import { realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import {
  dirname,
  isAbsolute,
  join,
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

// ─── Inlined path utilities (no import from paths.ts — would be circular) ───

const IS_WINDOWS = platform() === 'win32';
const HOMEDIR = homedir();
const DRIVE_LETTER_RE = /^[A-Za-z]:/;
const LEADING_SEP_RE = /^[/\\]+/;
const PATH_SEPARATOR = sep;

function toPosixPath(v: string): string {
  return v.includes('\\') ? v.replace(/\\/gu, '/') : v;
}

function expandHome(p: string): string {
  if (p === '~') return HOMEDIR;
  if (p.startsWith('~/') || p.startsWith('~\\')) {
    const rest = p.slice(2).replace(LEADING_SEP_RE, '');
    return rest.length === 0 ? HOMEDIR : join(HOMEDIR, rest);
  }
  return p;
}

function normalizePath(p: string): string {
  const r = resolve(expandHome(p));
  return IS_WINDOWS && DRIVE_LETTER_RE.test(r)
    ? r.charAt(0).toLowerCase() + r.slice(1)
    : r;
}

// ─── Internal pattern-matching types ────────────────────────────────────────

interface CompiledPattern {
  globs: readonly string[];
  matchesPath: boolean;
}

interface CompiledPatternSet {
  pathGlobs: readonly string[];
  nameGlobs: readonly string[];
}

// ─── Exported types ──────────────────────────────────────────────────────────

export interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

export interface AllowedDirectoriesState {
  primary: readonly string[];
  expanded: readonly string[];
}

// ─── Glob safety (absorbed from globs.ts) ───────────────────────────────────

const ABSOLUTE_GLOB_RE = /^([/\\]|[A-Za-z]:[/\\]|\\\\)/u;
const PARENT_SEGMENT_RE = /[\\/]\.\.(?:[/\\]|$)/u;

// ─── Sensitive-file helpers ──────────────────────────────────────────────────

const WINDOWS_ABSOLUTE_RE = /^[a-z]:\//iu;

function normalizeForMatch(input: string): string {
  return toPosixPath(normalizePath(input)).toLowerCase();
}

function compilePatternGlobs(normalized: string): readonly string[] {
  const globs = new Set<string>([normalized]);
  if (!normalized.startsWith('**/') && !WINDOWS_ABSOLUTE_RE.test(normalized)) {
    const withoutRoot = normalized.replace(/^\/+/u, '');
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

// ─── Path-assertion helpers ──────────────────────────────────────────────────

const WINDOWS_DRIVE_REL_RE = /^[A-Za-z]:$/u;
const CHAR_CODE_SPACE = 32;
const CHAR_CODE_DOT = 46;
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

function stripTrailingSeparator(p: string): string {
  return p.length > 1 && p.endsWith(PATH_SEPARATOR) ? p.slice(0, -1) : p;
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

// ─── PathGuard class ─────────────────────────────────────────────────────────

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

    const normalizedReal = normalizePath(realPath);
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

    let current = normalizedRequested;
    let realPath: string;
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

    const normalizedReal = normalizePath(realPath);
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

  // ─── Private helpers ───────────────────────────────────────────────────────

  private assertInitialized(): void {
    if (!this._initialized) {
      throw new McpError(
        ErrorCode.ACCESS_DENIED,
        'Server not initialized: path guard has no allowed directories yet.'
      );
    }
  }

  private resolveRequestedPath(requestedPath: string): string {
    const expanded = expandHome(requestedPath);
    if (!isAbsolute(expanded)) {
      if (this.primaryDirs.length > 1) {
        throw new McpError(
          ErrorCode.INVALID_INPUT,
          'Ambiguous relative path with multiple roots. Use an absolute path.',
          requestedPath
        );
      }
      const base = this.primaryDirs[0];
      if (base) {
        const r = resolve(base, expanded);
        return IS_WINDOWS && DRIVE_LETTER_RE.test(r)
          ? r.charAt(0).toLowerCase() + r.slice(1)
          : r;
      }
    }
    return normalizePath(expanded);
  }

  private normalizeAllowedDirectory(dir: string): string {
    const trimmed = dir.trim();
    if (trimmed.length === 0) return '';
    const normalized = normalizePath(trimmed);
    const { root } = require('node:path').parse(normalized);
    if (isSamePath(normalized, root)) return root;
    return normalized.length > 1 && normalized.endsWith(PATH_SEPARATOR)
      ? normalized.slice(0, -1)
      : normalized;
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
      for (const segment of requestedPath.split(/[\\/]/)) {
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
        WINDOWS_DRIVE_REL_RE.test(parsed.root) &&
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
}

// ─── Module-level singleton (set by PathGuard.initialize()) ──────────────────
// Used by library code (fs-helpers, file-operations) that cannot receive
// injection. Set once at startup for stdio; set per-session for HTTP via
// withPathGuard() in paths.ts.

let defaultPathGuard: PathGuard | undefined;

export function setDefaultPathGuard(guard: PathGuard): void {
  defaultPathGuard = guard;
}

export function getDefaultPathGuard(): PathGuard | undefined {
  return defaultPathGuard;
}
```

> **Note on `normalizeAllowedDirectory`:** The `require('node:path').parse` call is a shortcut for illustration. Use `import { parse } from 'node:path'` at the top of the file — `parse` is already available since `node:path` is imported. Remove the `require()` call and use the already-imported `parse` instead.

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

## Task 2: Update RootsManager to hold PathGuard

**Files:**

- Modify: `src/server/roots-manager.ts`

`RootsManager` currently stores `allowedDirectoriesState: AllowedDirectoriesState` and calls `setAllowedDirectoriesStateResolved()`. Replace with a `PathGuard` field and call `pathGuard.initialize()`. Remove `getAllowedDirectoriesState()` — nothing will call it after Task 3 updates bootstrap.ts.

- [ ] **Step 2.1: Add PathGuard field; replace recomputeAllowedDirectories body**

Add these imports at the top of `src/server/roots-manager.ts`:

```typescript
import { SENSITIVE_FILE_DENYLIST } from '../lib/constants.js';
import { PathGuard } from '../lib/path-guard.js';
```

Replace the private field:

```typescript
// Remove:
private allowedDirectoriesState: AllowedDirectoriesState = {
  primary: [],
  expanded: [],
};

// Add:
readonly pathGuard: PathGuard = new PathGuard(SENSITIVE_FILE_DENYLIST);
```

In `recomputeAllowedDirectories()`, replace the last two lines:

```typescript
// Remove:
this.allowedDirectoriesState = nextState;
setAllowedDirectoriesStateResolved(nextState);

// Add:
this.pathGuard.initialize(nextState);
```

Delete the `getAllowedDirectoriesState()` method entirely — it will not be called after Task 3.

- [ ] **Step 2.2: Remove now-unused imports from roots-manager.ts**

Remove from the `paths.js` import: `AllowedDirectoriesState`, `setAllowedDirectoriesStateResolved`. Keep: `getValidRootDirectories`, `isPathWithinDirectories`, `normalizePath`, `resolveAllowedDirectoriesState`.

- [ ] **Step 2.3: Run type-check**

```bash
npm run type-check
```

Expected: the only errors should be in `bootstrap.ts` where it called `getAllowedDirectoriesState()`. Fix in next step or note and continue.

- [ ] **Step 2.4: Commit**

```bash
git add src/server/roots-manager.ts
git commit -m "refactor: RootsManager holds PathGuard, calls initialize() on roots resolved"
```

---

## Task 3: Update paths.ts — ALS payload becomes PathGuard

**Files:**

- Modify: `src/lib/paths.ts`

Replace the `AllowedDirectoriesState` ALS with a `PathGuard`-typed ALS. Remove all security enforcement functions (they now live in `PathGuard`). Keep pure utilities and add thin wrappers for library code.

- [ ] **Step 3.1: Replace the ALS block and security functions**

In `src/lib/paths.ts`, remove:

- The `AsyncLocalStorage<AllowedDirectoriesState>` declaration and its imports
- `cloneAllowedDirectoriesState`, `setAllowedDirectoriesState`, `getActiveAllowedDirectoriesState`
- `withAllowedDirectoriesState`, `setAllowedDirectoriesStateResolved`, `setAllowedDirectoriesResolved`
- `getAllowedDirectories`, `isAllowedDirectoryRoot`
- `isSensitivePath`, `assertAllowedFileAccess`
- `validateExistingPath`, `validateExistingPathDetailed`, `validateExistingDirectory`, `validatePathForWrite`
- `DENY_PATTERNS`, `ALLOW_PATTERNS`, and the pattern-compilation functions
- `defaultAllowedDirectoriesState` module-level variable
- `ValidatedPathDetails` interface (now in `path-guard.ts`)
- `AllowedDirectoriesState` interface (now in `path-guard.ts`)

Remove these no-longer-needed imports from `paths.ts`:

- `AsyncLocalStorage` from `node:async_hooks`
- `SENSITIVE_FILE_ALLOWLIST`, `SENSITIVE_FILE_DENYLIST` from constants

Add at the top of `paths.ts`:

```typescript
import type { PathGuard } from './path-guard.js';
import { getDefaultPathGuard } from './path-guard.js';

export type {
  AllowedDirectoriesState,
  ValidatedPathDetails,
} from './path-guard.js';

// ALS for HTTP session isolation — payload is PathGuard, not raw dirs.
// Each HTTP request runs inside withPathGuard() scoped to its session.
// Stdio reads the default singleton set by PathGuard.initialize().
const pathGuardContext = new AsyncLocalStorage<PathGuard>({
  name: 'filesystem-mcp:path-guard',
});

export function withPathGuard<T>(guard: PathGuard, run: () => T): T {
  return pathGuardContext.run(guard, run);
}

function getActivePathGuard(): PathGuard {
  const guard = pathGuardContext.getStore() ?? getDefaultPathGuard();
  if (!guard) {
    throw new McpError(
      ErrorCode.ACCESS_DENIED,
      'No PathGuard configured. Server may not be initialized.'
    );
  }
  return guard;
}

// Thin wrappers for library code (fs-helpers, file-operations, path-completer)
// that cannot receive PathGuard via injection.
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
  getActivePathGuard().assertAllowedFileAccess(requestedPath, resolvedPath);
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

Note: `AsyncLocalStorage` is still needed (for `pathGuardContext`). Keep the `AsyncLocalStorage` import.

Also remove `toPosixPath` and `normalizePath` from `paths.ts` if they are no longer needed by remaining callers — check with grep first. If other files still import them from `paths.ts`, keep them exported. If not, delete them.

- [ ] **Step 3.2: Remove `ValidatedPathDetails` interface from paths.ts**

It is now defined in `path-guard.ts` and re-exported from `paths.ts` via the type re-export added above.

- [ ] **Step 3.3: Run type-check**

```bash
npm run type-check
```

Fix any errors. The most likely ones: callers that imported `AllowedDirectoriesState` or `ValidatedPathDetails` from `paths.ts` now get them from the re-export (no call-site changes needed). Callers that imported removed functions (e.g. `setAllowedDirectoriesResolved`) will error — remove those call sites.

- [ ] **Step 3.4: Run quick checks**

```bash
node scripts/tasks.mjs --quick
```

Expected: lint + type-check pass.

- [ ] **Step 3.5: Commit**

```bash
git add src/lib/paths.ts
git commit -m "refactor: paths.ts ALS payload is now PathGuard; remove security enforcement functions"
```

---

## Task 4: Update bootstrap.ts — withPathGuard for HTTP sessions

**Files:**

- Modify: `src/server/bootstrap.ts`

Replace the `withAllowedDirectoriesState` call (which no longer exists in paths.ts) with `withPathGuard`. Pass `pathGuard` into tool, resource, and prompt registration.

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

Find `handleSessionTransportRequest` (around line 625). Replace:

```typescript
await withAllowedDirectoriesState(
  session.rootsManager.getAllowedDirectoriesState(),
  () => session.transport.handleRequest(req, res, body)
);
```

With:

```typescript
await withPathGuard(session.rootsManager.pathGuard, () =>
  session.transport.handleRequest(req, res, body)
);
```

- [ ] **Step 4.2: Pass pathGuard to registerAllTools and resource/prompt registration**

Find the call to `registerAllTools` in bootstrap.ts. Add `pathGuard` from the server's `rootsManager`:

```typescript
// Before:
registerAllTools(server, {
  resourceStore,
  isInitialized: () => rootsManager.isInitialized(),
});

// After:
registerAllTools(server, {
  resourceStore,
  isInitialized: () => rootsManager.isInitialized(),
  pathGuard: rootsManager.pathGuard,
});
```

Apply the same addition to any resource or prompt registration calls that accept options.

- [ ] **Step 4.3: Run type-check**

```bash
npm run type-check
```

- [ ] **Step 4.4: Commit**

```bash
git add src/server/bootstrap.ts
git commit -m "refactor: bootstrap uses withPathGuard for HTTP sessions; passes pathGuard to registrations"
```

---

## Task 5: Make pathGuard required on ToolRegistrationOptions; update test helpers

**Files:**

- Modify: `src/tools/shared.ts`
- Modify: `__tests__/helpers.ts`

- [ ] **Step 5.1: Make pathGuard required in ToolRegistrationOptions**

In `src/tools/shared.ts`, find `ToolRegistrationOptions` (around line 487):

```typescript
export interface ToolRegistrationOptions {
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
  serverIcon?: string;
  iconInfo?: IconInfo;
}
```

Add `pathGuard` as a **required** field:

```typescript
import type { PathGuard } from '../lib/path-guard.js';

export interface ToolRegistrationOptions {
  resourceStore?: ResourceStore;
  isInitialized?: () => boolean;
  serverIcon?: string;
  iconInfo?: IconInfo;
  pathGuard: PathGuard;
}
```

- [ ] **Step 5.2: Update test helpers**

In `__tests__/helpers.ts`:

Remove:

```typescript
import { setAllowedDirectoriesResolved } from '../src/lib/paths.js';
```

Add:

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

Update `registerAllTools` call:

```typescript
registerAllTools(server, {
  resourceStore,
  isInitialized: () => true,
  pathGuard,
});
```

Remove from `cleanup`:

```typescript
try {
  await setAllowedDirectoriesResolved([]);
} catch {
  // ignore
}
```

Apply identical changes to `createTestEnvWithElicitation()`.

- [ ] **Step 5.3: Run type-check**

```bash
npm run type-check
```

Fix any call sites that are missing `pathGuard` in their `ToolRegistrationOptions`.

- [ ] **Step 5.4: Run integration tests**

```bash
node --test --import tsx/esm __tests__/tools/read-write.test.ts
```

Expected: all pass.

- [ ] **Step 5.5: Commit**

```bash
git add src/tools/shared.ts __tests__/helpers.ts
git commit -m "feat: pathGuard is required on ToolRegistrationOptions; test helpers construct PathGuard"
```

---

## Task 6: Update tool handlers to call pathGuard directly

**Files:**

- Modify: 10 tool files (see table below)

For each tool: remove the `paths.js` security import, extract `pathGuard` from options, call it directly. No optional chaining, no fallback.

**Pattern (example: `write-file.ts`):**

```typescript
// Remove this import:
import { validatePathForWrite } from '../lib/paths.js';

// In registerWriteFileTool, capture pathGuard:
export function registerWriteFileTool(
  server: McpServer,
  options: ToolRegistrationOptions
): void {
  const { pathGuard } = options;
  registerStandardTool(server, WRITE_FILE_TOOL, ..., async (args, _ctx, signal) => {
    const validPath = await pathGuard.validatePathForWrite(args.path, signal);
    // ... rest unchanged
  });
}
```

**All 10 tool files:**

| File                  | Remove from paths.js import                                               | Replace call with                                                               |
| --------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| `roots.ts`            | `getAllowedDirectories`                                                   | `pathGuard.getAllowedDirectories()`                                             |
| `write-file.ts`       | `validatePathForWrite`                                                    | `pathGuard.validatePathForWrite(...)`                                           |
| `create-directory.ts` | `validatePathForWrite`                                                    | `pathGuard.validatePathForWrite(...)`                                           |
| `delete-file.ts`      | `isAllowedDirectoryRoot`, `validatePathForWrite`                          | `pathGuard.isAllowedDirectoryRoot(...)`, `pathGuard.validatePathForWrite(...)`  |
| `edit-file.ts`        | `assertAllowedFileAccess`, `validateExistingPath`                         | `pathGuard.assertAllowedFileAccess(...)`, `pathGuard.validateExistingPath(...)` |
| `move-file.ts`        | `assertAllowedFileAccess`, `validateExistingPath`, `validatePathForWrite` | all three via `pathGuard.*`                                                     |
| `apply-patch.ts`      | `assertAllowedFileAccess`, `validateExistingPath`                         | `pathGuard.assertAllowedFileAccess(...)`, `pathGuard.validateExistingPath(...)` |
| `diff-files.ts`       | `validateExistingPath`                                                    | `pathGuard.validateExistingPath(...)`                                           |
| `replace-in-files.ts` | `validateExistingPath`, `validatePathForWrite`                            | both via `pathGuard.*`                                                          |
| `calculate-hash.ts`   | `validateExistingPath`                                                    | `pathGuard.validateExistingPath(...)`                                           |

**`shared.ts` (line ~935):** The `getAllowedDirectories()` call inside the error-hint helper has no access to options. This helper runs inside a tool invocation so the ALS PathGuard is always set. Leave it calling the module-level `getAllowedDirectories()` wrapper — that wrapper delegates to `getActivePathGuard()` via ALS. No change needed for that one call.

- [ ] **Step 6.1: Update roots.ts, write-file.ts, create-directory.ts**

For each: remove the paths.js security import, add `const { pathGuard } = options;` at the top of the register function, update call sites per the table.

- [ ] **Step 6.2: Update delete-file.ts, edit-file.ts, move-file.ts**

Same pattern. These touch both existence and write validation.

- [ ] **Step 6.3: Update apply-patch.ts, diff-files.ts, replace-in-files.ts, calculate-hash.ts**

Same pattern for the remaining four.

- [ ] **Step 6.4: Run full test suite**

```bash
node scripts/tasks.mjs
```

Expected: all checks pass.

- [ ] **Step 6.5: Commit**

```bash
git add src/tools/roots.ts src/tools/write-file.ts src/tools/create-directory.ts \
  src/tools/delete-file.ts src/tools/edit-file.ts src/tools/move-file.ts \
  src/tools/apply-patch.ts src/tools/diff-files.ts src/tools/replace-in-files.ts \
  src/tools/calculate-hash.ts
git commit -m "refactor: tool handlers call pathGuard directly; no paths.js security imports"
```

---

## Task 7: Delete globs.ts and remove dead code from paths.ts

**Files:**

- Delete: `src/lib/globs.ts`
- Modify: `src/lib/paths.ts`

- [ ] **Step 7.1: Find remaining globs.ts importers**

```bash
grep -r "from.*globs" src/ __tests__/
```

For each caller: update import to use `pathGuard.isSafeGlob()` (if it has options access) or import `PathGuard` and call from `path-guard.ts` directly.

- [ ] **Step 7.2: Delete globs.ts**

```bash
git rm src/lib/globs.ts
```

- [ ] **Step 7.3: Remove remaining dead code from paths.ts**

Grep for any exports from `paths.ts` that are no longer imported anywhere:

```bash
grep -r "from.*lib/paths" src/ __tests__/ | sort
```

Remove any export from `paths.ts` that nothing imports. Keep whatever remains in active use.

- [ ] **Step 7.4: Run full test suite**

```bash
node scripts/tasks.mjs
```

Expected: all checks pass.

- [ ] **Step 7.5: Commit**

```bash
git add -u src/lib/paths.ts
git rm src/lib/globs.ts
git commit -m "refactor: delete globs.ts; remove unused exports from paths.ts"
```

---

## Task 8: Final verification

- [ ] **Step 8.1: Run full tasks**

```bash
node scripts/tasks.mjs
```

Expected: format → lint → type-check → knip → tests → rebuild all pass.

- [ ] **Step 8.2: Verify no old ALS state exports remain**

```bash
grep -r "setAllowedDirectoriesResolved\|withAllowedDirectoriesState\|AllowedDirectoriesState" src/ __tests__/
```

Expected: only the `AllowedDirectoriesState` type re-export in `paths.ts` and its import in `path-guard.ts` (where it is defined). No function calls to the old pattern.

- [ ] **Step 8.3: Verify PathGuard unit tests pass**

```bash
node --test --import tsx/esm __tests__/unit/path-guard.test.ts
```

Expected: all pass.

- [ ] **Step 8.4: Commit if any uncommitted changes remain**

```bash
git status
# commit any remaining changes
```
