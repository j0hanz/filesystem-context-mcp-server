import { channel } from 'node:diagnostics_channel';
import type { Stats } from 'node:fs';
import { lstat, readdir, readlink, realpath, stat } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  parse,
  posix,
  resolve,
  sep,
} from 'node:path';

import * as z from 'zod/v4';

import { assertNotAborted, createTimedAbortSignal, withAbort } from './concurrency.js';
import { ErrorCode, FsError, isNodeError } from './errors.js';
import type { LoggingState } from './observability.js';
import { parseTrueEnvFlag } from './util.js';

const ROOTS_TIMEOUT_MS = 5000;
export const LIFECYCLE_CHANNEL = channel('filesystem-mcp:lifecycle');

export interface ServerOptions {
  allowCwd?: boolean;
  cliAllowedDirs?: string[];
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

async function isRootWithinBaseline(
  normalizedRoot: string,
  baseline: readonly string[],
  signal?: AbortSignal,
): Promise<boolean> {
  if (!isPathWithinDirectories(normalizedRoot, baseline)) {
    return false;
  }

  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalizedRoot), signal);
    const normalizedReal = normalizePath(realPath);
    return isPathWithinDirectories(normalizedReal, baseline);
  } catch {
    return false;
  }
}

async function filterRootsWithinBaseline(
  roots: readonly string[],
  baseline: readonly string[],
  signal?: AbortSignal,
): Promise<string[]> {
  const normalizedBaseline = normalizeCLIDirectories(baseline);
  const normalizedRoots = roots.map(normalizePath);
  if (normalizedRoots.length === 0) return [];

  const results = await Promise.allSettled(
    normalizedRoots.map((normalizedRoot) =>
      isRootWithinBaseline(normalizedRoot, normalizedBaseline, signal),
    ),
  );

  return normalizedRoots.filter((_, i) => {
    const result = results[i];
    return result?.status === 'fulfilled' && result.value;
  });
}

// Path utility primitives. Owned by path-guard.ts to avoid a circular
// dependency with paths.ts (which depends on PathGuard). paths.ts re-exports
// the public ones.
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

function isSlash(code: number): boolean {
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
// Resolver pipeline (moved from paths.ts)
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
    if (
      error instanceof Error &&
      (error.name === 'AbortError' ||
        ('code' in error && (error as NodeJS.ErrnoException).code === 'ERR_ABORTED'))
    ) {
      throw error;
    }
    return null;
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
// Windows helpers (moved from paths.ts)
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
  if (!IS_WINDOWS || requestedPath.length < 2) return false;
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
  if (pattern.includes('..')) return false;
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
  const allowSensitive = parseTrueEnvFlag(process.env['FS_CONTEXT_ALLOW_SENSITIVE']);
  const envValue = process.env['FS_CONTEXT_DENYLIST'];
  const envDenylist = envValue
    ? envValue
        .split(/[,\n]/u)
        .map((t) => t.trim())
        .filter((t) => t.length > 0)
    : [];
  // FS_CONTEXT_ALLOW_SENSITIVE suppresses built-ins only; FS_CONTEXT_DENYLIST entries always apply
  return [...(allowSensitive ? [] : DEFAULT_SENSITIVE_PATTERNS), ...envDenylist];
}

export class PathGuard {
  private allowedDirectoriesState: AllowedDirectoriesState | undefined;
  private denyPatterns: CompiledPatternSet;
  private rootDirectories: string[] = [];

  readonly options: ServerOptions | undefined;
  readonly loggingState: LoggingState | undefined;

  constructor(options?: ServerOptions, loggingState?: LoggingState) {
    this.denyPatterns = toPatternSet(compilePatterns(buildSensitivePatterns()));
    this.options = options;
    this.loggingState = loggingState;
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

  isSensitive(filePath: string): boolean {
    if (this.denyPatterns.pathGlobs.length === 0 && this.denyPatterns.nameGlobs.length === 0) {
      return false;
    }
    const normalizedPath = normalizeForMatch(filePath);
    return (
      matchesAnyGlob(this.denyPatterns.pathGlobs, normalizedPath) ||
      matchesAnyGlob(this.denyPatterns.nameGlobs, posix.basename(normalizedPath))
    );
  }

  isSafeGlob(pattern: string): boolean {
    return isSafeGlobSyntax(pattern);
  }

  async validateExistingPath(requestedPath: string): Promise<string> {
    const details = await this.validateExistingPathDetailed(requestedPath);
    return details.resolvedPath;
  }

  private validateAccessAndSensitivity(requestedPath: string): {
    normalizedRequested: string;
    allowedDirs: string[];
    accessDeniedHint: string;
  } {
    const result = this.validateAccess(requestedPath);
    if (this.isSensitive(requestedPath) || this.isSensitive(result.normalizedRequested)) {
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        'Sensitive file blocked. Set FS_CONTEXT_ALLOW_SENSITIVE=1 to override.',
        requestedPath,
      );
    }
    return result;
  }

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
      throw new FsError(
        ErrorCode.ACCESS_DENIED,
        `Outside allowed directories. ${accessDeniedHint}`,
        requestedPath,
      );
    }

    return { normalizedRequested, allowedDirs, accessDeniedHint };
  }

  private async validateSymlinkAccess(
    normalizedRequested: string,
    allowedDirs: string[],
    accessDeniedHint: string,
    requestedPath: string,
  ): Promise<void> {
    try {
      const linkStats = await lstat(normalizedRequested);
      if (linkStats.isSymbolicLink()) {
        const target = await readlink(normalizedRequested);
        const resolvedTarget = isAbsolute(target)
          ? target
          : resolve(dirname(normalizedRequested), target);
        const normalizedTarget = normalizePath(resolvedTarget);
        if (!isPathWithinDirectories(normalizedTarget, allowedDirs)) {
          throw new FsError(
            ErrorCode.ACCESS_DENIED,
            `Outside allowed directories. ${accessDeniedHint}`,
            requestedPath,
          );
        }
      }
    } catch (lstatErr) {
      if (lstatErr instanceof FsError && lstatErr.code === ErrorCode.ACCESS_DENIED) {
        throw lstatErr;
      }
    }
  }

  private async handleRealpathError(
    error: unknown,
    normalizedRequested: string,
    allowedDirs: string[],
    accessDeniedHint: string,
    requestedPath: string,
  ): Promise<never> {
    if (isNodeError(error) && error.code === 'ENOENT') {
      await this.validateSymlinkAccess(
        normalizedRequested,
        allowedDirs,
        accessDeniedHint,
        requestedPath,
      );

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
        'Sensitive file blocked. Set FS_CONTEXT_ALLOW_SENSITIVE=1 to override.',
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
        'Sensitive file blocked. Set FS_CONTEXT_ALLOW_SENSITIVE=1 to override.',
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

  async validatePathForWrite(requestedPath: string): Promise<string> {
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
        'Sensitive file blocked. Set FS_CONTEXT_ALLOW_SENSITIVE=1 to override.',
        requestedPath,
      );
    }
    return resolvedTarget;
  }

  async validatePathForDelete(requestedPath: string): Promise<string> {
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
    return normalizedRequested;
  }

  async recomputeAllowedDirectories(): Promise<void> {
    const cliAllowedDirs = normalizeCLIDirectories(this.options?.cliAllowedDirs ?? []);
    const allowCwd = Boolean(this.options?.allowCwd);
    const allowCwdDirs = allowCwd ? [normalizePath(process.cwd())] : [];
    const baseline = [...cliAllowedDirs, ...allowCwdDirs];
    const { signal, cleanup } = createTimedAbortSignal(undefined, ROOTS_TIMEOUT_MS);
    try {
      const rootsToInclude =
        baseline.length > 0
          ? await filterRootsWithinBaseline(this.rootDirectories, baseline, signal)
          : this.rootDirectories;

      const combined = [...baseline, ...rootsToInclude];
      const nextState = await resolveAllowedDirectoriesState(combined, signal);
      this.initialize(nextState);
    } finally {
      cleanup();
    }
  }
}

// path-guard is in this file, no import needed

const MAX_COMPLETION_ITEMS = 100;
const COMPLETION_RATE_LIMIT_MS = 100;
const MAX_COMPLETION_CACHE_KEYS = 128;

interface CacheEntry {
  ms: number;
  result: string[];
}

export class PathCompleter {
  private cache = new Map<string, CacheEntry>();
  private readonly pathGuard: PathGuard;

  constructor(pathGuard: PathGuard) {
    this.pathGuard = pathGuard;
  }

  async suggest(
    value: string,
    argumentName = '',
    contextArguments?: Record<string, string>,
  ): Promise<string[]> {
    const cacheKey = PathCompleter.buildCacheKey(argumentName, value, contextArguments);
    const now = Date.now();
    const cacheEntry = this.cache.get(cacheKey);

    if (cacheEntry && now - cacheEntry.ms < COMPLETION_RATE_LIMIT_MS) {
      return cacheEntry.result;
    }

    const results = await this.completePath(value, {
      pathGuard: this.pathGuard,
      argumentName,
      ...(contextArguments !== undefined ? { contextArguments } : {}),
    });
    this.setCacheValue(cacheKey, { ms: now, result: results });
    return results;
  }

  private static buildCacheKey(
    argumentName: string,
    value: string,
    contextArguments?: Record<string, string>,
  ): string {
    const base = `${argumentName.toLowerCase()}:${value}`;
    if (!contextArguments) return base;
    const keys = Object.keys(contextArguments);
    if (keys.length === 0) return base;
    return `${base}:${JSON.stringify(contextArguments)}`;
  }

  private setCacheValue(key: string, entry: CacheEntry): void {
    if (this.cache.has(key)) this.cache.delete(key);
    this.cache.set(key, entry);
    while (this.cache.size > MAX_COMPLETION_CACHE_KEYS) {
      const oldest = this.cache.keys().next();
      if (oldest.done) break;
      this.cache.delete(oldest.value);
    }
  }

  private static chooseContextKeys(argumentName: string): readonly string[] {
    const normalized = argumentName.toLowerCase();
    if (normalized === 'destination') return ['source', 'path', 'cwd', 'root'];
    if (
      normalized === 'path' ||
      normalized === 'source' ||
      normalized === 'original' ||
      normalized === 'modified' ||
      normalized === 'file'
    ) {
      return ['path', 'cwd', 'root'];
    }
    return ['path', 'source', 'cwd', 'root'];
  }

  private static hasTrailingSeparator(value: string): boolean {
    return value.length > 0 && isSlash(value.charCodeAt(value.length - 1));
  }

  private static resolveFromBase(
    base: string,
    rawValue: string,
    trailingSeparator: boolean,
  ): { searchDir: string; prefix: string } {
    const normalizedValue = normalizePath(resolve(base, rawValue));
    if (trailingSeparator) return { searchDir: normalizedValue, prefix: '' };
    return {
      searchDir: dirname(normalizedValue),
      prefix: basename(normalizedValue),
    };
  }

  private static parseNamedRootInput(
    value: string,
  ): { rootName: string; remainder: string } | undefined {
    const normalizedInput = toPosixPath(value);
    if (!normalizedInput) return undefined;
    const slashIndex = normalizedInput.indexOf('/');
    if (slashIndex === -1) return { rootName: normalizedInput, remainder: '' };
    const rootName = normalizedInput.slice(0, slashIndex);
    if (!rootName) return undefined;
    return { rootName, remainder: normalizedInput.slice(slashIndex + 1) };
  }

  private static findAllowedRootByName(
    rootName: string,
    allowed: readonly string[],
  ): string | undefined {
    const normalizedRootName = rootName.toLowerCase();
    return allowed.find((candidate) => basename(candidate).toLowerCase() === normalizedRootName);
  }

  private static resolveNamedRootPath(value: string, allowed: string[]): string | undefined {
    const parsed = PathCompleter.parseNamedRootInput(value);
    if (!parsed) return undefined;
    const root = PathCompleter.findAllowedRootByName(parsed.rootName, allowed);
    if (!root) return undefined;
    return normalizePath(resolve(root, parsed.remainder));
  }

  private static resolveNamedRootContext(
    currentValue: string,
    allowed: string[],
  ): { searchDir: string; prefix: string } | undefined {
    const parsed = PathCompleter.parseNamedRootInput(currentValue);
    if (!parsed) return undefined;
    const root = PathCompleter.findAllowedRootByName(parsed.rootName, allowed);
    if (!root) return undefined;
    const trailingSeparator = PathCompleter.hasTrailingSeparator(currentValue);
    return PathCompleter.resolveFromBase(root, parsed.remainder, trailingSeparator);
  }

  private static async isAllowedCompletionDirectory(
    path: string,
    allowed: string[],
  ): Promise<boolean> {
    if (!isPathWithinDirectories(path, allowed)) return false;
    try {
      const [stats, resolvedRealPath] = await Promise.all([stat(path), realpath(path)]);
      if (!stats.isDirectory()) return false;
      return isPathWithinDirectories(normalizePath(resolvedRealPath), allowed);
    } catch {
      return false;
    }
  }

  private static async toAllowedContextDirectory(
    resolved: string,
    allowed: string[],
  ): Promise<string | undefined> {
    const parent = dirname(resolved);
    const [resolvedOk, parentOk] = await Promise.all([
      PathCompleter.isAllowedCompletionDirectory(resolved, allowed),
      PathCompleter.isAllowedCompletionDirectory(parent, allowed),
    ]);
    if (resolvedOk) return resolved;
    if (parentOk) return parent;
    return undefined;
  }

  private static resolveContextCandidatePath(
    candidate: string,
    allowed: string[],
  ): string | undefined {
    if (isAbsolute(candidate)) return normalizePath(candidate);
    if (allowed.length === 1) {
      const base = allowed[0];
      if (!base) return undefined;
      return normalizePath(resolve(base, candidate));
    }
    return PathCompleter.resolveNamedRootPath(candidate, allowed);
  }

  private static async resolveContextBaseDirectory(
    argumentName: string,
    contextArguments: Record<string, string> | undefined,
    allowed: string[],
  ): Promise<string | undefined> {
    if (!contextArguments || Object.keys(contextArguments).length === 0) {
      return undefined;
    }
    const keys = PathCompleter.chooseContextKeys(argumentName);
    for (const key of keys) {
      const candidate = contextArguments[key];
      if (!candidate || candidate.trim().length === 0) continue;
      const resolved = PathCompleter.resolveContextCandidatePath(candidate, allowed);
      if (!resolved) continue;
      const baseDirectory = await PathCompleter.toAllowedContextDirectory(resolved, allowed);
      if (baseDirectory) return baseDirectory;
    }
    return undefined;
  }

  private static withDirectorySeparator(value: string): string {
    return value.endsWith(sep) ? value : `${value}${sep}`;
  }

  private static collectAllowedRoots(
    allowed: readonly string[],
    predicate: (root: string) => boolean,
  ): string[] {
    const matches: string[] = [];
    for (const root of allowed) {
      if (predicate(root)) matches.push(PathCompleter.withDirectorySeparator(root));
    }
    return matches;
  }

  private static getRootPrefix(currentValue: string): string {
    const normalizedInput = toPosixPath(currentValue);
    const slashIndex = normalizedInput.indexOf('/');
    return (
      slashIndex === -1 ? normalizedInput : normalizedInput.slice(0, slashIndex)
    ).toLowerCase();
  }

  private static findRootPrefixMatches(currentValue: string, allowed: string[]): string[] {
    const rootPrefix = PathCompleter.getRootPrefix(currentValue);
    if (!rootPrefix) return PathCompleter.collectAllowedRoots(allowed, () => true);
    return PathCompleter.collectAllowedRoots(allowed, (root) =>
      basename(root).toLowerCase().startsWith(rootPrefix),
    );
  }

  private static findMatchingRoots(searchDir: string, prefix: string, allowed: string[]): string[] {
    const lowerPrefix = prefix.toLowerCase();
    const normalizedSearchDir = normalizePath(searchDir);
    return PathCompleter.collectAllowedRoots(allowed, (root) => {
      const rootDir = dirname(root);
      if (normalizePath(rootDir) !== normalizedSearchDir) return false;
      return basename(root).toLowerCase().startsWith(lowerPrefix);
    });
  }

  private static sortCompletionMatches(matches: string[]): void {
    const sepCode = sep.charCodeAt(0);
    matches.sort((left, right) => {
      const leftIsDir = left.charCodeAt(left.length - 1) === sepCode;
      const rightIsDir = right.charCodeAt(right.length - 1) === sepCode;
      if (leftIsDir && !rightIsDir) return -1;
      if (!leftIsDir && rightIsDir) return 1;
      return left.localeCompare(right);
    });
  }

  private static mergeCompletionMatches(...matchGroups: readonly (readonly string[])[]): string[] {
    const uniqueMatches = new Set<string>();
    for (const group of matchGroups) {
      for (const match of group) uniqueMatches.add(match);
    }
    const merged = Array.from(uniqueMatches);
    PathCompleter.sortCompletionMatches(merged);
    return merged;
  }

  private static async findMatchesInDirectory(
    searchDir: string,
    prefix: string,
    allowed: string[],
  ): Promise<string[]> {
    const matches: string[] = [];
    if (!(await PathCompleter.isAllowedCompletionDirectory(searchDir, allowed))) return matches;
    try {
      const entries = await readdir(searchDir, { withFileTypes: true });

      if (prefix === '') {
        for (const entry of entries) {
          const fullPath = join(searchDir, entry.name);
          matches.push(entry.isDirectory() ? `${fullPath}${sep}` : fullPath);
        }
      } else {
        const lowerPrefix = prefix.toLowerCase();
        for (const entry of entries) {
          if (entry.name.toLowerCase().startsWith(lowerPrefix)) {
            const fullPath = join(searchDir, entry.name);
            matches.push(entry.isDirectory() ? `${fullPath}${sep}` : fullPath);
          }
        }
      }
    } catch {
      // Access denied or not found — skip.
    }
    return matches;
  }

  private static getSearchContext(
    currentValue: string,
    allowed: string[],
    contextBase?: string,
  ): { searchDir: string; prefix: string } | undefined {
    const trailingSeparator = PathCompleter.hasTrailingSeparator(currentValue);
    if (isAbsolute(currentValue)) {
      return PathCompleter.resolveFromBase(
        parse(currentValue).root || sep,
        currentValue,
        trailingSeparator,
      );
    }
    const namedRootContext = PathCompleter.resolveNamedRootContext(currentValue, allowed);
    if (namedRootContext) return namedRootContext;
    if (contextBase) {
      if (currentValue.length === 0) return { searchDir: contextBase, prefix: '' };
      return PathCompleter.resolveFromBase(contextBase, currentValue, trailingSeparator);
    }
    if (allowed.length === 1) {
      const base = allowed[0];
      if (base) return PathCompleter.resolveFromBase(base, currentValue, trailingSeparator);
    }
    return undefined;
  }

  private async completePath(
    value: string,
    options: {
      pathGuard: PathGuard;
      argumentName?: string;
      contextArguments?: Record<string, string>;
    },
  ): Promise<string[]> {
    const allowed = options.pathGuard.getAllowedDirectories();
    const argName = options.argumentName ?? '';

    try {
      const contextBase = await PathCompleter.resolveContextBaseDirectory(
        argName,
        options.contextArguments,
        allowed,
      );

      if (!value && !contextBase) {
        return allowed.slice(0, MAX_COMPLETION_ITEMS);
      }

      const context = PathCompleter.getSearchContext(value, allowed, contextBase);
      if (!context) {
        return PathCompleter.findRootPrefixMatches(value, allowed).slice(0, MAX_COMPLETION_ITEMS);
      }

      const { searchDir, prefix } = context;
      const dirMatches = await PathCompleter.findMatchesInDirectory(searchDir, prefix, allowed);
      const rootMatches = PathCompleter.findMatchingRoots(searchDir, prefix, allowed);
      return PathCompleter.mergeCompletionMatches(dirMatches, rootMatches).slice(
        0,
        MAX_COMPLETION_ITEMS,
      );
    } catch {
      return [];
    }
  }
}

export function createBase64JsonCodec<Schema extends z.ZodType>(
  schema: Schema,
): z.ZodCodec<z.ZodString, Schema> {
  return z.codec(z.string(), schema, {
    decode: (value) => {
      let buffer: Buffer;
      try {
        buffer = Buffer.from(value, 'base64url');
      } catch (error) {
        throw new Error('Invalid base64url encoding.', { cause: error });
      }

      let text: string;
      try {
        text = buffer.toString('utf-8');
      } catch (error) {
        throw new Error('UTF-8 decode failed (corrupted payload).', { cause: error });
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new Error('Invalid JSON in payload.', { cause: error });
      }

      // Cast to the codec's declared decode return type. The downstream
      // schema runs immediately after `decode` and validates the actual shape,
      // so this assertion only satisfies the codec contract — it is not trusted.
      return parsed as z.input<Schema>;
    },
    encode: (value) => Buffer.from(JSON.stringify(value)).toString('base64url'),
  });
}
