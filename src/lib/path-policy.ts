import * as path from 'node:path';
import { platform } from 'node:os';

import {
  SENSITIVE_FILE_ALLOWLIST,
  SENSITIVE_FILE_DENYLIST,
} from './constants.js';
import { ErrorCode, McpError } from './errors.js';
import { toPosixPath } from './path-format.js';

interface CompiledPattern {
  globs: readonly string[];
  matchesPath: boolean;
}

interface CompiledPatternSet {
  pathGlobs: readonly string[];
  nameGlobs: readonly string[];
}

const IS_WINDOWS = platform() === 'win32';
const WINDOWS_ABSOLUTE_RE = /^[a-z]:\//iu;

function normalizePathForMatch(input: string): string {
  return toPosixPath(path.normalize(input));
}

function normalizeForMatch(input: string): string {
  const normalized = normalizePathForMatch(input);
  return IS_WINDOWS ? normalized.toLowerCase() : normalized;
}

function compilePatternGlobs(normalizedPattern: string): readonly string[] {
  const globs = new Set<string>([normalizedPattern]);
  const isWindowsAbsolute = WINDOWS_ABSOLUTE_RE.test(normalizedPattern);

  if (!normalizedPattern.startsWith('**/') && !isWindowsAbsolute) {
    const withoutRoot = normalizedPattern.replace(/^\/+/u, '');
    if (withoutRoot.length > 0) {
      globs.add(`**/${withoutRoot}`);
    }
  }

  return [...globs];
}

function compilePatterns(patterns: readonly string[]): CompiledPattern[] {
  const unique = new Set<string>();
  for (const pattern of patterns) {
    const trimmed = pattern.trim();
    if (trimmed.length > 0) {
      unique.add(trimmed);
    }
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

const DENY_PATTERNS = toPatternSet(compilePatterns(SENSITIVE_FILE_DENYLIST));
const ALLOW_PATTERNS = toPatternSet(compilePatterns(SENSITIVE_FILE_ALLOWLIST));

function uniquePair(primary: string, secondary?: string): string[] {
  if (!secondary || secondary === primary) return [primary];
  return [primary, secondary];
}

function matchesAnyGlobs(
  globs: readonly string[],
  candidates: readonly string[]
): boolean {
  if (globs.length === 0 || candidates.length === 0) return false;

  for (const candidate of candidates) {
    for (const glob of globs) {
      if (path.posix.matchesGlob(candidate, glob)) return true;
    }
  }

  return false;
}

export function isSensitivePath(
  requestedPath: string,
  resolvedPath?: string
): boolean {
  if (
    DENY_PATTERNS.pathGlobs.length === 0 &&
    DENY_PATTERNS.nameGlobs.length === 0
  ) {
    return false;
  }

  const normalizedRequested = normalizeForMatch(requestedPath);
  const normalizedResolved = resolvedPath
    ? normalizeForMatch(resolvedPath)
    : undefined;

  const pathCandidates = uniquePair(normalizedRequested, normalizedResolved);
  const nameCandidates = uniquePair(
    path.posix.basename(normalizedRequested),
    normalizedResolved ? path.posix.basename(normalizedResolved) : undefined
  );

  if (
    matchesAnyGlobs(ALLOW_PATTERNS.pathGlobs, pathCandidates) ||
    matchesAnyGlobs(ALLOW_PATTERNS.nameGlobs, nameCandidates)
  ) {
    return false;
  }

  return (
    matchesAnyGlobs(DENY_PATTERNS.pathGlobs, pathCandidates) ||
    matchesAnyGlobs(DENY_PATTERNS.nameGlobs, nameCandidates)
  );
}

export function assertAllowedFileAccess(
  requestedPath: string,
  resolvedPath?: string
): void {
  if (!isSensitivePath(requestedPath, resolvedPath)) return;
  throw new McpError(
    ErrorCode.E_ACCESS_DENIED,
    `Access denied: sensitive file blocked by policy (${requestedPath}). ` +
      'Set FS_CONTEXT_ALLOW_SENSITIVE=1 or use FS_CONTEXT_ALLOWLIST to override.',
    requestedPath
  );
}
