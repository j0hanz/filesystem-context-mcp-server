import { opendir, realpath, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, resolve, sep } from 'node:path';

import { isNodeError, rethrowIfAborted } from './errors.js';
import { Logger } from './observability.js';
import type { PathGuard } from './path.js';
import {
  isPathWithinDirectories,
  isSamePath,
  isSlash,
  normalizePath,
  toPosixPath,
} from './path.js';

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

    const results = await this.completePath(value, argumentName, contextArguments);
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
    // Entries are stale after COMPLETION_RATE_LIMIT_MS anyway, so the cap only
    // has to bound memory — dropping the whole map beats per-key LRU eviction.
    if (this.cache.size >= MAX_COMPLETION_CACHE_KEYS) this.cache.clear();
    this.cache.set(key, entry);
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
    } catch (err) {
      if (!isNodeError(err) || (err.code !== 'ENOENT' && err.code !== 'EACCES')) {
        Logger.debug('isAllowedCompletionDirectory: unexpected probe error', {
          path,
          error: String(err),
        });
      }
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
      if (!isSamePath(rootDir, normalizedSearchDir)) return false;
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
    isSensitive?: (path: string) => boolean,
  ): Promise<string[]> {
    const matches: string[] = [];
    if (!(await PathCompleter.isAllowedCompletionDirectory(searchDir, allowed))) return matches;
    try {
      // Stream via opendir and collect every match; the MAX_COMPLETION_ITEMS
      // cap is applied AFTER the alphabetical sort in mergeCompletionMatches
      // (slice at the call site). Capping here would keep the opendir-first
      // 100, not the alphabetically-first 100 — the sort would only reorder
      // an already-arbitrary subset.
      const dir = await opendir(searchDir);
      try {
        const lowerPrefix = prefix.toLowerCase();
        for await (const entry of dir) {
          if (prefix !== '' && !entry.name.toLowerCase().startsWith(lowerPrefix)) continue;
          const fullPath = join(searchDir, entry.name);
          if (isSensitive?.(fullPath)) continue;
          matches.push(entry.isDirectory() ? `${fullPath}${sep}` : fullPath);
        }
      } finally {
        await dir.close().catch(() => {
          /* dir already closed or opendir never resolved */
        });
      }
    } catch (err) {
      if (!isNodeError(err) || (err.code !== 'ENOENT' && err.code !== 'EACCES')) {
        Logger.warn('PathCompleter.findMatchesInDirectory: readdir failed', {
          searchDir,
          error: String(err),
        });
      }
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
    argumentName: string,
    contextArguments?: Record<string, string>,
  ): Promise<string[]> {
    const allowed = this.pathGuard.getAllowedDirectories();

    try {
      const contextBase = await PathCompleter.resolveContextBaseDirectory(
        argumentName,
        contextArguments,
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
      const dirMatches = await PathCompleter.findMatchesInDirectory(
        searchDir,
        prefix,
        allowed,
        this.pathGuard.isSensitive.bind(this.pathGuard),
      );
      const rootMatches = PathCompleter.findMatchingRoots(searchDir, prefix, allowed);
      return PathCompleter.mergeCompletionMatches(dirMatches, rootMatches).slice(
        0,
        MAX_COMPLETION_ITEMS,
      );
    } catch (error) {
      rethrowIfAborted(error);
      Logger.warn('PathCompleter: completion failed, returning empty list', {
        error: error instanceof Error ? (error.stack ?? error.message) : String(error),
      });
      return [];
    }
  }
}
