import type { McpServer } from '@modelcontextprotocol/server';

import { readdir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, parse, resolve, sep } from 'node:path';

import {
  isPathWithinDirectories,
  normalizePath,
  toPosixPath,
} from './path-guard.js';
import type { PathGuard } from './path-guard.js';

const MAX_COMPLETION_ITEMS = 100;
const COMPLETION_RATE_LIMIT_MS = 100;
const MAX_COMPLETION_CACHE_KEYS = 128;

interface CompletionState {
  lastCallMs: Map<string, number>;
  lastResult: Map<string, string[]>;
}

const completionState = new WeakMap<McpServer, CompletionState>();

function getCompletionState(server: McpServer): CompletionState {
  let state = completionState.get(server);
  if (state === undefined) {
    state = { lastCallMs: new Map(), lastResult: new Map() };
    completionState.set(server, state);
  }
  return state;
}

function rememberCacheValue<T>(
  cache: Map<string, T>,
  key: string,
  value: T
): void {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > MAX_COMPLETION_CACHE_KEYS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

function buildCacheKey(
  argumentName: string,
  value: string,
  contextArguments?: Record<string, string>
): string {
  return JSON.stringify({
    argumentName: argumentName.toLowerCase(),
    value,
    contextArguments,
  });
}

const DESTINATION_CONTEXT_KEYS = ['source', 'path', 'cwd', 'root'] as const;
const PRIMARY_PATH_CONTEXT_KEYS = ['path', 'cwd', 'root'] as const;
const DEFAULT_CONTEXT_KEYS = ['path', 'source', 'cwd', 'root'] as const;

function chooseContextKeys(argumentName: string): readonly string[] {
  const normalized = argumentName.toLowerCase();
  if (normalized === 'destination') return DESTINATION_CONTEXT_KEYS;
  if (
    normalized === 'path' ||
    normalized === 'source' ||
    normalized === 'original' ||
    normalized === 'modified' ||
    normalized === 'file'
  ) {
    return PRIMARY_PATH_CONTEXT_KEYS;
  }
  return DEFAULT_CONTEXT_KEYS;
}

function hasTrailingSeparator(value: string): boolean {
  return value.endsWith(sep) || value.endsWith('/') || value.endsWith('\\');
}

function isAbsolutePathInput(value: string): boolean {
  return (
    isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith('\\\\')
  );
}

function resolveFromBase(
  base: string,
  rawValue: string,
  trailingSeparator: boolean
): { searchDir: string; prefix: string } {
  const normalizedValue = normalizePath(resolve(base, rawValue));
  if (trailingSeparator) return { searchDir: normalizedValue, prefix: '' };
  return {
    searchDir: dirname(normalizedValue),
    prefix: basename(normalizedValue),
  };
}

function parseNamedRootInput(
  value: string
): { rootName: string; remainder: string } | undefined {
  const normalizedInput = toPosixPath(value);
  const [rootName, ...rest] = normalizedInput.split('/');
  if (!rootName) return undefined;
  return { rootName, remainder: rest.join(sep) };
}

function findAllowedRootByName(
  rootName: string,
  allowed: readonly string[]
): string | undefined {
  const normalizedRootName = rootName.toLowerCase();
  return allowed.find(
    (candidate) => basename(candidate).toLowerCase() === normalizedRootName
  );
}

function resolveNamedRootPath(
  value: string,
  allowed: string[]
): string | undefined {
  const parsed = parseNamedRootInput(value);
  if (!parsed) return undefined;
  const root = findAllowedRootByName(parsed.rootName, allowed);
  if (!root) return undefined;
  return normalizePath(resolve(root, parsed.remainder));
}

function resolveNamedRootContext(
  currentValue: string,
  allowed: string[]
): { searchDir: string; prefix: string } | undefined {
  const parsed = parseNamedRootInput(currentValue);
  if (!parsed) return undefined;
  const root = findAllowedRootByName(parsed.rootName, allowed);
  if (!root) return undefined;
  const trailingSeparator = hasTrailingSeparator(currentValue);
  return resolveFromBase(root, parsed.remainder, trailingSeparator);
}

async function isAllowedCompletionDirectory(
  path: string,
  allowed: string[]
): Promise<boolean> {
  if (!isPathWithinDirectories(path, allowed)) return false;
  try {
    const [stats, resolvedRealPath] = await Promise.all([
      stat(path),
      realpath(path),
    ]);
    if (!stats.isDirectory()) return false;
    return isPathWithinDirectories(normalizePath(resolvedRealPath), allowed);
  } catch {
    return false;
  }
}

async function toAllowedContextDirectory(
  resolved: string,
  allowed: string[]
): Promise<string | undefined> {
  const parent = dirname(resolved);
  if (await isAllowedCompletionDirectory(resolved, allowed)) return resolved;
  return (await isAllowedCompletionDirectory(parent, allowed))
    ? parent
    : undefined;
}

function resolveContextCandidatePath(
  candidate: string,
  allowed: string[]
): string | undefined {
  if (isAbsolutePathInput(candidate)) return normalizePath(candidate);
  if (allowed.length === 1) {
    const base = allowed[0];
    if (!base) return undefined;
    return normalizePath(resolve(base, candidate));
  }
  return resolveNamedRootPath(candidate, allowed);
}

async function resolveContextBaseDirectory(
  argumentName: string,
  contextArguments: Record<string, string> | undefined,
  allowed: string[]
): Promise<string | undefined> {
  if (!contextArguments || Object.keys(contextArguments).length === 0) {
    return undefined;
  }
  const keys = chooseContextKeys(argumentName);
  for (const key of keys) {
    const candidate = contextArguments[key];
    if (!candidate || candidate.trim().length === 0) continue;
    const resolved = resolveContextCandidatePath(candidate, allowed);
    if (!resolved) continue;
    const baseDirectory = await toAllowedContextDirectory(resolved, allowed);
    if (baseDirectory) return baseDirectory;
  }
  return undefined;
}

function withDirectorySeparator(value: string): string {
  return value.endsWith(sep) ? value : `${value}${sep}`;
}

function collectAllowedRoots(
  allowed: readonly string[],
  predicate: (root: string) => boolean
): string[] {
  const matches: string[] = [];
  for (const root of allowed) {
    if (predicate(root)) matches.push(withDirectorySeparator(root));
  }
  return matches;
}

function getRootPrefix(currentValue: string): string {
  const normalizedInput = toPosixPath(currentValue);
  return (normalizedInput.split('/')[0] ?? '').toLowerCase();
}

function findRootPrefixMatches(
  currentValue: string,
  allowed: string[]
): string[] {
  const rootPrefix = getRootPrefix(currentValue);
  if (!rootPrefix) return collectAllowedRoots(allowed, () => true);
  return collectAllowedRoots(allowed, (root) =>
    basename(root).toLowerCase().startsWith(rootPrefix)
  );
}

function findMatchingRoots(
  searchDir: string,
  prefix: string,
  allowed: string[]
): string[] {
  const lowerPrefix = prefix.toLowerCase();
  const normalizedSearchDir = normalizePath(searchDir);
  return collectAllowedRoots(allowed, (root) => {
    const rootDir = dirname(root);
    if (normalizePath(rootDir) !== normalizedSearchDir) return false;
    return basename(root).toLowerCase().startsWith(lowerPrefix);
  });
}

function sortCompletionMatches(matches: string[]): void {
  matches.sort((left, right) => {
    const leftIsDir = left.endsWith(sep);
    const rightIsDir = right.endsWith(sep);
    if (leftIsDir && !rightIsDir) return -1;
    if (!leftIsDir && rightIsDir) return 1;
    return left.localeCompare(right);
  });
}

function mergeCompletionMatches(
  ...matchGroups: readonly (readonly string[])[]
): string[] {
  const uniqueMatches = new Set<string>();
  for (const group of matchGroups) {
    for (const match of group) uniqueMatches.add(match);
  }
  const merged = [...uniqueMatches];
  sortCompletionMatches(merged);
  return merged;
}

async function findMatchesInDirectory(
  searchDir: string,
  prefix: string,
  allowed: string[]
): Promise<string[]> {
  const matches: string[] = [];
  if (!(await isAllowedCompletionDirectory(searchDir, allowed))) return matches;
  try {
    const entries = await readdir(searchDir, { withFileTypes: true });
    const lowerPrefix = prefix.toLowerCase();
    const dirSep = searchDir.endsWith(sep) ? '' : sep;
    for (const entry of entries) {
      if (entry.name.toLowerCase().startsWith(lowerPrefix)) {
        const fullPath = `${searchDir}${dirSep}${entry.name}`;
        const isDir = entry.isDirectory();
        matches.push(isDir ? `${fullPath}${sep}` : fullPath);
      }
    }
  } catch {
    // Access denied or not found — skip.
  }
  return matches;
}

function getSearchContext(
  currentValue: string,
  allowed: string[],
  contextBase?: string
): { searchDir: string; prefix: string } | undefined {
  const trailingSeparator = hasTrailingSeparator(currentValue);
  if (isAbsolutePathInput(currentValue)) {
    return resolveFromBase(
      parse(currentValue).root || sep,
      currentValue,
      trailingSeparator
    );
  }
  const namedRootContext = resolveNamedRootContext(currentValue, allowed);
  if (namedRootContext) return namedRootContext;
  if (contextBase) {
    if (currentValue.length === 0)
      return { searchDir: contextBase, prefix: '' };
    return resolveFromBase(contextBase, currentValue, trailingSeparator);
  }
  if (allowed.length === 1) {
    const base = allowed[0];
    if (base) return resolveFromBase(base, currentValue, trailingSeparator);
  }
  return undefined;
}

export interface CompletePathOptions {
  /** McpServer instance for WeakMap cache key. Cache disabled when absent. */
  server?: McpServer;
  /** PathGuard for the current session (provides allowed directories). */
  pathGuard: PathGuard;
  /** Argument name — drives context-key selection (e.g. 'path', 'modified'). */
  argumentName?: string;
  /** Sibling argument values from the completion ctx.arguments field. */
  contextArguments?: Record<string, string>;
}

/**
 * Returns up to MAX_COMPLETION_ITEMS path suggestions for `value` within the
 * current allowed-directory state. Uses a per-McpServer WeakMap to isolate
 * rate-limit and cache state across HTTP sessions.
 */
async function completePath(
  value: string,
  options: CompletePathOptions
): Promise<string[]> {
  const allowed = options.pathGuard.getAllowedDirectories();
  const argName = options.argumentName ?? '';

  try {
    const contextBase = await resolveContextBaseDirectory(
      argName,
      options.contextArguments,
      allowed
    );

    if (!value && !contextBase) {
      return allowed.slice(0, MAX_COMPLETION_ITEMS);
    }

    const context = getSearchContext(value, allowed, contextBase);
    if (!context) {
      return findRootPrefixMatches(value, allowed).slice(
        0,
        MAX_COMPLETION_ITEMS
      );
    }

    const { searchDir, prefix } = context;
    const dirMatches = await findMatchesInDirectory(searchDir, prefix, allowed);
    const rootMatches = findMatchingRoots(searchDir, prefix, allowed);
    return mergeCompletionMatches(dirMatches, rootMatches).slice(
      0,
      MAX_COMPLETION_ITEMS
    );
  } catch {
    return [];
  }
}

/**
 * Rate-limited, cached wrapper around completePath.
 * Use this in completable() callbacks to avoid hammering the filesystem.
 */
export async function completePathCached(
  value: string,
  options: CompletePathOptions
): Promise<string[]> {
  if (!options.server) return completePath(value, options);

  const cacheKey = buildCacheKey(
    options.argumentName ?? '',
    value,
    options.contextArguments
  );
  const now = Date.now();
  const sessionState = getCompletionState(options.server);
  const lastCallMs = sessionState.lastCallMs.get(cacheKey) ?? 0;

  if (now - lastCallMs < COMPLETION_RATE_LIMIT_MS) {
    const cached = sessionState.lastResult.get(cacheKey);
    return cached ?? [];
  }

  rememberCacheValue(sessionState.lastCallMs, cacheKey, now);
  const results = await completePath(value, options);
  rememberCacheValue(sessionState.lastResult, cacheKey, results);
  return results;
}
