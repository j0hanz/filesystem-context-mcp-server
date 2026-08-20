import { AsyncLocalStorage } from 'node:async_hooks';
import type { Stats } from 'node:fs';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';

import { timedSignal, withAbort } from './concurrency.js';
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
import { Logger } from './observability.js';
import { parseEnvDirList, parseTrueEnvFlag } from './primitives.js';
import type { EntryType } from './primitives.js';
import { SensitiveMatcher } from './sensitive.js';
import { ROOTS_TIMEOUT_MS } from './util.js';

// Allowed-directory assembly and the PathGuard that enforces it. The
// sensitive-file denylist that used to live here moved to sensitive.ts — it
// shared only isAlpha / toPosixPath / IS_WINDOWS with these primitives, not the
// containment checks, and was consumed independently by path-completer.ts and
// glob.ts via PathGuard.isSensitive (which delegates to SensitiveMatcher).
// Separable peers already extracted: sensitive.ts, path-completer.ts,
// cursor.ts.
export type ValidatedPath = string & { readonly __validated: unique symbol };

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
    if (isNotFoundErrno(error)) return false;
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
  if (normalizedRoots.length === 0) return [];

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

const WINDOWS_PATH_SEPARATOR = '\\';
const POSIX_PATH_SEPARATOR = '/';
export const IS_WINDOWS = platform() === 'win32';
const HOMEDIR = homedir();
const PATH_SEPARATOR = sep;

const CHAR_FORWARD_SLASH = 47;
const CHAR_BACKWARD_SLASH = 92;
const CHAR_COLON = 58;
const CHAR_TILDE = 126;
const CHAR_SPACE = 32;
const CHAR_DOT = 46;

export function isSlash(code: number): boolean {
  return code === CHAR_FORWARD_SLASH || code === CHAR_BACKWARD_SLASH;
}

export function isAlpha(code: number): boolean {
  return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}

export function toPosixPath(value: string): string {
  return value.includes(WINDOWS_PATH_SEPARATOR)
    ? value.replaceAll(WINDOWS_PATH_SEPARATOR, POSIX_PATH_SEPARATOR)
    : value;
}

/** `path.relative` with forward slashes, so displayed paths match across platforms. */
export function toPosixRelative(from: string, to: string): string {
  return toPosixPath(relative(from, to));
}

function expandHome(filepath: string): string {
  if (filepath === '~') return HOMEDIR;

  // Accept both "~/" and "~\\" for cross-platform UX.
  if (
    filepath.length > 1 &&
    filepath.charCodeAt(0) === CHAR_TILDE &&
    isSlash(filepath.charCodeAt(1))
  ) {
    let startIdx = 2;
    while (startIdx < filepath.length && isSlash(filepath.charCodeAt(startIdx))) {
      startIdx++;
    }
    const rest = filepath.slice(startIdx);
    return rest.length === 0 ? HOMEDIR : join(HOMEDIR, rest);
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

const IS_CASE_INSENSITIVE_FS = IS_WINDOWS || platform() === 'darwin';

function normalizeCaseForComparison(value: string): string {
  return IS_CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

export function isSamePath(left: string, right: string): boolean {
  if (left === right) return true;
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

function dedupePreserveOrder<T>(items: readonly T[]): T[] {
  return [...new Set(items)];
}

function isPathInsideDirectory(normalizedDirectory: string, normalizedCandidate: string): boolean {
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
    if (isPathInsideDirectory(allowedDir, normalizedPath)) return true;
  }

  return false;
}

export interface AllowedDirectoriesState {
  primary: string[];
  expanded: string[];
}

interface ValidatedPathDetails {
  requestedPath: string;
  resolvedPath: string;
  isSymlink: boolean;
}

// ---------------------------------------------------------------------------
// Resolver pipeline
// ---------------------------------------------------------------------------

function normalizeAllowedDirectories(dirs: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const dir of dirs) {
    const entry = normalizeAllowedDirectory(dir);
    if (entry.length > 0) {
      normalized.push(entry);
    }
  }
  return dedupePreserveOrder(normalized);
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
    if (isNotFoundErrno(error)) return null;
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
    if (!primary) continue;

    expanded.push(primary);

    const real = realPaths[i];
    if (real && !isSamePath(real, primary)) {
      expanded.push(real);
    }
  }

  return dedupePreserveOrder(expanded);
}

export async function resolveAllowedDirectoriesState(
  dirs: readonly string[],
  signal?: AbortSignal,
): Promise<AllowedDirectoriesState> {
  const primary = normalizeAllowedDirectories(dirs);
  const expanded = await expandAllowedDirectories(primary, signal);
  return { primary, expanded };
}

// Resolve a configured env-var directory list (FS_ALLOWED_DIRS / ROOT_BOUNDARY)
// into normalized, verified directories. Each entry is stat'd; a non-directory
// warns and is dropped, a missing entry warns unless `allowMissing` is set (in
// which case the normalized path is kept). When `resolveReal` is set, a
// directory entry is pushed as its realpath (normalized) instead of the raw
// path — ROOT_BOUNDARY uses this so a symlinked root resolves to its target.
// Both warning messages are templated on `envVar` so operator output is stable.
async function resolveConfiguredDirs(
  envVar: string,
  opts: { allowMissing?: boolean; resolveReal?: boolean } = {},
): Promise<string[]> {
  const raw = parseEnvDirList(envVar);
  const result: string[] = [];
  for (const rawPath of raw) {
    const normalized = normalizePath(rawPath);
    try {
      const s = await stat(normalized);
      if (s.isDirectory()) {
        result.push(opts.resolveReal ? normalizePath(await realpath(normalized)) : normalized);
      } else {
        Logger.emit('warning', `Path configured in ${envVar} is not a directory: ${rawPath}`);
      }
    } catch (error) {
      if (opts.allowMissing) {
        result.push(normalized);
      } else {
        Logger.emit(
          'warning',
          `Path configured in ${envVar} is invalid or does not exist: ${rawPath} (${formatUnknownErrorMessage(error)})`,
        );
      }
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Windows helpers
// ---------------------------------------------------------------------------

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

function getReservedDeviceName(segment: string): string | undefined {
  let end = segment.length;
  while (end > 0) {
    const c = segment.charCodeAt(end - 1);
    if (c === CHAR_SPACE || c === CHAR_DOT) end--;
    else break;
  }
  const trimmed = segment.slice(0, end);
  const streamIdx = trimmed.indexOf(':');
  const withoutStream = streamIdx !== -1 ? trimmed.slice(0, streamIdx) : trimmed;
  const dotIdx = withoutStream.indexOf('.');
  const baseName = (dotIdx !== -1 ? withoutStream.slice(0, dotIdx) : withoutStream).toUpperCase();

  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

export function getReservedDeviceNameForPath(requestedPath: string): string | undefined {
  const segments = requestedPath.split(/[\\/]/u);
  for (const segment of segments) {
    const reserved = getReservedDeviceName(segment);
    if (reserved) return reserved;
  }
  return undefined;
}

export function isWindowsDriveRelativePath(requestedPath: string): boolean {
  // Check on all platforms so cross-platform clients cannot smuggle drive-relative
  // inputs (e.g. C:relative) to a POSIX-hosted server where path.resolve would
  // silently expand them relative to CWD.
  if (requestedPath.length < 2) return false;
  if (requestedPath.charCodeAt(1) !== CHAR_COLON) return false;
  if (!isAlpha(requestedPath.charCodeAt(0))) return false;

  if (requestedPath.length === 2) return true;
  return !isSlash(requestedPath.charCodeAt(2));
}

/**
 * Pure glob-syntax safety check that does not require an initialized PathGuard.
 * Returns false for absolute paths and patterns containing traversal sequences (`..'`).
 * This is the subset of safety enforcement suitable for schema-level validation.
 * Operational path enforcement (allowed-root containment, symlink resolution) is
 * handled by PathGuard.isEntryAccessible, via isPathWithinDirectories and
 * validateExistingPathDetailed.
 */
export function isSafeGlobSyntax(pattern: string): boolean {
  if (!pattern || pattern.trim().length === 0) return false;
  if (isAbsolute(pattern)) return false;
  if (isWindowsDriveRelativePath(pattern)) return false;
  if (pattern.includes('..')) return false;
  // Reject glob-engine-specific traversal bypass forms that some engines
  // expand as path separators or parent-directory references.
  if (/\{[^}]*\.\.[^}]*\}/u.test(pattern)) return false;
  if (pattern.includes('[..]')) return false;
  return true;
}

export interface AccessGrantDeps {
  /** Ask the user to approve granting access to targetDir.
   *  Injected so PathGuard stays free of the MCP elicitation surface. */
  confirm: (targetDir: string) => Promise<boolean>;
}

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
  private readonly denialCache = new Set<string>();

  readonly options: ServerOptions | undefined;
  /**
   * True when this guard backs a live MCP server rather than a one-shot CLI
   * invocation. Operator-facing configuration warnings are suppressed unless
   * it is set, so `--print-config` and unit construction stay quiet.
   */
  readonly isServerContext: boolean;

  /**
   * Per-request access-denied handler, scoped via AsyncLocalStorage so concurrent
   * tools/call invocations sharing one PathGuard cannot clobber each other's
   * handler. Set by {@link PathGuard.runWithAccessDeniedHandler} for the duration
   * of a single tool execution; read by {@link PathGuard.checkAndPromptAccess}.
   * Per-instance, not static: each server builds its own guard, and one guard's
   * handler must not be visible through another.
   */
  readonly #accessDeniedStorage = new AsyncLocalStorage<
    (blockedPath: string) => Promise<boolean>
  >();

  constructor(options?: ServerOptions, isServerContext = false) {
    this.options = options;
    this.isServerContext = isServerContext;
  }

  /**
   * Run `fn` with `handler` as the active access-denied callback for this
   * async chain. Used by the tool executor to attach a per-request elicitation
   * handler without mutating shared state.
   */
  runWithAccessDeniedHandler<R>(
    handler: (blockedPath: string) => Promise<boolean>,
    fn: () => Promise<R>,
  ): Promise<R> {
    return this.#accessDeniedStorage.run(handler, fn);
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
      primary: dedupePreserveOrder(state.primary),
      expanded: normalizeAllowedDirectories(state.expanded),
    };
  }

  isInitialized(): boolean {
    return this.allowedDirectoriesState !== undefined;
  }

  async setRoots(resolvedRoots: readonly string[]): Promise<void> {
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
   * True when `entryPath` is both within `bounds` and not sensitive, checking
   * the requested AND resolved paths. Symlinks are resolved via
   * validateExistingPathDetailed (which checks containment against
   * this.rootBoundaries internally); other types check `bounds` directly.
   * Skippable errno/fs errors return false (the entry is filtered, not fatal).
   */
  async isEntryAccessible(
    entryPath: string,
    entryType: EntryType,
    bounds: readonly string[],
  ): Promise<boolean> {
    const isSensitive = (requestedPath: string, resolvedPath: string): boolean =>
      this.isSensitive(requestedPath) || this.isSensitive(resolvedPath);
    if (entryType !== 'symlink') {
      const normalizedPath = normalizePath(entryPath);
      if (!isPathWithinDirectories(normalizedPath, bounds)) return false;
      return !isSensitive(entryPath, normalizedPath);
    }
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

  private async checkAndPromptAccess(checkPath: string): Promise<boolean> {
    const handler = this.#accessDeniedStorage.getStore();
    if (!handler) return false;
    return handler(checkPath);
  }

  /** Clear remembered denials (e.g. on server teardown). */
  clearDenialCache(): void {
    this.denialCache.clear();
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
   * Access-grant policy: resolve the target directory, honor remembered denials,
   * ask the user, enforce ROOT_BOUNDARY, then grant by extending the roots.
   * MCP elicitation is injected via `deps` so this stays a pure access-control
   * concern.
   */
  async requestAccessGrant(blockedPath: string, deps: AccessGrantDeps): Promise<boolean> {
    const targetDir = await this.resolveGrantTargetDir(blockedPath);

    if (this.denialCache.has(targetDir)) return false;

    let approved: boolean;
    try {
      approved = await deps.confirm(targetDir);
    } catch (err) {
      Logger.warn('requestAccessGrant: confirm threw, treating as denial', {
        targetDir,
        error: String(err),
      });
      return false;
    }

    if (!approved) {
      this.denialCache.add(targetDir);
      return false;
    }

    if (this.rootBoundaries.length > 0) {
      // The guard already realpath-resolved ROOT_BOUNDARY into rootBoundaries
      // during recomputeAllowedDirectories. Reuse that single source of truth so
      // the grant path checks the same boundary the rest of the guard enforces,
      // instead of re-reading the env and re-resolving each entry by hand.
      let resolvedTarget: string;
      try {
        resolvedTarget = normalizePath(await realpath(targetDir));
      } catch {
        resolvedTarget = normalizePath(targetDir);
      }
      if (!isPathWithinDirectories(resolvedTarget, this.rootBoundaries)) {
        return false;
      }
    }

    await this.setRoots([...this.getAllowedDirectories(), targetDir]);
    return true;
  }

  private async validateAccessAndSensitivity(requestedPath: string): Promise<{
    normalizedRequested: string;
    allowedDirs: string[];
    accessDeniedHint: string;
  }> {
    const result = await this.validateAccess(requestedPath);
    this.assertNotSensitiveFile(requestedPath, requestedPath);
    this.assertNotSensitiveFile(result.normalizedRequested, requestedPath);
    return result;
  }

  private async validateAccess(requestedPath: string): Promise<{
    normalizedRequested: string;
    allowedDirs: string[];
    accessDeniedHint: string;
  }> {
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
      // Prompt for access, then re-check against the (possibly extended) set.
      // Both "no handler / denied" and "granted but still outside" land here:
      // the post-prompt containment test is the only real gate, so the
      // granted boolean never changed the outcome — one re-check replaces it.
      await this.checkAndPromptAccess(normalizedRequested);
      if (!isPathWithinDirectories(normalizedRequested, this.allowedDirectoriesState.expanded)) {
        this.throwAccessDenied(requestedPath, accessDeniedHint);
      }
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
        if (isFsError(ancestorErr)) throw ancestorErr;
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
      await this.validateAccessAndSensitivity(requestedPath);

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
    if (pathValue && pathValue.trim().length > 0) return pathValue;
    const roots = this.getAllowedDirectories();
    if (roots.length === 0) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'No roots configured. Use roots tool, --allow-cwd, or MCP Roots protocol.',
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
      await this.validateAccessAndSensitivity(requestedPath);

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
      await this.validateAccessAndSensitivity(requestedPath);

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
      if (isFsError(error)) throw error;
    }
    return normalizedRequested as ValidatedPath;
  }

  async recomputeAllowedDirectories(): Promise<void> {
    const cliAllowedDirs = normalizeAllowedDirectories(this.options?.cliAllowedDirs ?? []);

    // Parse allowed directories from environment variable
    const allowMissing = parseTrueEnvFlag(process.env['ALLOW_MISSING_ROOTS']);
    const envAllowedDirs = await resolveConfiguredDirs('FS_ALLOWED_DIRS', { allowMissing });

    // Parse ROOT_BOUNDARY
    const boundaries = await resolveConfiguredDirs('ROOT_BOUNDARY', { resolveReal: true });

    const allowCwd = Boolean(this.options?.allowCwd);
    const allowCwdDirs: string[] = [];
    if (allowCwd) {
      let cwd = normalizePath(process.cwd());
      const walkCwd = parseTrueEnvFlag(process.env['ALLOW_CWD_WALK']);
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

const UNSAFE_CWD_PATHS = new Set(
  [
    '/usr',
    '/etc',
    '/bin',
    '/sbin',
    '/System',
    'C:\\Windows',
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ].map((p) => normalizePath(p).toLowerCase()),
);

function isUnsafeCwdPath(normalizedCwd: string): boolean {
  const norm = normalizedCwd.toLowerCase();

  // 1. Filesystem root check
  const root = parse(normalizedCwd).root;
  if (isSamePath(normalizedCwd, root)) {
    return true;
  }

  // 2. Home directory check
  if (isSamePath(normalizedCwd, homedir())) {
    return true;
  }

  // 3. Hard-coded unsafe paths check
  if (UNSAFE_CWD_PATHS.has(norm)) {
    return true;
  }

  return false;
}

const MAX_PROJECT_ROOT_WALK_DEPTH = 32;

export async function findProjectRoot(startDir: string, ceiling: string[]): Promise<string> {
  const normCeiling = ceiling.map(normalizePath);
  let current = normalizePath(startDir);
  let depth = 0;

  for (;;) {
    if (depth++ >= MAX_PROJECT_ROOT_WALK_DEPTH) break;
    // Check if the current directory contains any markers
    const markers = ['.git', 'package.json', 'pyproject.toml'];
    for (const marker of markers) {
      const markerPath = join(current, marker);
      try {
        const s = await stat(markerPath);
        if (s.isDirectory() || s.isFile()) {
          return current;
        }
      } catch (_error) {
        // Skip and try next marker
      }
    }

    // Move to parent directory
    const parent = normalizePath(dirname(current));

    // Check if we hit the filesystem root
    if (parent === current) {
      break;
    }

    // Check if the parent is still within the ceiling
    if (!isPathWithinDirectories(parent, normCeiling)) {
      break;
    }

    current = parent;
  }

  return normalizePath(startDir);
}
