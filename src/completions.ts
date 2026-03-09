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

import { getSortedToolContracts } from './resources/tool-info.js';

const MAX_COMPLETION_ITEMS = 100;
const COMPLETION_RATE_LIMIT_MS = 100;
const MAX_COMPLETION_CACHE_KEYS = 128;

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

function extractToolNameCompletions(): string[] {
  return getSortedToolContracts().map((contract) => contract.name);
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

const DESTINATION_CONTEXT_KEYS = ['source', 'path', 'cwd', 'root'] as const;
const PRIMARY_PATH_CONTEXT_KEYS = ['path', 'cwd', 'root'] as const;
const DEFAULT_CONTEXT_KEYS = ['path', 'source', 'cwd', 'root'] as const;

const ENUM_ARGUMENT_VALUES = new Map<string, readonly string[]>([
  ['sortby', ['modified', 'name', 'path', 'size', 'type']],
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

function getEnumCompletions(
  argName: string,
  currentValue: string
): CompletionResult | undefined {
  const values = ENUM_ARGUMENT_VALUES.get(argName);
  if (!values) return undefined;
  const prefix = currentValue.toLowerCase();
  const filtered = prefix
    ? values.filter((v) => v.startsWith(prefix))
    : [...values];
  return buildCompletionResult(filtered);
}

function isTemplateVariableChar(char: string): boolean {
  const code = char.charCodeAt(0);
  const isDigit = code >= 48 && code <= 57;
  const isUpper = code >= 65 && code <= 90;
  const isLower = code >= 97 && code <= 122;
  return isDigit || isUpper || isLower || code === 95;
}

function normalizeTemplateVariable(raw: string): string {
  let normalized = '';
  for (const char of raw) {
    if (isTemplateVariableChar(char)) {
      normalized += char.toLowerCase();
    }
  }
  return normalized;
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

  let index = 0;
  while (index < uri.length) {
    const start = uri.indexOf('{', index);
    if (start === -1) break;
    const end = uri.indexOf('}', start + 1);
    if (end === -1) break;

    const normalized = normalizeTemplateVariable(uri.slice(start + 1, end));
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

function serializeCompletionRef(ref: unknown): {
  type: string;
  name?: string;
  uri?: string;
} {
  if (!isRecord(ref) || typeof ref['type'] !== 'string') {
    return { type: 'unknown' };
  }
  if (ref['type'] === 'ref/prompt' && typeof ref['name'] === 'string') {
    return { type: ref['type'], name: ref['name'] };
  }
  if (ref['type'] === 'ref/resource' && typeof ref['uri'] === 'string') {
    return { type: ref['type'], uri: ref['uri'] };
  }
  return { type: ref['type'] };
}

function serializeContextArguments(
  contextArguments: Record<string, string> | undefined
): [string, string][] {
  if (!contextArguments) return [];
  return Object.entries(contextArguments).sort(([left], [right]) =>
    left.localeCompare(right)
  );
}

function buildCompletionCacheKey(params: {
  argumentName: string;
  value: string;
  ref: unknown;
  contextArguments?: Record<string, string>;
}): string {
  return JSON.stringify({
    argumentName: params.argumentName.toLowerCase(),
    value: params.value,
    ref: serializeCompletionRef(params.ref),
    contextArguments: serializeContextArguments(params.contextArguments),
  });
}

function rememberCompletionCacheValue<T>(
  cache: Map<string, T>,
  key: string,
  value: T
): void {
  if (cache.has(key)) {
    cache.delete(key);
  }
  cache.set(key, value);
  while (cache.size > MAX_COMPLETION_CACHE_KEYS) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
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
    return [...DESTINATION_CONTEXT_KEYS];
  }
  if (
    normalized === 'path' ||
    normalized === 'source' ||
    normalized === 'original' ||
    normalized === 'modified' ||
    normalized === 'file'
  ) {
    return [...PRIMARY_PATH_CONTEXT_KEYS];
  }
  return [...DEFAULT_CONTEXT_KEYS];
}

function hasContextArguments(
  contextArguments: Record<string, string> | undefined
): contextArguments is Record<string, string> {
  return (
    contextArguments !== undefined && Object.keys(contextArguments).length > 0
  );
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
  if (!hasContextArguments(contextArguments)) {
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
  return value.endsWith(path.sep) ? value : `${value}${path.sep}`;
}

function buildCompletionResult(values: readonly string[]): CompletionResult {
  return {
    values: values.slice(0, MAX_COMPLETION_ITEMS),
    total: values.length,
    hasMore: values.length > MAX_COMPLETION_ITEMS,
  };
}

function buildCompletionResponse(result: CompletionResult): {
  completion: CompletionResult;
} {
  return { completion: result };
}

function sortCompletionMatches(matches: string[]): void {
  matches.sort((left, right) => {
    const leftIsDir = left.endsWith(path.sep);
    const rightIsDir = right.endsWith(path.sep);
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
    for (const match of group) {
      uniqueMatches.add(match);
    }
  }

  const merged = [...uniqueMatches];
  sortCompletionMatches(merged);
  return merged;
}

function getRootPrefix(currentValue: string): string {
  const normalizedInput = toPosixPath(currentValue);
  return (normalizedInput.split('/')[0] ?? '').toLowerCase();
}

function collectAllowedRoots(
  allowed: readonly string[],
  predicate: (root: string) => boolean
): string[] {
  const matches: string[] = [];
  for (const root of allowed) {
    if (predicate(root)) {
      matches.push(withDirectorySeparator(root));
    }
  }
  return matches;
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
  const rootPrefix = getRootPrefix(currentValue);
  if (!rootPrefix) {
    return collectAllowedRoots(allowed, () => true);
  }

  return collectAllowedRoots(allowed, (root) =>
    path.basename(root).toLowerCase().startsWith(rootPrefix)
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
    const rootDir = path.dirname(root);
    // Check if root is a direct child of searchDir
    if (normalizePath(rootDir) !== normalizedSearchDir) return false;
    return path.basename(root).toLowerCase().startsWith(lowerPrefix);
  });
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
      return buildCompletionResult(allowed);
    }

    const context = getSearchContext(currentValue, allowed, contextBase);
    if (!context) {
      return buildCompletionResult(
        findRootPrefixMatches(currentValue, allowed)
      );
    }

    const { searchDir, prefix } = context;
    const dirMatches = await findMatchesInDirectory(searchDir, prefix, allowed);
    const rootMatches = findMatchingRoots(searchDir, prefix, allowed);
    return buildCompletionResult(
      mergeCompletionMatches(dirMatches, rootMatches)
    );
  } catch {
    return { values: [] };
  }
}

export function registerCompletions(
  server: McpServer,
  instructions = ''
): void {
  const topicValues = extractTopicCompletions(instructions);
  const toolNameValues = extractToolNameCompletions();

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
      return buildCompletionResponse(buildCompletionResult(filtered));
    }

    if (
      isRecord(ref) &&
      ref['type'] === 'ref/prompt' &&
      ref['name'] === 'get-tool-help' &&
      argName === 'name'
    ) {
      const currentValue = argument.value.toLowerCase();
      const filtered = currentValue
        ? toolNameValues.filter((value) => value.startsWith(currentValue))
        : toolNameValues;
      return buildCompletionResponse(buildCompletionResult(filtered));
    }

    if (
      isRecord(ref) &&
      ref['type'] === 'ref/resource' &&
      ref['uri'] === 'internal://tool-info/{name}' &&
      argName === 'name'
    ) {
      const currentValue = argument.value.toLowerCase();
      const filtered = currentValue
        ? toolNameValues.filter((value) => value.startsWith(currentValue))
        : toolNameValues;
      return buildCompletionResponse(buildCompletionResult(filtered));
    }

    const enumResult = getEnumCompletions(argName, argument.value);
    if (enumResult) {
      return buildCompletionResponse(enumResult);
    }

    const isPathArg =
      isPathLikeArgumentName(argName) ||
      isPathArgumentFromReference(argName, ref);

    if (!isPathArg) {
      return buildCompletionResponse(buildCompletionResult([]));
    }

    const contextArguments = extractContextArguments(params.context);
    const cacheKey = buildCompletionCacheKey({
      argumentName: argName,
      value: argument.value,
      ref,
      ...(contextArguments ? { contextArguments } : {}),
    });
    const now = Date.now();
    const sessionState = getCompletionState(server);
    const lastCallMs = sessionState.lastCallMs.get(cacheKey) ?? 0;
    if (now - lastCallMs < COMPLETION_RATE_LIMIT_MS) {
      const lastResult = sessionState.lastResult.get(cacheKey);
      if (lastResult) {
        return buildCompletionResponse(lastResult);
      }
      return buildCompletionResponse(buildCompletionResult([]));
    }
    rememberCompletionCacheValue(sessionState.lastCallMs, cacheKey, now);

    const { value } = argument;
    const completions = await getPathCompletions(value, {
      argumentName: argName,
      ...(contextArguments ? { contextArguments } : {}),
    });

    rememberCompletionCacheValue(
      sessionState.lastResult,
      cacheKey,
      completions
    );

    return buildCompletionResponse(completions);
  });
}
