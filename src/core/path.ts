import type { Stats } from 'node:fs';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { timedSignal, withAbort } from './concurrency.js';
import { cli } from './config.js';
import {
  ERRNO_MAP,
  ErrorCode,
  formatUnknownErrorMessage,
  FsError,
  isFsError,
  isNodeError,
  isNotFoundErrno,
  rethrowIfAborted,
  SKIPPABLE_ERRNOS,
  SKIPPABLE_FS_CODES,
} from './errors.js';
import { isSafeGlobSyntax } from './glob.js';
import { Logger } from './observability.js';
import { findProjectRoot, isUnsafeCwdPath, resolveConfiguredDirs } from './path-discovery.js';
import { getReservedDeviceNameForPath, isWindowsDriveRelativePath } from './path-utils.js';
import { IS_WINDOWS, isSlash, parseTrueEnvFlag, toPosixPath } from './primitives.js';
import type { EntryType } from './primitives.js';
import { SensitiveMatcher } from './sensitive.js';
import { ROOTS_TIMEOUT_MS } from './util.js';

export { getReservedDeviceNameForPath, isSafeGlobSyntax, isWindowsDriveRelativePath };

export { IS_WINDOWS, isSlash, toPosixPath, findProjectRoot };

// Allowed-directory assembly and the PathGuard that enforces it. The
// sensitive-file denylist lives in sensitive.ts, and the character-level
// primitives (IS_WINDOWS, isAlpha, isSlash, toPosixPath) live in
// primitives.ts — re-exported here so existing call sites stay unchanged.
declare const ValidatedPathBrand: unique symbol;
export type ValidatedPath = string & { readonly [ValidatedPathBrand]: true };

export interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

export interface ServerOptions {
  allowCwd?: boolean;
  cliAllowedDirs?: string[];
  readOnly?: boolean;
}

async function isRootWithin(
  normalizedRoot: string,
  bounds: readonly string[],
  label: string,
  requireRequestedInside: boolean,
  signal?: AbortSignal,
): Promise<boolean> {
  // Baseline checks the requested path too; a ROOT_BOUNDARY only constrains
  // where the root really resolves to.
  if (requireRequestedInside && !isPathWithinDirectories(normalizedRoot, bounds)) {
    return false;
  }

  try {
    signal?.throwIfAborted();
    const realPath = await withAbort(realpath(normalizedRoot), signal);
    return isPathWithinDirectories(normalizePath(realPath), bounds);
  } catch (error) {
    rethrowIfAborted(error);
    if (isNotFoundErrno(error)) {
      return false;
    }
    Logger.warn(`${label}: realpath failed unexpectedly`, {
      root: normalizedRoot,
      error: String(error),
    });
    return false;
  }
}

async function filterRootsWithin(
  roots: readonly string[],
  bounds: readonly string[],
  label: string,
  requireRequestedInside: boolean,
  signal?: AbortSignal,
): Promise<string[]> {
  const normalizedBounds = normalizeAllowedDirectories(bounds);
  const normalizedRoots = roots.map(normalizePath);
  if (normalizedRoots.length === 0) {
    return [];
  }

  const results = await Promise.allSettled(
    normalizedRoots.map((root) =>
      isRootWithin(root, normalizedBounds, label, requireRequestedInside, signal),
    ),
  );

  return normalizedRoots.filter((root, i) => {
    const result = results[i];
    if (result?.status === 'rejected') {
      Logger.warn(`${label}: root check threw unexpectedly`, {
        root,
        error: String(result.reason),
      });
      return false;
    }
    return result?.status === 'fulfilled' && result.value;
  });
}

const CHAR_COLON = 58;
const HOMEDIR = homedir();
const PATH_SEPARATOR = sep;

/** `path.relative` with forward slashes, so displayed paths match across platforms. */
export function toPosixRelative(from: string, to: string): string {
  return toPosixPath(relative(from, to));
}

function expandHome(filepath: string): string {
  if (filepath === '~' || filepath.startsWith('~/') || filepath.startsWith('~\\')) {
    const rest = filepath.slice(1).replace(/^[/\\]+/, '');
    return rest ? join(HOMEDIR, rest) : HOMEDIR;
  }
  return filepath;
}

export function normalizePath(p: string): string {
  const resolved = resolve(expandHome(p));

  // On Windows only the drive letter is lowercased (e.g. "C:\Foo\Bar").
  // The rest of the path retains its original casing.
  // IMPORTANT: callers must use isSamePath / isPathInsideDirectory for all
  // equality and containment checks — never raw string equality — because
  // those helpers apply full case-folding before comparing.
  if (IS_WINDOWS && resolved.length >= 2 && resolved.charCodeAt(1) === CHAR_COLON) {
    return resolved.charAt(0).toLowerCase() + resolved.slice(1);
  }

  return resolved;
}

export const IS_CASE_INSENSITIVE_FS = IS_WINDOWS || platform() === 'darwin';

function normalizeCaseForComparison(value: string): string {
  return IS_CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

export function isSamePath(left: string, right: string): boolean {
  if (left === right) {
    return true;
  }
  const leftResolved = normalizeCaseForComparison(resolve(left));
  const rightResolved = normalizeCaseForComparison(resolve(right));
  return leftResolved === rightResolved;
}

function stripTrailingSeparator(normalized: string): string {
  return normalized.length > 1 && normalized.endsWith(PATH_SEPARATOR)
    ? normalized.slice(0, -1)
    : normalized;
}

function normalizeAllowedDirectory(dir: string): string {
  const trimmed = dir.trim();
  if (trimmed.length === 0) return '';

  const normalized = normalizePath(trimmed);
  const { root } = parse(normalized);

  // Keep filesystem roots as-is ("/", "c:\\", "\\\\server\\share\\").
  if (isSamePath(normalized, root)) {
    return root;
  }

  return stripTrailingSeparator(normalized);
}

export function isPathInsideDirectory(
  normalizedDirectory: string,
  normalizedCandidate: string,
): boolean {
  const root = normalizeCaseForComparison(normalizedDirectory);
  const candidate = normalizeCaseForComparison(normalizedCandidate);

  if (root === candidate) return true;
  if (!candidate.startsWith(root)) return false;

  if (isSlash(root.charCodeAt(root.length - 1))) return true;
  return isSlash(candidate.charCodeAt(root.length));
}

export function isPathWithinDirectories(
  normalizedPath: string,
  allowedDirs: readonly string[],
): boolean {
  for (const allowedDir of allowedDirs) {
    if (isPathInsideDirectory(allowedDir, normalizedPath)) {
      return true;
    }
  }

  return false;
}

export interface AllowedDirectoriesState {
  primary: string[];
  expanded: string[];
}

// ---------------------------------------------------------------------------
// Resolver pipeline
// ---------------------------------------------------------------------------

export function normalizeAllowedDirectories(dirs: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const dir of dirs) {
    const entry = normalizeAllowedDirectory(dir);
    if (entry.length > 0) {
      normalized.push(entry);
    }
  }
  return [...new Set(normalized)];
}

export async function resolveRealPath(
  normalized: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    signal?.throwIfAborted();
    const realPath = await withAbort(realpath(normalized), signal);
    return normalizeAllowedDirectory(realPath);
  } catch (error) {
    rethrowIfAborted(error);
    // Only suppress ENOENT — the path genuinely does not exist.
    // EACCES, EIO, and other unexpected errors are rethrown so callers
    // cannot silently operate with a narrowed allowed-directory set.
    if (isNotFoundErrno(error)) {
      return null;
    }
    throw error;
  }
}

async function expandAllowedDirectories(
  primaryDirs: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const realPaths = await Promise.all(primaryDirs.map((dir) => resolveRealPath(dir, signal)));

  const expanded: string[] = [];
  for (let i = 0; i < primaryDirs.length; i++) {
    const primary = primaryDirs[i];
    if (!primary) {
      continue;
    }

    expanded.push(primary);

    const real = realPaths[i];
    if (real && !isSamePath(real, primary)) {
      expanded.push(real);
    }
  }

  return [...new Set(expanded)];
}

export async function resolveAllowedDirectoriesState(
  dirs: readonly string[],
  signal?: AbortSignal,
): Promise<AllowedDirectoriesState> {
  const primary = normalizeAllowedDirectories(dirs);
  const expanded = await expandAllowedDirectories(primary, signal);
  return { primary, expanded };
}

// ---------------------------------------------------------------------------
// Windows helpers
// ---------------------------------------------------------------------------

/**
 * Accepted risk: validation methods resolve/verify a path (symlinks, boundaries,
 * sensitivity) and then return a plain string; the actual fs operation happens
 * afterward as a separate syscall (classic TOCTOU). A symlink swapped in that
 * exact window could redirect the follow-up operation. This is mitigated by
 * re-validating the resolved real path (not just the requested path) and by
 * walking ancestors to catch escapes before the target exists, but it is not
 * eliminated — doing so would require fd-based operations (open with
 * O_NOFOLLOW / operate on the resolved fd) throughout core/fs.ts. Acceptable
 * tradeoff for a local, single-user filesystem server today.
 */
export class PathGuard {
  private allowedDirectoriesState: AllowedDirectoriesState | undefined;
  private readonly sensitive = new SensitiveMatcher();
  private rootDirectories: string[] = [];
  private rootBoundaries: string[] = [];

  // ponytail: one mutex per PathGuard. If per-session grant throughput ever
  // matters, split into per-grant-dir locks; a single lock is correct for the
  // stdio + InMemoryEventStore single-process model.
  #mutex = Promise.resolve();

  readonly options: ServerOptions | undefined;
  /**
   * True when this guard backs a live MCP server rather than a one-shot CLI
   * invocation. Operator-facing configuration warnings are suppressed unless
   * it is set, so `--print-config` and unit construction stay quiet.
   */
  readonly isServerContext: boolean;

  constructor(options?: ServerOptions, isServerContext = false) {
    this.options = options;
    this.isServerContext = isServerContext;
  }

  static async fromAllowedDirectories(
    dirs: readonly string[],
    signal?: AbortSignal,
  ): Promise<PathGuard> {
    const state = await resolveAllowedDirectoriesState(dirs, signal);
    const guard = new PathGuard();
    guard.initialize(state);
    return guard;
  }

  initialize(state: AllowedDirectoriesState): void {
    this.allowedDirectoriesState = {
      primary: [...new Set(state.primary)],
      expanded: normalizeAllowedDirectories(state.expanded),
    };
  }

  isInitialized(): boolean {
    return this.allowedDirectoriesState !== undefined;
  }

  /**
   * Run `fn` as the next holder of the guard's single mutation lock. Every root
   * change goes through this so concurrent grants (and concurrent root refreshes)
   * cannot interleave their read-`await`-write and lose a grant (GRANT-1).
   */
  private async runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.#mutex.then(fn, fn);
    this.#mutex = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async #setRootsLocked(resolvedRoots: readonly string[]): Promise<void> {
    const next = [...resolvedRoots];
    const previous = this.rootDirectories;
    this.rootDirectories = next;
    try {
      await this.recomputeAllowedDirectories();
    } catch (error) {
      // Roll back: a failed recompute leaves the guard with the old roots and
      // its old, consistent allowed-directory view.
      this.rootDirectories = previous;
      throw error;
    }
  }

  /** Set the allowed roots under the mutation lock. */
  async setRoots(resolvedRoots: readonly string[]): Promise<void> {
    return this.runExclusive(() => this.#setRootsLocked(resolvedRoots));
  }

  getAllowedDirectories(): string[] {
    if (!this.allowedDirectoriesState) {
      return [];
    }
    return [...this.allowedDirectoriesState.expanded];
  }

  getRootBoundaries(): string[] {
    return [...this.rootBoundaries];
  }

  isSensitive(filePath: string): boolean {
    return this.sensitive.isSensitive(filePath);
  }

  /**
   * True when `entryPath` is both within the guard's allowed directories and
   * not sensitive, checking the requested AND resolved paths. EVERY entry is
   * realpath-resolved via validateExistingPathDetailed: a symlinked ancestor
   * directory pointing outside the sandbox would otherwise pass the lexical
   * containment check (fs.glob follows symlinks and yields external entries as
   * non-symlink dirents). validateExistingPathDetailed re-checks containment on
   * the real path against this.allowedDirectoriesState.expanded (the guard's full
   * allowed set — a superset of the single-root `bounds` callers pass) and
   * re-checks sensitivity on the resolved target, throwing ACCESS_DENIED for
   * escapes/sensitive, which the catch below turns into a filter. `_entryType`
   * and `_bounds` are retained for call-site compatibility while the guard's own
   * allowed set is the real gate. Skippable errno/fs errors return false (the
   * entry is filtered, not fatal). The accepted TOCTOU window is documented at
   * the class docstring above.
   */
  async isEntryAccessible(
    entryPath: string,
    _entryType: EntryType,
    _bounds: readonly string[],
  ): Promise<boolean> {
    const isSensitive = (requestedPath: string, resolvedPath: string): boolean =>
      this.isSensitive(requestedPath) || this.isSensitive(resolvedPath);
    try {
      const validated = await this.validateExistingPathDetailed(entryPath);
      return !isSensitive(validated.requestedPath, validated.resolvedPath);
    } catch (error) {
      if (isFsError(error)) {
        if (SKIPPABLE_FS_CODES.has(error.code)) return false;
        throw error;
      }
      if (isNodeError(error) && error.code !== undefined && SKIPPABLE_ERRNOS.has(error.code))
        return false;
      throw error;
    }
  }

  async validateExistingPath(requestedPath: string): Promise<ValidatedPath> {
    const details = await this.validateExistingPathDetailed(requestedPath);
    return details.resolvedPath as ValidatedPath;
  }

  /** True when a normalized path equals its own filesystem root (`C:\`, `/`). */
  private isFilesystemRoot(normalizedPath: string): boolean {
    return isSamePath(normalizedPath, parse(normalizedPath).root);
  }

  /** Walk up from a blocked path to the closest existing ancestor directory. */
  private async resolveGrantTargetDir(blockedPath: string): Promise<string> {
    let targetDir = blockedPath;
    for (;;) {
      const parent = dirname(targetDir);
      try {
        // An existing directory is the grant target; an existing file grants
        // its parent directory.
        return (await stat(targetDir)).isDirectory() ? targetDir : parent;
      } catch {
        // Missing — keep walking up.
      }
      if (parent === targetDir) return targetDir;
      targetDir = parent;
    }
  }

  /**
   * Pre-check (no mutation, no callback): given the paths a tool is about to
   * operate on, return the sorted, de-duplicated grant-target directories for
   * those that are outside the allowed roots AND grantable (within ROOT_BOUNDARY
   * when it is configured). A path whose nearest existing ancestor escapes the
   * boundary is NOT grantable and is omitted — the operation will fail with
   * ACCESS_DENIED for it rather than prompt. The caller returns an
   * `input_required` result carrying exactly this set (R7), and on retry applies
   * each accepted grant via {@link applyGrant} (R8). `requestState` binds this
   * set so a grant accepted for X cannot authorize Y (R9).
   */
  async precheckAccess(paths: readonly string[]): Promise<string[]> {
    if (!this.allowedDirectoriesState || paths.length === 0) {
      return [];
    }
    const allowedDirs = this.allowedDirectoriesState.expanded;
    const grantDirs: string[] = [];
    for (const requested of paths) {
      if (!requested) {
        continue;
      }
      const normalized = normalizePath(requested);
      if (isPathWithinDirectories(normalized, allowedDirs)) {
        continue;
      }
      const targetDir = normalizePath(await this.resolveGrantTargetDir(normalized));
      // A grant target that IS a bare filesystem root means every intermediate
      // directory in the requested path was missing — never offer the whole
      // drive/filesystem as a one-click grant target (mirrors the
      // --allow-cwd root check in isUnsafeCwdPath).
      if (this.isFilesystemRoot(targetDir)) {
        continue;
      }
      // Never offer a grant into an unsafe path (home, /etc, C:\Windows, ...).
      // Without ROOT_BOUNDARY, isWithinBoundary returns true for everything, so
      // this is the one guard that still rejects roots a misleading grant could
      // reach. Mirrors the isUnsafeCwdPath check gating --allow-cwd.
      if (isUnsafeCwdPath(targetDir)) {
        continue;
      }
      if (grantDirs.includes(targetDir)) {
        continue;
      }
      if (!(await this.isWithinBoundary(targetDir))) {
        continue;
      }
      grantDirs.push(targetDir);
    }
    return grantDirs.sort();
  }

  /**
   * Apply an accepted access grant: enforce ROOT_BOUNDARY again (a TOCTOU
   * re-check against the boundary resolved at config time), then extend the
   * allowed roots for the remainder of the session (R8, A4). Returns false when
   * the boundary blocks the grant; the caller leaves the path to fail with
   * ACCESS_DENIED during the operation. Idempotent: re-granting an already
   * allowed directory is a no-op via `setRoots` dedup.
   */
  async applyGrant(targetDir: string): Promise<boolean> {
    // Defense-in-depth: even a tampered/accepted grant cannot extend roots into
    // an unsafe path. The precheckAccess guard already refuses to offer these;
    // this catches a grant that arrived by another route.
    if (isUnsafeCwdPath(normalizePath(targetDir))) {
      return false;
    }
    if (!(await this.isWithinBoundary(targetDir))) {
      return false;
    }
    // Read + write under the mutation lock so a concurrent grant cannot
    // interleave and lose this grant (GRANT-1). #setRootsLocked (not the
    // locked public setRoots) — runExclusive is not reentrant.
    return this.runExclusive(async () => {
      await this.#setRootsLocked([...this.getAllowedDirectories(), targetDir]);
      return true;
    });
  }

  // The guard already realpath-resolved ROOT_BOUNDARY into rootBoundaries
  // during recomputeAllowedDirectories. Reuse that single source of truth so
  // grant paths check the same boundary the rest of the guard enforces,
  // instead of re-reading the env and re-resolving each entry.
  private async isWithinBoundary(targetDir: string): Promise<boolean> {
    if (this.rootBoundaries.length === 0) {
      return true;
    }
    let resolved: string;
    try {
      resolved = normalizePath(await realpath(targetDir));
    } catch {
      resolved = normalizePath(targetDir);
    }
    return isPathWithinDirectories(resolved, this.rootBoundaries);
  }

  private validateAccessAndSensitivity(requestedPath: string): {
    normalizedRequested: string;
    allowedDirs: string[];
    accessDeniedHint: string;
  } {
    const result = this.validateAccess(requestedPath);
    this.assertNotSensitiveFile(requestedPath, requestedPath);
    this.assertNotSensitiveFile(result.normalizedRequested, requestedPath);
    return result;
  }

  // Synchronous since the access-grant round-trip moved to the executor's
  // pre-check: validateAccess only does lexical containment math and throws,
  // no async I/O remains. Callers still `await` it for uniform control-flow;
  // awaiting a non-thenable returns it unchanged.
  private validateAccess(requestedPath: string): {
    normalizedRequested: string;
    allowedDirs: string[];
    accessDeniedHint: string;
  } {
    if (!this.allowedDirectoriesState) {
      throw new FsError(
        ErrorCode.UNKNOWN,
        'PathGuard not initialized. Call initialize() first.',
        requestedPath,
      );
    }
    if (isWindowsDriveRelativePath(requestedPath)) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
        requestedPath,
      );
    }
    const reservedDevice = getReservedDeviceNameForPath(requestedPath);
    if (reservedDevice) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `Reserved Windows device name not allowed: ${reservedDevice}.`,
        requestedPath,
      );
    }

    const normalizedRequested = normalizePath(requestedPath);
    const allowedDirs = this.allowedDirectoriesState.expanded;

    const accessDeniedHint =
      allowedDirs.length > 0
        ? `Allowed: ${allowedDirs.join(', ')}`
        : 'No allowed directories configured.';

    if (!isPathWithinDirectories(normalizedRequested, allowedDirs)) {
      // Out of root. The access-grant `input_required` round-trip is driven by
      // the executor's pre-check (precheckAccess) BEFORE the operation runs, so
      // by the time validation reaches here any grantable out-of-root path has
      // already been accepted and added to the allowed set. A path still out of
      // root here was either declined, ungrantable (outside ROOT_BOUNDARY), or
      // never pre-checked — fail closed.
      this.throwAccessDenied(requestedPath, accessDeniedHint);
    }

    return {
      normalizedRequested,
      allowedDirs: this.allowedDirectoriesState.expanded,
      accessDeniedHint,
    };
  }

  private async handleRealpathError(
    error: unknown,
    normalizedRequested: string,
    allowedDirs: string[],
    accessDeniedHint: string,
    requestedPath: string,
  ): Promise<never> {
    if (isNotFoundErrno(error)) {
      // Resolve the nearest existing ancestor to detect out-of-sandbox symlinks.
      // e.g. if `link -> C:\external` and path is `link\nonexistent.txt`, the
      // ancestor resolves outside allowed dirs → ACCESS_DENIED, not NOT_FOUND.
      try {
        const { realAncestor, resolvedTarget } = await this.resolveNearestExistingAncestor(
          requestedPath,
          normalizedRequested,
        );
        if (
          !isPathWithinDirectories(realAncestor, allowedDirs) ||
          !isPathWithinDirectories(resolvedTarget, allowedDirs)
        ) {
          this.throwAccessDenied(requestedPath, accessDeniedHint);
        }
      } catch (ancestorErr) {
        // Rethrow any FsError — collapsing e.g. UNKNOWN to NOT_FOUND would mask
        // incomplete sandbox checks and make bugs invisible to callers.
        if (isFsError(ancestorErr)) {
          throw ancestorErr;
        }
      }

      throw new FsError(
        ErrorCode.NOT_FOUND,
        'Path not found',
        requestedPath,
        { originalError: error.message },
        error,
      );
    }

    const mapped =
      isNodeError(error) && error.code !== undefined ? ERRNO_MAP[error.code] : undefined;
    throw new FsError(
      mapped ?? ErrorCode.UNKNOWN,
      'Cannot access path',
      requestedPath,
      {
        originalError: formatUnknownErrorMessage(error),
      },
      error instanceof Error ? error : undefined,
    );
  }

  async validateExistingPathDetailed(requestedPath: string): Promise<ValidatedPathDetails> {
    const { normalizedRequested, allowedDirs, accessDeniedHint } =
      this.validateAccessAndSensitivity(requestedPath);

    let realPath: string;
    try {
      realPath = await realpath(normalizedRequested);
    } catch (error) {
      realPath = await this.handleRealpathError(
        error,
        normalizedRequested,
        allowedDirs,
        accessDeniedHint,
        requestedPath,
      );
    }

    const normalizedReal = normalizePath(realPath);

    if (!isPathWithinDirectories(normalizedReal, allowedDirs)) {
      this.throwAccessDenied(requestedPath, accessDeniedHint);
    }

    // Re-check the resolved real path: a symlink inside an allowed root may
    // point at a sensitive file (e.g. link -> .env). The early check above only
    // sees the requested/normalized path, not the symlink target.
    this.assertNotSensitiveFile(normalizedReal, requestedPath);

    return {
      requestedPath: normalizedRequested,
      resolvedPath: normalizedReal,
      isSymlink: !isSamePath(normalizedRequested, normalizedReal),
    };
  }

  async validateExistingDirectory(requestedPath: string): Promise<string> {
    const details = await this.validateExistingPathDetailed(requestedPath);

    let stats: Stats;
    try {
      stats = await stat(details.resolvedPath);
    } catch (error) {
      throw new FsError(
        ErrorCode.UNKNOWN,
        'Cannot access directory',
        requestedPath,
        {
          originalError: formatUnknownErrorMessage(error),
        },
        error instanceof Error ? error : undefined,
      );
    }

    if (!stats.isDirectory()) {
      throw new FsError(ErrorCode.NOT_DIRECTORY, 'Not a directory', requestedPath);
    }

    return details.resolvedPath;
  }

  resolvePathOrRoot(pathValue: string | undefined): string {
    if (pathValue && pathValue.trim().length > 0) {
      return pathValue;
    }
    const roots = this.getAllowedDirectories();
    if (roots.length === 0) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'No roots configured. Use the roots tool or --allow-cwd.',
      );
    }
    if (roots.length > 1) {
      throw new FsError(
        ErrorCode.INVALID_INPUT,
        'Multiple roots configured. Provide an explicit path.',
      );
    }
    const root = roots[0];
    if (!root) {
      throw new FsError(ErrorCode.ACCESS_DENIED, 'Workspace root is unexpectedly undefined');
    }
    return root;
  }

  isAllowedRoot(normalizedPath: string): boolean {
    // isSamePath case-folds on case-insensitive filesystems (win + darwin),
    // matching the containment checks used everywhere else in the guard. The
    // previous IS_WINDOWS-only fold left darwin doing exact-case compares here
    // while isPathInsideDirectory folded — a root matched case-insensitively
    // everywhere else was missed.
    return this.getAllowedDirectories().some((dir) => isSamePath(dir, normalizedPath));
  }

  // Checks ONLY the sensitive-file denylist. Root containment and symlink
  // resolution must be verified separately (e.g. via validateExistingPath).
  private assertNotSensitiveFile(checkPath: string, requestedPath: string): void {
    if (this.isSensitive(checkPath)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override.',
        requestedPath,
      );
    }
  }

  private throwAccessDenied(requestedPath: string, hint?: string): never {
    throw new FsError(
      ErrorCode.ACCESS_DENIED,
      hint ? `Outside allowed directories. ${hint}` : 'Outside allowed directories.',
      requestedPath,
    );
  }
  private async resolveNearestExistingAncestor(
    requestedPath: string,
    currentPath: string,
  ): Promise<{ realAncestor: string; resolvedTarget: string }> {
    const missingSegments: string[] = [];
    let current = currentPath;
    for (;;) {
      try {
        const realAncestor = normalizePath(await realpath(current));
        const resolvedTarget =
          missingSegments.length === 0
            ? realAncestor
            : normalizePath(join(realAncestor, ...missingSegments.reverse()));
        return { realAncestor, resolvedTarget };
      } catch (error) {
        try {
          const stats = await lstat(current);
          if (stats.isSymbolicLink()) {
            const target = await readlink(current);
            const resolvedTarget = isAbsolute(target) ? target : resolve(dirname(current), target);
            const normalizedTarget = normalizePath(resolvedTarget);
            const allowedDirs = this.getAllowedDirectories();
            if (!isPathWithinDirectories(normalizedTarget, allowedDirs)) {
              this.throwAccessDenied(requestedPath);
            }
          }
        } catch (lstatErr) {
          if (isFsError(lstatErr) && lstatErr.code === ErrorCode.ACCESS_DENIED) {
            throw lstatErr;
          }
          // ENOENT is expected during ancestor walk — the entry simply doesn't exist.
          // Any other error (EACCES, EIO, ELOOP) is unexpected; fail safe.
          if (!isNodeError(lstatErr) || lstatErr.code !== 'ENOENT') {
            throw new FsError(
              ErrorCode.UNKNOWN,
              'Cannot probe symlink ancestor',
              requestedPath,
              { originalError: formatUnknownErrorMessage(lstatErr) },
              lstatErr instanceof Error ? lstatErr : undefined,
            );
          }
        }
        const parent = dirname(current);
        if (parent === current) {
          throw new FsError(
            ErrorCode.UNKNOWN,
            'Cannot resolve path',
            requestedPath,
            { originalError: formatUnknownErrorMessage(error) },
            error instanceof Error ? error : undefined,
          );
        }
        missingSegments.push(basename(current));
        current = parent;
      }
    }
  }

  async validatePathForWrite(requestedPath: string): Promise<ValidatedPath> {
    const { normalizedRequested, allowedDirs, accessDeniedHint } =
      this.validateAccessAndSensitivity(requestedPath);

    const { realAncestor, resolvedTarget } = await this.resolveNearestExistingAncestor(
      requestedPath,
      normalizedRequested,
    );
    if (
      !isPathWithinDirectories(realAncestor, allowedDirs) ||
      !isPathWithinDirectories(resolvedTarget, allowedDirs)
    ) {
      this.throwAccessDenied(requestedPath, accessDeniedHint);
    }
    // Re-check the resolved target: a symlink inside an allowed root may point
    // at a sensitive file. Writing through such a link must be blocked too.
    this.assertNotSensitiveFile(resolvedTarget, requestedPath);
    return resolvedTarget as ValidatedPath;
  }

  async validatePathForDelete(requestedPath: string): Promise<ValidatedPath> {
    const { normalizedRequested, allowedDirs, accessDeniedHint } =
      this.validateAccessAndSensitivity(requestedPath);

    const parent = dirname(normalizedRequested);
    let realParent: string;
    try {
      realParent = await realpath(parent);
    } catch (error) {
      throw new FsError(
        ErrorCode.NOT_FOUND,
        'Parent directory not found',
        requestedPath,
        { originalError: formatUnknownErrorMessage(error) },
        error instanceof Error ? error : undefined,
      );
    }
    const normalizedRealParent = normalizePath(realParent);

    if (!isPathWithinDirectories(normalizedRealParent, allowedDirs)) {
      this.throwAccessDenied(requestedPath, accessDeniedHint);
    }

    // Resolve the final component when it exists. For deletion, we ONLY
    // block if the real target is outside the sandbox IF the target is
    // NOT a symlink. Deleting a symlink is safe even if it points outside.
    try {
      const stats = await lstat(normalizedRequested);
      if (stats.isSymbolicLink()) {
        // Symlink: check link sensitivity but don't resolve target.
        // The parent check above ensures the link itself is in an allowed root.
        this.assertNotSensitiveFile(normalizedRequested, requestedPath);
        return normalizedRequested as ValidatedPath;
      }

      // Not a symlink: resolve to catch path escapes (e.g. /allowed/dir/../../etc)
      // and block sensitive files.
      const realTarget = normalizePath(await realpath(normalizedRequested));
      if (!isPathWithinDirectories(realTarget, allowedDirs)) {
        this.throwAccessDenied(requestedPath, accessDeniedHint);
      }
      this.assertNotSensitiveFile(realTarget, requestedPath);
      return realTarget as ValidatedPath;
    } catch (error) {
      // A denial raised inside this block (out-of-root real target, or a
      // sensitive file reached through a symlinked parent) must propagate.
      // Only a probe failure — ENOENT and friends — falls through to the
      // parent check, which is sufficient for a path that does not exist.
      if (isFsError(error)) {
        throw error;
      }
    }
    return normalizedRequested as ValidatedPath;
  }

  async recomputeAllowedDirectories(): Promise<void> {
    const cliAllowedDirs = normalizeAllowedDirectories(this.options?.cliAllowedDirs ?? []);

    // Parse allowed directories from environment variable
    const allowMissing =
      cli.allowMissingRoots ?? parseTrueEnvFlag(process.env['ALLOW_MISSING_ROOTS']);
    const envAllowedDirs = await resolveConfiguredDirs('FS_ALLOWED_DIRS', { allowMissing });

    // Parse ROOT_BOUNDARY (the --root-boundary flag beats the env var)
    const boundaries = await resolveConfiguredDirs('ROOT_BOUNDARY', {
      resolveReal: true,
      ...(cli.rootBoundary !== undefined ? { rawValue: cli.rootBoundary } : {}),
    });

    const allowCwd = Boolean(this.options?.allowCwd);
    const allowCwdDirs: string[] = [];
    if (allowCwd) {
      let cwd = normalizePath(process.cwd());
      const walkCwd = cli.allowCwdWalk ?? parseTrueEnvFlag(process.env['ALLOW_CWD_WALK']);
      if (walkCwd) {
        cwd = await findProjectRoot(cwd, [...boundaries, homedir()]);
      }
      if (isUnsafeCwdPath(cwd)) {
        Logger.emit(
          'warning',
          `Skipped adding unsafe current working directory to allowed list: ${cwd}`,
        );
      } else {
        allowCwdDirs.push(cwd);
      }
    }

    const baseline = [...cliAllowedDirs, ...envAllowedDirs, ...allowCwdDirs];

    const signal = timedSignal(undefined, ROOTS_TIMEOUT_MS);
    const rootsToInclude =
      boundaries.length > 0
        ? await filterRootsWithin(this.rootDirectories, boundaries, 'rootBoundary', false, signal)
        : baseline.length > 0
          ? await filterRootsWithin(this.rootDirectories, baseline, 'baseline', true, signal)
          : this.rootDirectories;

    const combined = [...baseline, ...rootsToInclude];
    const nextState = await resolveAllowedDirectoriesState(combined, signal);
    // Commit both fields together, after every await has resolved, so a
    // rejecting recompute leaves the guard's previous, consistent view intact.
    this.rootBoundaries = boundaries;
    this.initialize(nextState);
  }
}
