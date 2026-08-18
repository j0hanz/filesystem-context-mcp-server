import type { Stats } from 'node:fs';
import { lstat, readlink, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';

import { assertNotAborted, createTimedAbortSignal, withAbort } from './concurrency.js';
import { ErrorCode, FsError, isAbortError, isNodeError } from './errors.js';
import { Logger } from './observability.js';
import { parseEnvDirList, parseTrueEnvFlag } from './primitives.js';

// ponytail: ~1.3k lines, over the 1k bar. PathGuard and its access-control
// support (path primitives, glob/sensitive-pattern engine, Windows
// reserved-device validation, cwd safety, project-root walking) are one cohesive
// module. Separable peer concerns already extracted: path-completer.ts, cursor.ts.
// Further cuts are <100-line fragments of a single concept and would scatter
// access control across files; revisit when a new separable concern emerges.
export type ValidatedPath = string & { readonly __validated: unique symbol };

const ROOTS_TIMEOUT_MS = 5000;

export interface ServerOptions {
  allowCwd?: boolean;
  cliAllowedDirs?: string[];
  readOnly?: boolean;
}

function normalizeCLIDirectories(dirs: readonly string[]): string[] {
  const normalized: string[] = [];
  for (const dir of dirs) {
    const trimmed = dir.trim();
    if (trimmed.length === 0) continue;
    normalized.push(normalizePath(trimmed));
  }
  return normalized;
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
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalizedRoot), signal);
    return isPathWithinDirectories(normalizePath(realPath), bounds);
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (isNodeError(error) && error.code === 'ENOENT') return false;
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
  const normalizedBounds = normalizeCLIDirectories(bounds);
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
const IS_WINDOWS = platform() === 'win32';
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

function isAlpha(code: number): boolean {
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

function normalizePathForMatch(input: string): string {
  return toPosixPath(normalize(input));
}

function normalizeForMatch(input: string): string {
  const normalized = normalizePathForMatch(input);
  // Always lowercase for case-insensitive denylist matching on all platforms.
  return normalized.toLowerCase();
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

function normalizeCaseForComparison(value: string): string {
  return IS_WINDOWS ? value.toLowerCase() : value;
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

function isFileSystemRootPath(normalized: string, root: string): boolean {
  return isSamePath(normalized, root);
}

function normalizeAllowedDirectory(dir: string): string {
  const trimmed = dir.trim();
  if (trimmed.length === 0) return '';

  const normalized = normalizePath(trimmed);
  const { root } = parse(normalized);

  // Keep filesystem roots as-is ("/", "c:\\", "\\\\server\\share\\").
  if (isFileSystemRootPath(normalized, root)) {
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

interface CompiledPattern {
  globs: readonly string[];
  matchesPath: boolean;
}

interface CompiledPatternSet {
  pathGlobs: readonly string[];
  nameGlobs: readonly string[];
}

function isWindowsAbsolutePosixPath(normalizedPattern: string): boolean {
  return (
    normalizedPattern.length >= 3 &&
    normalizedPattern.charCodeAt(1) === CHAR_COLON &&
    normalizedPattern.charCodeAt(2) === CHAR_FORWARD_SLASH &&
    isAlpha(normalizedPattern.charCodeAt(0))
  );
}

function compilePatternGlobs(normalizedPattern: string): readonly string[] {
  const globs = new Set<string>([normalizedPattern]);

  const isRooted =
    normalizedPattern.startsWith('**/') || isWindowsAbsolutePosixPath(normalizedPattern);
  if (!isRooted) {
    const withoutRoot = normalizedPattern.replace(/^\/+/, '');
    if (withoutRoot) {
      globs.add(`**/${withoutRoot}`);
    }
  }

  return Array.from(globs);
}

function compilePatterns(patterns: readonly string[]): CompiledPattern[] {
  const deduped = Array.from(new Set(patterns.map((p) => p.trim()).filter((p) => p.length > 0)));
  return deduped.map((pattern) => {
    const normalized = normalizeForMatch(pattern);
    const matchesPath = normalized.includes('/');
    return {
      globs: matchesPath ? compilePatternGlobs(normalized) : [normalized],
      matchesPath,
    };
  });
}

function toPatternSet(patterns: readonly CompiledPattern[]): CompiledPatternSet {
  const pathGlobs = new Set<string>();
  const nameGlobs = new Set<string>();

  for (const pattern of patterns) {
    const target = pattern.matchesPath ? pathGlobs : nameGlobs;
    for (const glob of pattern.globs) {
      target.add(glob);
    }
  }

  return {
    pathGlobs: [...pathGlobs],
    nameGlobs: [...nameGlobs],
  };
}

function matchesAnyGlob(globs: readonly string[], candidate: string): boolean {
  if (globs.length === 0) return false;

  for (const glob of globs) {
    if (posix.matchesGlob(candidate, glob)) return true;
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

async function resolveRealPath(normalized: string, signal?: AbortSignal): Promise<string | null> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalized), signal);
    return normalizeAllowedDirectory(realPath);
  } catch (error) {
    if (isAbortError(error)) throw error;
    // Only suppress ENOENT — the path genuinely does not exist.
    // EACCES, EIO, and other unexpected errors are rethrown so callers
    // cannot silently operate with a narrowed allowed-directory set.
    if (isNodeError(error) && error.code === 'ENOENT') return null;
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
 * handled by PathGuard.assertSafeGlob and the validateExistingPath family.
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

const DEFAULT_SENSITIVE_PATTERNS = [
  '.env',
  '.env.*',
  '.npmrc',
  '.pypirc',
  '.aws/credentials',
  '.aws/config',
  '.mcpregistry_*_token',
  '*.pem',
  '*.key',
  '*.p12',
  '*.pfx',
  '*.crt',
  '*.cer',
  '*id_rsa*',
  '*id_dsa*',
] as const;

function buildSensitivePatterns(): readonly string[] {
  const allowSensitive = parseTrueEnvFlag(process.env['ALLOW_SENSITIVE']);
  const envValue = process.env['DENYLIST'];
  const envDenylist = envValue
    ? envValue
        .split(/[,\n]/u)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];
  // ALLOW_SENSITIVE suppresses built-ins only; DENYLIST entries always apply
  return [...(allowSensitive ? [] : DEFAULT_SENSITIVE_PATTERNS), ...envDenylist];
}

function stripAdsFromPath(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  const stripped = parts.map((segment, i) => {
    // Preserve the Windows drive-letter colon (e.g. "C:" at index 0 of absolute paths).
    if (
      i === 0 &&
      segment.length === 2 &&
      isAlpha(segment.charCodeAt(0)) &&
      segment.charCodeAt(1) === CHAR_COLON
    ) {
      return segment;
    }
    const colonIdx = segment.indexOf(':');
    return colonIdx !== -1 ? segment.slice(0, colonIdx) : segment;
  });
  return stripped.join(PATH_SEPARATOR);
}

export interface AccessGrantDeps {
  /** Probe whether a path is an existing directory, an existing file, or missing.
   *  Injected so PathGuard stays free of node:fs. */
  probe: (path: string) => Promise<'directory' | 'file' | 'missing'>;
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
  private denyPatterns: CompiledPatternSet;
  private rootDirectories: string[] = [];
  private rootBoundaries: string[] = [];
  private readonly denialCache = new Map<string, boolean>();

  readonly options: ServerOptions | undefined;
  /**
   * True when this guard backs a live MCP server rather than a one-shot CLI
   * invocation. Operator-facing configuration warnings are suppressed unless
   * it is set, so `--print-config` and unit construction stay quiet.
   */
  readonly isServerContext: boolean;
  onAccessDenied?: (blockedPath: string) => Promise<boolean>;

  constructor(options?: ServerOptions, isServerContext = false) {
    this.denyPatterns = toPatternSet(compilePatterns(buildSensitivePatterns()));
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
    const normalized: string[] = [];
    for (const dir of state.expanded) {
      const entry = normalizeAllowedDirectory(dir);
      if (entry.length > 0) {
        normalized.push(entry);
      }
    }

    this.allowedDirectoriesState = {
      primary: [...dedupePreserveOrder(state.primary)],
      expanded: [...dedupePreserveOrder(normalized)],
    };
  }

  isInitialized(): boolean {
    return this.allowedDirectoriesState !== undefined;
  }

  async setRoots(resolvedRoots: readonly string[]): Promise<void> {
    this.rootDirectories = [...resolvedRoots];
    await this.recomputeAllowedDirectories();
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
    if (this.denyPatterns.pathGlobs.length === 0 && this.denyPatterns.nameGlobs.length === 0) {
      return false;
    }
    const pathToCheck = IS_WINDOWS ? stripAdsFromPath(filePath) : filePath;
    const normalizedPath = normalizeForMatch(pathToCheck);
    return (
      matchesAnyGlob(this.denyPatterns.pathGlobs, normalizedPath) ||
      matchesAnyGlob(this.denyPatterns.nameGlobs, posix.basename(normalizedPath))
    );
  }

  isSafeGlob(pattern: string): boolean {
    return isSafeGlobSyntax(pattern);
  }

  async validateExistingPath(requestedPath: string): Promise<ValidatedPath> {
    const details = await this.validateExistingPathDetailed(requestedPath);
    return details.resolvedPath as ValidatedPath;
  }

  private async checkAndPromptAccess(checkPath: string): Promise<boolean> {
    if (!this.onAccessDenied) return false;
    return this.onAccessDenied(checkPath);
  }

  /** Clear remembered denials (e.g. on server teardown). */
  clearDenialCache(): void {
    this.denialCache.clear();
  }

  /** Walk up from a blocked path to the closest existing ancestor directory. */
  private async resolveGrantTargetDir(
    blockedPath: string,
    probe: AccessGrantDeps['probe'],
  ): Promise<string> {
    let targetDir = blockedPath;
    for (;;) {
      const kind = await probe(targetDir);
      if (kind === 'directory') break;
      const parent = dirname(targetDir);
      if (parent === targetDir) break;
      targetDir = parent;
      if (kind === 'file') break;
    }
    return targetDir;
  }

  /**
   * Access-grant policy: resolve the target directory, honor remembered denials,
   * ask the user, enforce ROOT_BOUNDARY, then grant by extending the roots.
   * MCP elicitation and filesystem probing are injected via `deps` so this stays
   * a pure access-control concern.
   */
  async requestAccessGrant(blockedPath: string, deps: AccessGrantDeps): Promise<boolean> {
    const targetDir = await this.resolveGrantTargetDir(blockedPath, deps.probe);

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
      this.denialCache.set(targetDir, true);
      return false;
    }

    const boundaries = parseEnvDirList('ROOT_BOUNDARY');
    if (boundaries.length > 0) {
      // Resolve both target and boundaries through symlinks so a symlink inside
      // the boundary that points outside cannot bypass the ROOT_BOUNDARY constraint.
      let resolvedTarget: string;
      try {
        resolvedTarget = normalizePath(await realpath(targetDir));
      } catch {
        resolvedTarget = normalizePath(targetDir);
      }
      const resolvedBoundaries = await Promise.all(
        boundaries.map(async (b) => {
          try {
            return normalizePath(await realpath(b));
          } catch {
            return normalizePath(b);
          }
        }),
      );
      if (!isPathWithinDirectories(resolvedTarget, resolvedBoundaries)) {
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
    if (this.isSensitive(requestedPath) || this.isSensitive(result.normalizedRequested)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override.',
        requestedPath,
      );
    }
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
      const granted = await this.checkAndPromptAccess(normalizedRequested);
      if (granted) {
        const updatedDirs = this.allowedDirectoriesState.expanded;
        if (!isPathWithinDirectories(normalizedRequested, updatedDirs)) {
          throw new FsError(
            ErrorCode.ACCESS_DENIED,
            `Outside allowed directories. ${accessDeniedHint}`,
            requestedPath,
          );
        }
      } else {
        throw new FsError(
          ErrorCode.ACCESS_DENIED,
          `Outside allowed directories. ${accessDeniedHint}`,
          requestedPath,
        );
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
    if (isNodeError(error) && error.code === 'ENOENT') {
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
          throw new FsError(
            ErrorCode.ACCESS_DENIED,
            `Outside allowed directories. ${accessDeniedHint}`,
            requestedPath,
          );
        }
      } catch (ancestorErr) {
        // Rethrow any FsError — collapsing e.g. UNKNOWN to NOT_FOUND would mask
        // incomplete sandbox checks and make bugs invisible to callers.
        if (ancestorErr instanceof FsError) throw ancestorErr;
      }

      throw new FsError(
        ErrorCode.NOT_FOUND,
        'Path not found',
        requestedPath,
        { originalError: error.message },
        error,
      );
    }

    throw new FsError(
      ErrorCode.UNKNOWN,
      'Cannot access path',
      requestedPath,
      {
        originalError: error instanceof Error ? error.message : String(error),
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
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${accessDeniedHint}`,
        requestedPath,
      );
    }

    // Re-check the resolved real path: a symlink inside an allowed root may
    // point at a sensitive file (e.g. link -> .env). The early check above only
    // sees the requested/normalized path, not the symlink target.
    if (this.isSensitive(normalizedReal)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override.',
        requestedPath,
      );
    }

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
          originalError: error instanceof Error ? error.message : String(error),
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
    const target = IS_WINDOWS ? normalizedPath.toLowerCase() : normalizedPath;
    for (const dir of this.getAllowedDirectories()) {
      const d = IS_WINDOWS ? dir.toLowerCase() : dir;
      if (target === d) return true;
    }
    return false;
  }

  // Checks ONLY the sensitive-file denylist. Root containment and symlink
  // resolution must be verified separately (e.g. via validateExistingPath).
  assertNotSensitiveFile(requestedPath: string): void {
    if (this.isSensitive(requestedPath)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override.',
        requestedPath,
      );
    }
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
              throw new FsError(
                ErrorCode.ACCESS_DENIED,
                `Outside allowed directories.`,
                requestedPath,
              );
            }
          }
        } catch (lstatErr) {
          if (lstatErr instanceof FsError && lstatErr.code === ErrorCode.ACCESS_DENIED) {
            throw lstatErr;
          }
          // ENOENT is expected during ancestor walk — the entry simply doesn't exist.
          // Any other error (EACCES, EIO, ELOOP) is unexpected; fail safe.
          if (!isNodeError(lstatErr) || lstatErr.code !== 'ENOENT') {
            throw new FsError(
              ErrorCode.UNKNOWN,
              'Cannot probe symlink ancestor',
              requestedPath,
              { originalError: lstatErr instanceof Error ? lstatErr.message : String(lstatErr) },
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
            { originalError: error instanceof Error ? error.message : String(error) },
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
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${accessDeniedHint}`,
        requestedPath,
      );
    }
    // Re-check the resolved target: a symlink inside an allowed root may point
    // at a sensitive file. Writing through such a link must be blocked too.
    if (this.isSensitive(resolvedTarget)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override.',
        requestedPath,
      );
    }
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
        { originalError: error instanceof Error ? error.message : String(error) },
        error instanceof Error ? error : undefined,
      );
    }
    const normalizedRealParent = normalizePath(realParent);

    if (!isPathWithinDirectories(normalizedRealParent, allowedDirs)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${accessDeniedHint}`,
        requestedPath,
      );
    }

    // Resolve the final component when it exists. For deletion, we ONLY
    // block if the real target is outside the sandbox IF the target is
    // NOT a symlink. Deleting a symlink is safe even if it points outside.
    try {
      const stats = await lstat(normalizedRequested);
      if (stats.isSymbolicLink()) {
        // Symlink: check link sensitivity but don't resolve target.
        // The parent check above ensures the link itself is in an allowed root.
        if (this.isSensitive(normalizedRequested)) {
          throw new FsError(
            ErrorCode.ACCESS_DENIED,
            'Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override.',
            requestedPath,
          );
        }
        return normalizedRequested as ValidatedPath;
      }

      // Not a symlink: resolve to catch path escapes (e.g. /allowed/dir/../../etc)
      // and block sensitive files.
      const realTarget = normalizePath(await realpath(normalizedRequested));
      if (!isPathWithinDirectories(realTarget, allowedDirs)) {
        throw new FsError(
          ErrorCode.ACCESS_DENIED,
          `Outside allowed directories. ${accessDeniedHint}`,
          requestedPath,
        );
      }
      if (this.isSensitive(realTarget)) {
        throw new FsError(
          ErrorCode.ACCESS_DENIED,
          'Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override.',
          requestedPath,
        );
      }
      return realTarget as ValidatedPath;
    } catch {
      // ENOENT or other error; parent check is sufficient for non-existent paths.
    }
    return normalizedRequested as ValidatedPath;
  }

  async recomputeAllowedDirectories(): Promise<void> {
    const cliAllowedDirs = normalizeCLIDirectories(this.options?.cliAllowedDirs ?? []);

    // Parse allowed directories from environment variable
    const envAllowedRaw = parseEnvDirList('FS_ALLOWED_DIRS');
    const envAllowedDirs: string[] = [];
    const allowMissing = parseTrueEnvFlag(process.env['ALLOW_MISSING_ROOTS']);
    for (const rawPath of envAllowedRaw) {
      const normalized = normalizePath(rawPath);
      try {
        const s = await stat(normalized);
        if (s.isDirectory()) {
          envAllowedDirs.push(normalized);
        } else {
          Logger.emit(
            'warning',
            `Path configured in FS_ALLOWED_DIRS is not a directory: ${rawPath}`,
          );
        }
      } catch (_error) {
        if (allowMissing) {
          envAllowedDirs.push(normalized);
        } else {
          Logger.emit(
            'warning',
            `Path configured in FS_ALLOWED_DIRS is invalid or does not exist: ${rawPath} (${_error instanceof Error ? _error.message : String(_error)})`,
          );
        }
      }
    }

    // Parse ROOT_BOUNDARY
    const boundaryRaw = parseEnvDirList('ROOT_BOUNDARY');
    const boundaries: string[] = [];
    for (const rawPath of boundaryRaw) {
      const normalized = normalizePath(rawPath);
      try {
        const s = await stat(normalized);
        if (s.isDirectory()) {
          const realBoundary = await realpath(normalized);
          boundaries.push(normalizePath(realBoundary));
        } else {
          Logger.emit('warning', `Path configured in ROOT_BOUNDARY is not a directory: ${rawPath}`);
        }
      } catch (_error) {
        Logger.emit(
          'warning',
          `Path configured in ROOT_BOUNDARY is invalid or does not exist: ${rawPath} (${_error instanceof Error ? _error.message : String(_error)})`,
        );
      }
    }
    this.rootBoundaries = boundaries;

    const allowCwd = Boolean(this.options?.allowCwd);
    const allowCwdDirs: string[] = [];
    if (allowCwd) {
      let cwd = normalizePath(process.cwd());
      const walkCwd = parseTrueEnvFlag(process.env['ALLOW_CWD_WALK']);
      if (walkCwd) {
        cwd = await findProjectRoot(cwd, [...this.rootBoundaries, homedir()]);
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

    const { signal, cleanup } = createTimedAbortSignal(undefined, ROOTS_TIMEOUT_MS);
    try {
      const rootsToInclude =
        this.rootBoundaries.length > 0
          ? await filterRootsWithin(
              this.rootDirectories,
              this.rootBoundaries,
              'rootBoundary',
              false,
              signal,
            )
          : baseline.length > 0
            ? await filterRootsWithin(this.rootDirectories, baseline, 'baseline', true, signal)
            : this.rootDirectories;

      const combined = [...baseline, ...rootsToInclude];
      const nextState = await resolveAllowedDirectoriesState(combined, signal);
      this.initialize(nextState);
    } finally {
      cleanup();
    }
  }
}

export { PathCompleter } from './path-completer.js';

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
    if (depth++ > MAX_PROJECT_ROOT_WALK_DEPTH) break;
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
