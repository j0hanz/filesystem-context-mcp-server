import * as fs from 'node:fs/promises';
import * as path from 'node:path';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CompleteRequestSchema } from '@modelcontextprotocol/sdk/types.js';

import {
  getAllowedDirectories,
  isPathWithinDirectories,
  normalizePath,
  toPosixPath,
} from './lib/paths.js';
import { isRecord } from './lib/utils.js';

const MAX_COMPLETION_ITEMS = 100;
const COMPLETION_RATE_LIMIT_MS = 100;

interface CompletionState {
  lastCallMs: Map<string, number>;
  lastResult: Map<string, CompletionResult>;
}

// WeakMap keyed by McpServer instance so that each HTTP session gets isolated
// rate-limit state. In stdio mode there is a single server; in HTTP mode every
// session creates its own McpServer, so cross-session cache pollution is avoided.
const completionState = new WeakMap<McpServer, CompletionState>();

function getCompletionState(server: McpServer): CompletionState {
  let state = completionState.get(server);
  if (state === undefined) {
    state = { lastCallMs: new Map(), lastResult: new Map() };
    completionState.set(server, state);
  }
  return state;
}

function extractTopicCompletions(instructions: string): string[] {
  const headers: string[] = [];
  for (const line of instructions.split('\n')) {
    if (line.startsWith('## ')) {
      const header = line.slice(3).trim().toLowerCase();
      if (header) headers.push(header);
    }
  }
  return headers;
}

interface CompletionResult {
  values: string[];
  total?: number;
  hasMore?: boolean;
}

interface CompletionOptions {
  argumentName?: string;
  contextArguments?: Record<string, string>;
}

interface ResourceReference {
  type: 'ref/resource';
  uri: string;
}

const PATH_ARGUMENTS = new Set([
  'path',
  'source',
  'destination',
  'original',
  'modified',
  'directory',
  'file',
  'root',
  'cwd',
]);

function isPathLikeArgumentName(argName: string): boolean {
  return (
    PATH_ARGUMENTS.has(argName) ||
    argName.endsWith('paths') ||
    argName.endsWith('path') ||
    argName.endsWith('files') ||
    argName.endsWith('file') ||
    argName.endsWith('dirs') ||
    argName.endsWith('dir')
  );
}

function parseResourceReference(value: unknown): ResourceReference | undefined {
  if (!isRecord(value)) return undefined;
  if (value['type'] !== 'ref/resource') return undefined;
  const { uri } = value;
  if (typeof uri !== 'string') return undefined;
  return { type: 'ref/resource', uri };
}

function extractTemplateVariables(uri: string): string[] {
  const vars: string[] = [];

  const isVariableChar = (char: string): boolean => {
    const code = char.charCodeAt(0);
    const isDigit = code >= 48 && code <= 57;
    const isUpper = code >= 65 && code <= 90;
    const isLower = code >= 97 && code <= 122;
    return isDigit || isUpper || isLower || code === 95;
  };

  let index = 0;
  while (index < uri.length) {
    const start = uri.indexOf('{', index);
    if (start === -1) break;
    const end = uri.indexOf('}', start + 1);
    if (end === -1) break;

    const raw = uri.slice(start + 1, end);
    let normalized = '';
    for (const char of raw) {
      if (isVariableChar(char)) {
        normalized += char.toLowerCase();
      }
    }
    if (normalized.length > 0) vars.push(normalized);
    index = end + 1;
  }
  return vars;
}

function isPathArgumentFromReference(
  argumentName: string,
  ref: unknown
): boolean {
  const resourceRef = parseResourceReference(ref);
  if (!resourceRef) return false;

  const normalizedArg = argumentName.toLowerCase();
  const templateVars = extractTemplateVariables(resourceRef.uri);
  if (templateVars.length === 0) return false;

  const matchesVariable = templateVars.includes(normalizedArg);
  if (!matchesVariable) return false;

  if (isPathLikeArgumentName(normalizedArg)) return true;
  if (resourceRef.uri.toLowerCase().includes('file:///')) return true;

  const uriLooksPathLike =
    resourceRef.uri.includes('/') &&
    (resourceRef.uri.toLowerCase().includes('path') ||
      resourceRef.uri.toLowerCase().includes('file') ||
      resourceRef.uri.toLowerCase().includes('dir') ||
      resourceRef.uri.toLowerCase().includes('root') ||
      resourceRef.uri.toLowerCase().includes('cwd'));

  return uriLooksPathLike;
}

function extractContextArguments(
  value: unknown
): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const context = value['arguments'];
  if (!isRecord(context)) return undefined;

  const normalized: Record<string, string> = {};
  let count = 0;
  for (const [key, entryValue] of Object.entries(context)) {
    if (typeof entryValue !== 'string') continue;
    normalized[key.toLowerCase()] = entryValue;
    count += 1;
  }
  if (count === 0) return undefined;
  return normalized;
}

function hasTrailingSeparator(value: string): boolean {
  return (
    value.endsWith(path.sep) || value.endsWith('/') || value.endsWith('\\')
  );
}

function isAbsolutePathInput(value: string): boolean {
  return (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/u.test(value) ||
    value.startsWith('\\\\')
  );
}

function resolveFromBase(
  base: string,
  rawValue: string,
  trailingSeparator: boolean
): {
  searchDir: string;
  prefix: string;
} {
  const normalizedValue = normalizePath(path.resolve(base, rawValue));
  if (trailingSeparator) {
    return { searchDir: normalizedValue, prefix: '' };
  }
  return {
    searchDir: path.dirname(normalizedValue),
    prefix: path.basename(normalizedValue),
  };
}

function resolveNamedRootContext(
  currentValue: string,
  allowed: string[]
):
  | {
      searchDir: string;
      prefix: string;
    }
  | undefined {
  const parsed = parseNamedRootInput(currentValue);
  if (!parsed) return undefined;

  const root = findAllowedRootByName(parsed.rootName, allowed);
  if (!root) return undefined;

  const trailingSeparator = hasTrailingSeparator(currentValue);
  return resolveFromBase(root, parsed.remainder, trailingSeparator);
}

function resolveNamedRootPath(
  value: string,
  allowed: string[]
): string | undefined {
  const parsed = parseNamedRootInput(value);
  if (!parsed) return undefined;

  const root = findAllowedRootByName(parsed.rootName, allowed);
  if (!root) return undefined;

  return normalizePath(path.resolve(root, parsed.remainder));
}

function parseNamedRootInput(
  value: string
): { rootName: string; remainder: string } | undefined {
  const normalizedInput = toPosixPath(value);
  const [rootName, ...rest] = normalizedInput.split('/');
  if (!rootName) return undefined;
  return { rootName, remainder: rest.join(path.sep) };
}

function findAllowedRootByName(
  rootName: string,
  allowed: readonly string[]
): string | undefined {
  const normalizedRootName = rootName.toLowerCase();
  return allowed.find(
    (candidate) => path.basename(candidate).toLowerCase() === normalizedRootName
  );
}

function chooseContextKeys(argumentName: string): string[] {
  const normalized = argumentName.toLowerCase();
  if (normalized === 'destination') {
    return ['source', 'path', 'cwd', 'root'];
  }
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

function resolveContextCandidatePath(
  candidate: string,
  allowed: string[]
): string | undefined {
  if (isAbsolutePathInput(candidate)) {
    return normalizePath(candidate);
  }

  if (allowed.length === 1) {
    const base = allowed[0];
    if (!base) return undefined;
    return normalizePath(path.resolve(base, candidate));
  }

  return resolveNamedRootPath(candidate, allowed);
}

async function toAllowedContextDirectory(
  resolved: string,
  allowed: string[]
): Promise<string | undefined> {
  if (!isPathWithinDirectories(resolved, allowed)) return undefined;

  try {
    const stats = await fs.stat(resolved);
    if (stats.isDirectory()) return resolved;
  } catch {
    // Fall back to parent path best-effort resolution.
  }

  const parent = path.dirname(resolved);
  return isPathWithinDirectories(parent, allowed) ? parent : undefined;
}

async function resolveContextBaseDirectory(
  argumentName: string,
  contextArguments: Record<string, string> | undefined,
  allowed: string[]
): Promise<string | undefined> {
  if (!contextArguments) {
    return undefined;
  }

  let hasContextArgument = false;
  for (const key in contextArguments) {
    if (!Object.prototype.hasOwnProperty.call(contextArguments, key)) continue;
    hasContextArgument = true;
    break;
  }
  if (!hasContextArgument) {
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

function getSearchContext(
  currentValue: string,
  allowed: string[],
  contextBase?: string
):
  | {
      searchDir: string;
      prefix: string;
    }
  | undefined {
  const trailingSeparator = hasTrailingSeparator(currentValue);

  if (isAbsolutePathInput(currentValue)) {
    return resolveFromBase(
      path.parse(currentValue).root || path.sep,
      currentValue,
      trailingSeparator
    );
  }

  const namedRootContext = resolveNamedRootContext(currentValue, allowed);
  if (namedRootContext) {
    return namedRootContext;
  }

  if (contextBase) {
    if (currentValue.length === 0) {
      return { searchDir: contextBase, prefix: '' };
    }
    return resolveFromBase(contextBase, currentValue, trailingSeparator);
  }

  if (allowed.length === 1) {
    const base = allowed[0];
    if (base) {
      return resolveFromBase(base, currentValue, trailingSeparator);
    }
  }
  return undefined;
}

async function findMatchesInDirectory(
  searchDir: string,
  prefix: string,
  allowed: string[]
): Promise<string[]> {
  const matches: string[] = [];
  if (!isPathWithinDirectories(searchDir, allowed)) {
    return matches;
  }

  try {
    const entries = await fs.readdir(searchDir, { withFileTypes: true });
    const lowerPrefix = prefix.toLowerCase();

    for (const entry of entries) {
      if (entry.name.toLowerCase().startsWith(lowerPrefix)) {
        const fullPath = path.join(searchDir, entry.name);
        const isDir = entry.isDirectory();
        matches.push(isDir ? `${fullPath}${path.sep}` : fullPath);
      }
    }
  } catch {
    // Access denied or not found, ignore
  }
  return matches;
}

function findRootPrefixMatches(
  currentValue: string,
  allowed: string[]
): string[] {
  const normalizedInput = toPosixPath(currentValue);
  const rootPrefix = (normalizedInput.split('/')[0] ?? '').toLowerCase();
  if (!rootPrefix) {
    const matches: string[] = [];
    for (const root of allowed) {
      matches.push(`${root}${path.sep}`);
    }
    return matches;
  }
  const matches: string[] = [];
  for (const root of allowed) {
    if (!path.basename(root).toLowerCase().startsWith(rootPrefix)) continue;
    matches.push(`${root}${path.sep}`);
  }
  return matches;
}

function findMatchingRoots(
  searchDir: string,
  prefix: string,
  allowed: string[]
): string[] {
  const matches: string[] = [];
  const lowerPrefix = prefix.toLowerCase();
  const normalizedSearchDir = normalizePath(searchDir);

  for (const root of allowed) {
    const rootDir = path.dirname(root);
    // Check if root is a direct child of searchDir
    if (normalizePath(rootDir) === normalizedSearchDir) {
      const rootName = path.basename(root);
      if (rootName.toLowerCase().startsWith(lowerPrefix)) {
        matches.push(`${root}${path.sep}`);
      }
    }
  }
  return matches;
}

export async function getPathCompletions(
  currentValue: string,
  options: CompletionOptions = {}
): Promise<CompletionResult> {
  const allowed = getAllowedDirectories();

  try {
    const contextBase = await resolveContextBaseDirectory(
      options.argumentName ?? '',
      options.contextArguments,
      allowed
    );

    // If no value and no context base, suggest roots.
    if (!currentValue && !contextBase) {
      return {
        values: allowed,
        total: allowed.length,
        hasMore: false,
      };
    }

    const context = getSearchContext(currentValue, allowed, contextBase);
    if (!context) {
      const rootMatches = findRootPrefixMatches(currentValue, allowed);
      const sliced = rootMatches.slice(0, MAX_COMPLETION_ITEMS);
      return {
        values: sliced,
        total: rootMatches.length,
        hasMore: rootMatches.length > MAX_COMPLETION_ITEMS,
      };
    }

    const { searchDir, prefix } = context;
    const dirMatches = await findMatchesInDirectory(searchDir, prefix, allowed);
    const rootMatches = findMatchingRoots(searchDir, prefix, allowed);

    // Deduplicate and sort
    const unique = new Set<string>();
    for (const match of dirMatches) unique.add(match);
    for (const match of rootMatches) unique.add(match);
    const uniqueMatches = Array.from(unique);

    uniqueMatches.sort((a, b) => {
      const aIsDir = a.endsWith(path.sep);
      const bIsDir = b.endsWith(path.sep);
      if (aIsDir && !bIsDir) return -1;
      if (!aIsDir && bIsDir) return 1;
      return a.localeCompare(b);
    });

    const sliced = uniqueMatches.slice(0, MAX_COMPLETION_ITEMS);

    return {
      values: sliced,
      total: uniqueMatches.length,
      hasMore: uniqueMatches.length > MAX_COMPLETION_ITEMS,
    };
  } catch {
    return { values: [] };
  }
}

export function registerCompletions(
  server: McpServer,
  instructions = ''
): void {
  const topicValues = extractTopicCompletions(instructions);

  server.server.setRequestHandler(CompleteRequestSchema, async (request) => {
    const { params } = request;
    const { argument, ref } = params;

    const argName = argument.name.toLowerCase();

    // Handle prompt topic completions
    if (isRecord(ref) && ref['type'] === 'ref/prompt' && argName === 'topic') {
      const currentValue = argument.value.toLowerCase();
      const filtered = currentValue
        ? topicValues.filter((v) => v.startsWith(currentValue))
        : topicValues;
      const sliced = filtered.slice(0, MAX_COMPLETION_ITEMS);
      return {
        completion: {
          values: sliced,
          total: filtered.length,
          hasMore: filtered.length > MAX_COMPLETION_ITEMS,
        },
      };
    }

    const isPathArg =
      isPathLikeArgumentName(argName) ||
      isPathArgumentFromReference(argName, ref);

    if (!isPathArg) {
      return { completion: { values: [], total: 0, hasMore: false } };
    }

    const now = Date.now();
    const sessionState = getCompletionState(server);
    const lastCallMs = sessionState.lastCallMs.get(argName) ?? 0;
    if (now - lastCallMs < COMPLETION_RATE_LIMIT_MS) {
      const lastResult = sessionState.lastResult.get(argName);
      if (lastResult) {
        return {
          completion: {
            values: lastResult.values,
            total: lastResult.total,
            hasMore: lastResult.hasMore,
          },
        };
      }
      return { completion: { values: [], total: 0, hasMore: false } };
    }
    sessionState.lastCallMs.set(argName, now);

    const contextArguments = extractContextArguments(params.context);
    const { value } = argument;
    const completions = await getPathCompletions(value, {
      argumentName: argName,
      ...(contextArguments ? { contextArguments } : {}),
    });

    sessionState.lastResult.set(argName, completions);

    return {
      completion: {
        values: completions.values,
        total: completions.total,
        hasMore: completions.hasMore,
      },
    };
  });
}
