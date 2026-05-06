# MCP v2 Schema/SDK Hygiene Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the custom `completion/complete` request handler in `src/completions.ts` with MCP v2-native `completable()` / `ResourceTemplate.complete` wiring, and migrate all `import { z } from 'zod'` to `import { z } from 'zod/v4'`.

**Architecture:** Extract path-completion logic into a standalone `src/lib/path-completer.ts` helper. Wire `completable()` on each prompt arg and `ResourceTemplate({ complete })` on the tool-info template. Delete `src/completions.ts` once both sides are live. Migrate zod imports atomically in one commit. Update tests last.

**Tech Stack:** MCP SDK `@modelcontextprotocol/server ^2.0.0-alpha.2`, zod 4.4.3, Node.js 24+, `node:test` runner.

---

## File Map

| Action | Path                                 | Responsibility                                         |
| ------ | ------------------------------------ | ------------------------------------------------------ |
| CREATE | `src/lib/path-completer.ts`          | All FS-walking path completion logic + WeakMap cache   |
| MODIFY | `src/prompts.ts`                     | Add `completable()` to 5 prompt args                   |
| MODIFY | `src/resources.ts`                   | Add `complete: { name }` to tool-info ResourceTemplate |
| DELETE | `src/completions.ts`                 | Entire file gone after wiring is in place              |
| MODIFY | `src/server/bootstrap.ts`            | Remove `registerCompletions` import and call           |
| MODIFY | 27 `src/**/*.ts` files               | `'zod'` → `'zod/v4'` import paths                      |
| MODIFY | `__tests__/unit/completions.test.ts` | Retarget tests to actual prompts/resources             |
| MODIFY | `__tests__/contract.test.ts`         | Add completion contract assertions                     |

---

## Task 1: Create `src/lib/path-completer.ts`

**Files:**

- Create: `src/lib/path-completer.ts`

This task extracts all path-completion logic from `src/completions.ts` into a standalone helper. No call sites change yet. The custom `setRequestHandler` in `completions.ts` still runs — there is no behavior change until Task 2.

- [ ] **Step 1: Create the file**

```ts
// src/lib/path-completer.ts
import type { McpServer } from '@modelcontextprotocol/server';

import { readdir, realpath, stat } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  parse,
  resolve,
  sep,
} from 'node:path';

import {
  getAllowedDirectories,
  isPathWithinDirectories,
  normalizePath,
  toPosixPath,
} from './paths.js';

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

function chooseContextKeys(argumentName: string): string[] {
  const normalized = argumentName.toLowerCase();
  if (normalized === 'destination') return [...DESTINATION_CONTEXT_KEYS];
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
    for (const entry of entries) {
      if (entry.name.toLowerCase().startsWith(lowerPrefix)) {
        const fullPath = join(searchDir, entry.name);
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
export async function completePath(
  value: string,
  options: CompletePathOptions = {}
): Promise<string[]> {
  const allowed = getAllowedDirectories();
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
  options: CompletePathOptions = {}
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
```

- [ ] **Step 2: Verify it type-checks**

```bash
node scripts/tasks.mjs --quick
```

Expected: all checks pass. No behavior change yet — `completions.ts` still handles the protocol.

- [ ] **Step 3: Commit**

```bash
git add src/lib/path-completer.ts
git commit -m "feat: extract path-completer helper from completions.ts"
```

---

## Task 2: Wire `completable()` into prompts and resources

**Files:**

- Modify: `src/prompts.ts`
- Modify: `src/resources.ts`

Add `completable()` to each prompt arg that needs it, and add `complete: { name }` to the tool-info `ResourceTemplate`. At this point both the old `setRequestHandler` and the new SDK dispatch coexist — the old handler still runs but the SDK's native path takes precedence for registered prompts/resources.

- [ ] **Step 1: Update `src/prompts.ts`**

Add these imports at the top (after existing imports):

```ts
import { completable } from '@modelcontextprotocol/server';

import { completePathCached } from './lib/path-completer.js';

import { getSortedToolContracts } from './resources/tool-info.js';
```

Add these two local helpers just before the first `export function`:

```ts
function extractTopics(instructions: string): string[] {
  const headers: string[] = [];
  for (const line of instructions.split('\n')) {
    if (line.startsWith('## ')) {
      const header = line.slice(3).trim().toLowerCase();
      if (header) headers.push(header);
    }
  }
  return headers;
}

function filterByPrefix(values: string[], prefix: string): string[] {
  const lower = prefix.toLowerCase();
  return lower ? values.filter((v) => v.startsWith(lower)) : [...values];
}
```

Replace `registerGetHelpPrompt` with:

```ts
export function registerGetHelpPrompt(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  const topics = extractTopics(instructions);
  const baseConfig = withDefaultIcons(
    { title: HELP_PROMPT_TITLE, description: HELP_PROMPT_DESCRIPTION },
    iconInfo
  );

  server.registerPrompt(
    HELP_PROMPT_NAME,
    {
      ...baseConfig,
      argsSchema: z.strictObject({
        topic: completable(
          z
            .string()
            .optional()
            .describe(
              'Optional section heading prefix (example: "error handling"). Omit to return full instructions.'
            ),
          (value) => filterByPrefix(topics, value ?? '')
        ),
      }),
    },
    ({ topic }): GetPromptResult => {
      const text = topic
        ? filterInstructionsByTopic(instructions, topic)
        : instructions;
      return {
        description: HELP_PROMPT_DESCRIPTION,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text,
              annotations: { audience: ['assistant'], priority: 1 },
            },
          },
        ],
      };
    }
  );
}
```

Replace `registerCompareFilesPrompt` with:

```ts
export function registerCompareFilesPrompt(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerPrompt(
    COMPARE_FILES_PROMPT_NAME,
    {
      ...withDefaultIcons(
        {
          title: COMPARE_FILES_PROMPT_TITLE,
          description: COMPARE_FILES_PROMPT_DESCRIPTION,
        },
        iconInfo
      ),
      argsSchema: z.strictObject({
        original: completable(
          z.string().describe('Path to the original file.'),
          (value, ctx) =>
            completePathCached(value, {
              server,
              argumentName: 'original',
              contextArguments: ctx?.arguments,
            })
        ),
        modified: completable(
          z.string().describe('Path to the modified file.'),
          (value, ctx) =>
            completePathCached(value, {
              server,
              argumentName: 'modified',
              contextArguments: ctx?.arguments,
            })
        ),
      }),
    },
    ({ original, modified }): GetPromptResult => ({
      description: COMPARE_FILES_PROMPT_DESCRIPTION,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Compare files and explain differences.\n\n1. Call \`diff_files\` with:\n   - original: ${original}\n   - modified: ${modified}\n2. Summarize: additions, deletions, and semantic changes.\n3. Flag any potential issues (conflicts, regressions, breaking changes).`,
            annotations: { audience: ['assistant'], priority: 1 },
          },
        },
      ],
    })
  );
}
```

Replace `registerAnalyzePathPrompt` with:

```ts
export function registerAnalyzePathPrompt(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerPrompt(
    ANALYZE_PATH_PROMPT_NAME,
    {
      ...withDefaultIcons(
        {
          title: ANALYZE_PATH_PROMPT_TITLE,
          description: ANALYZE_PATH_PROMPT_DESCRIPTION,
        },
        iconInfo
      ),
      argsSchema: z.strictObject({
        path: completable(
          z.string().describe('Absolute path to analyze.'),
          (value, ctx) =>
            completePathCached(value, {
              server,
              argumentName: 'path',
              contextArguments: ctx?.arguments,
            })
        ),
      }),
    },
    ({ path: targetPath }): GetPromptResult => ({
      description: ANALYZE_PATH_PROMPT_DESCRIPTION,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Analyze the path: ${targetPath}\n\n1. Call \`stat\` to determine if it is a file or directory.\n2. If file: call \`read\` with \`includeHash: true\` and summarize contents.\n3. If directory: call \`tree\` (maxDepth: 3) and \`ls\` to summarize structure.\n4. Report: type, size, permissions, key observations.`,
            annotations: { audience: ['assistant'], priority: 1 },
          },
        },
      ],
    })
  );
}
```

Replace `registerGetToolHelpPrompt` with:

```ts
export function registerGetToolHelpPrompt(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  const toolNames = getSortedToolContracts().map((c) => c.name);

  server.registerPrompt(
    GET_TOOL_HELP_PROMPT_NAME,
    {
      ...withDefaultIcons(
        {
          title: GET_TOOL_HELP_PROMPT_TITLE,
          description: GET_TOOL_HELP_PROMPT_DESCRIPTION,
        },
        iconInfo
      ),
      argsSchema: z.strictObject({
        name: completable(
          z
            .string()
            .min(1)
            .describe(
              'Tool name from tools/list or internal://tool-info/{name}.'
            ),
          (value) => filterByPrefix(toolNames, value)
        ),
      }),
    },
    ({ name }): GetPromptResult => {
      const toolName = findKnownToolName(name);
      if (!toolName) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown tool: ${name}`
        );
      }
      const toolInfo = buildToolInfo(toolName);
      if (!toolInfo) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown tool: ${toolName}`
        );
      }
      return {
        description: GET_TOOL_HELP_PROMPT_DESCRIPTION,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Use the embedded contract for \`${toolName}\` as the authoritative reference. ` +
                'Summarize when to use it, its key constraints, and the safest next action.',
              annotations: { audience: ['assistant'], priority: 1 },
            },
          },
          {
            role: 'user',
            content: {
              type: 'resource',
              resource: {
                uri: `internal://tool-info/${toolName}`,
                mimeType: 'text/markdown',
                text: toolInfo,
              },
              annotations: { audience: ['assistant'], priority: 1 },
            },
          },
        ],
      };
    }
  );
}
```

- [ ] **Step 2: Update `src/resources.ts`**

At the top of the file, add `getToolContracts` is already imported. Add `getSortedToolContracts` to that import from `./resources/tool-info.js`:

Change:

```ts
import { buildToolInfo, getToolContracts } from './resources/tool-info.js';
```

to:

```ts
import {
  buildToolInfo,
  getSortedToolContracts,
  getToolContracts,
} from './resources/tool-info.js';
```

Add a local `filterToolNames` helper before the first `export function`:

```ts
function filterToolNames(value: string): string[] {
  const toolNames = getSortedToolContracts().map((c) => c.name);
  const lower = value.toLowerCase();
  return lower ? toolNames.filter((n) => n.startsWith(lower)) : [...toolNames];
}
```

Replace the `TOOL_INFO_TEMPLATE` constant with:

```ts
const TOOL_INFO_TEMPLATE = new ResourceTemplate('internal://tool-info/{name}', {
  list: () => ({
    resources: getToolContracts().map((contract) => ({
      uri: `internal://tool-info/${contract.name}`,
      name: contract.name,
      title: contract.title,
      description: contract.description,
      mimeType: 'text/markdown',
    })),
  }),
  complete: {
    name: (value) => filterToolNames(value),
  },
});
```

- [ ] **Step 3: Verify type-check and tests pass**

```bash
node scripts/tasks.mjs --quick
```

Expected: all checks pass. The existing tests still import `registerCompletions` and still pass because `completions.ts` still exists.

- [ ] **Step 4: Commit**

```bash
git add src/prompts.ts src/resources.ts
git commit -m "feat: wire completable() into prompts and ResourceTemplate.complete"
```

---

## Task 3: Delete `completions.ts` and clean up `bootstrap.ts`; retarget tests

**Files:**

- Delete: `src/completions.ts`
- Modify: `src/server/bootstrap.ts`
- Modify: `__tests__/unit/completions.test.ts`

Delete the file, remove its import and call from bootstrap, and retarget the existing tests to the actual prompts and resources that now own the completion logic.

- [ ] **Step 1: Delete `src/completions.ts`**

```bash
rm src/completions.ts
```

Or simply delete the file in your editor.

- [ ] **Step 2: Remove `registerCompletions` from `src/server/bootstrap.ts`**

Remove line 42:

```ts
import { registerCompletions } from '../completions.js';
```

Remove line 252:

```ts
registerCompletions(server, serverInstructions);
```

No other changes needed — the `completions: {}` capability is already declared in `buildServerCapabilities` at line 84 and does not need to change.

- [ ] **Step 3: Replace `__tests__/unit/completions.test.ts`**

Replace the entire file with:

```ts
import { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import {
  normalizePath,
  setAllowedDirectoriesResolved,
} from '../../src/lib/paths.js';
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
  registerGetToolHelpPrompt,
} from '../../src/prompts.js';
import { registerToolInfoResource } from '../../src/resources.js';
import { buildServerInstructions } from '../../src/resources/generated-instructions.js';
import { LinkedTransport } from '../linked-transport.js';

function makeCompletionServer(withInstructions = false): McpServer {
  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { completions: {} } }
  );
  const instructions = withInstructions ? buildServerInstructions() : '';
  registerGetHelpPrompt(server, instructions);
  registerGetToolHelpPrompt(server);
  registerAnalyzePathPrompt(server);
  registerCompareFilesPrompt(server);
  registerToolInfoResource(server);
  return server;
}

async function connectPair(
  server: McpServer
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = LinkedTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
    },
  };
}

describe('completions', () => {
  it('does not reuse stale path suggestions for a different prefix inside the rate limit window', async () => {
    const tmpDir = await mkdtemp(
      join(tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`)
    );
    await writeFile(join(tmpDir, 'alpha.txt'), 'alpha', 'utf8');
    await writeFile(join(tmpDir, 'beta.txt'), 'beta', 'utf8');
    await setAllowedDirectoriesResolved([tmpDir]);

    const server = makeCompletionServer();
    const { client, cleanup } = await connectPair(server);

    try {
      const first = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: join(tmpDir, 'a') },
      });
      const second = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: join(tmpDir, 'b') },
      });

      assert.ok(
        first.completion.values.some((v) => v.endsWith('alpha.txt')),
        'first should include alpha.txt'
      );
      assert.ok(
        second.completion.values.some((v) => v.endsWith('beta.txt')),
        'second should include beta.txt'
      );
      assert.ok(
        !second.completion.values.some((v) => v.endsWith('alpha.txt')),
        'second should not include alpha.txt'
      );
    } finally {
      await cleanup();
      await rm(tmpDir, { recursive: true, force: true });
      await setAllowedDirectoriesResolved([]);
    }
  });

  it('does not collide cache keys when context values contain delimiter characters', async () => {
    const tmpDir = await mkdtemp(
      join(tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`)
    );
    const fooDir = join(tmpDir, 'foo');
    await mkdir(fooDir);
    await writeFile(join(fooDir, 'inside.txt'), 'inside', 'utf8');
    await setAllowedDirectoriesResolved([tmpDir]);

    const server = makeCompletionServer();
    const { client, cleanup } = await connectPair(server);

    try {
      // context cwd=fooDir → resolves inside fooDir → finds inside.txt
      const fromContextDirectory = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: '' },
        context: { arguments: { cwd: fooDir } },
      });
      // context key looks like a combined value — resolves to rootDir
      const withoutContextDirectory = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: '' },
        context: { arguments: { [`cwd&inside=${fooDir}`]: '1' } },
      });

      assert.ok(
        fromContextDirectory.completion.values.some((v) =>
          v.endsWith('inside.txt')
        ),
        'context cwd should resolve to fooDir'
      );
      assert.deepEqual(
        withoutContextDirectory.completion.values.map(normalizePath),
        [normalizePath(tmpDir)],
        'mangled context key should fall back to root'
      );
    } finally {
      await cleanup();
      await rm(tmpDir, { recursive: true, force: true });
      await setAllowedDirectoriesResolved([]);
    }
  });

  it('does not enumerate completion entries through a linked directory outside allowed roots', async () => {
    const tmpDir = await mkdtemp(
      join(tmpdir(), `fsmcp-complete-${randomUUID().slice(0, 8)}-`)
    );
    const allowedDir = join(tmpDir, 'allowed');
    const outsideDir = join(tmpDir, 'outside');
    const linkedDir = join(allowedDir, 'linked');
    await mkdir(allowedDir);
    await mkdir(outsideDir);
    await writeFile(join(outsideDir, 'secret.txt'), 'secret', 'utf8');
    await symlink(
      outsideDir,
      linkedDir,
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    await setAllowedDirectoriesResolved([allowedDir]);

    const server = makeCompletionServer();
    const { client, cleanup } = await connectPair(server);

    try {
      const direct = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: `${linkedDir}${require('path').sep}` },
      });
      const fromContext = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: '' },
        context: { arguments: { cwd: linkedDir } },
      });

      assert.ok(
        !direct.completion.values.some((v) => v.endsWith('secret.txt')),
        'symlink direct should not expose secret.txt'
      );
      assert.ok(
        !fromContext.completion.values.some((v) => v.endsWith('secret.txt')),
        'symlink via context should not expose secret.txt'
      );
    } finally {
      await cleanup();
      await rm(tmpDir, { recursive: true, force: true });
      await setAllowedDirectoriesResolved([]);
    }
  });

  it('completes tool names for the get-tool-help prompt', async () => {
    const server = makeCompletionServer();
    const { client, cleanup } = await connectPair(server);

    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-tool-help' },
        argument: { name: 'name', value: 're' },
      });

      assert.ok(
        result.completion.values.includes('read'),
        'should include read'
      );
      assert.ok(
        result.completion.values.includes('read_many'),
        'should include read_many'
      );
      assert.ok(
        !result.completion.values.includes('write'),
        'should not include write'
      );
    } finally {
      await cleanup();
    }
  });

  it('completes tool-info template names for resource references', async () => {
    const server = makeCompletionServer();
    const { client, cleanup } = await connectPair(server);

    try {
      const result = await client.complete({
        ref: { type: 'ref/resource', uri: 'internal://tool-info/{name}' },
        argument: { name: 'name', value: 'st' },
      });

      assert.ok(
        result.completion.values.includes('stat'),
        'should include stat'
      );
      assert.ok(
        result.completion.values.includes('stat_many'),
        'should include stat_many'
      );
      assert.ok(
        !result.completion.values.includes('read'),
        'should not include read'
      );
    } finally {
      await cleanup();
    }
  });

  it('completes topic sections for the get-help prompt', async () => {
    const server = makeCompletionServer(true);
    const { client, cleanup } = await connectPair(server);

    try {
      const all = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'topic', value: '' },
      });
      const filtered = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'topic', value: 'er' },
      });

      assert.ok(
        all.completion.values.length > 0,
        'should return at least one topic'
      );
      assert.ok(
        filtered.completion.values.every((v) => v.startsWith('er')),
        'filtered topics should all start with "er"'
      );
    } finally {
      await cleanup();
    }
  });

  it('returns empty completions for arg names not declared by the prompt', async () => {
    const server = makeCompletionServer();
    const { client, cleanup } = await connectPair(server);

    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: 'x' },
      });

      assert.deepEqual(
        result.completion.values,
        [],
        'get-help has no path arg — must return empty'
      );
    } finally {
      await cleanup();
    }
  });
});
```

- [ ] **Step 4: Verify tests pass**

```bash
node scripts/tasks.mjs
```

Expected: all checks pass including the updated completions tests. If `path.sep` import from `require` causes ESM issues in the symlink test, replace `require('path').sep` with `import { sep } from 'node:path'` at the top and use `sep` directly.

- [ ] **Step 5: Commit**

```bash
git add src/completions.ts src/server/bootstrap.ts __tests__/unit/completions.test.ts
git commit -m "refactor: delete completions.ts; route completions through SDK-native completable()"
```

---

## Task 4: Migrate `zod` → `zod/v4` across all source files

**Files:**

- Modify: all `src/**/*.ts` files currently importing from `'zod'` (27 files)

This is a single-commit atomic change. Partial migration causes type errors at SDK boundaries.

- [ ] **Step 1: Verify the full list of files to change**

```bash
grep -rln "from 'zod'" src/
```

Expected output (27 files — the list below. If you see any extras, include them too):

```
src/lib/file-operations/search.ts
src/lib/zod-codecs.ts
src/pkg-info.ts
src/prompts.ts
src/resources/tool-info.ts
src/schemas.ts
src/server/roots-manager.ts
src/tools/apply-patch.ts
src/tools/calculate-hash.ts
src/tools/contract.ts
src/tools/create-directory.ts
src/tools/delete-file.ts
src/tools/diff-files.ts
src/tools/edit-file.ts
src/tools/list-directory.ts
src/tools/move-file.ts
src/tools/read-multiple.ts
src/tools/read.ts
src/tools/replace-in-files.ts
src/tools/roots.ts
src/tools/search-content.ts
src/tools/search-files.ts
src/tools/shared.ts
src/tools/stat-many.ts
src/tools/stat.ts
src/tools/tree.ts
src/tools/write-file.ts
```

- [ ] **Step 2: Apply the change to every file**

Run this from the repository root (Bash):

```bash
grep -rln "from 'zod'" src/ | xargs sed -i "s|from 'zod'|from 'zod/v4'|g"
```

On Windows PowerShell if `sed` is unavailable:

```powershell
$files = Get-ChildItem -Recurse src/ -Include "*.ts" | Select-String "from 'zod'" -List | Select-Object -ExpandProperty Path
foreach ($f in $files) {
  (Get-Content $f) -replace "from 'zod'", "from 'zod/v4'" | Set-Content $f
}
```

- [ ] **Step 3: Verify no bare zod imports remain**

```bash
grep -rn "from 'zod'" src/
```

Expected: **zero** matches. Only `from 'zod/v4'` should appear.

- [ ] **Step 4: Run full check suite**

```bash
node scripts/tasks.mjs
```

Expected: all checks pass. No behavioral change — zod 4.x is still the same library; the subpath just makes the v4 namespace explicit.

- [ ] **Step 5: Commit**

```bash
git add src/
git commit -m "refactor: migrate zod imports from 'zod' to 'zod/v4'"
```

---

## Task 5: Add completion contract test

**Files:**

- Modify: `__tests__/contract.test.ts`

Add a new `describe` block that asserts each prompt/resource with completion-sensitive args actually returns non-empty results when the right arg name is used, and returns empty for unknown args. This catches regressions where someone adds a prompt arg and forgets `completable()`.

- [ ] **Step 1: Add imports and test block to `__tests__/contract.test.ts`**

Add this import block at the top of the file alongside the existing imports:

```ts
import { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';

import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
```

Then add this `describe` block at the bottom of the file (after the existing `describe('Tool contract', ...)` block):

```ts
describe('Completion contract', () => {
  // Verify that all prompts and resource templates that declare completable
  // args actually return completions — and that undeclared args return empty.
  // A regression here means someone added a prompt arg without completable().

  async function makeServer(): Promise<{
    server: McpServer;
    client: Client;
    tmpDir: string;
    teardown: () => Promise<void>;
  }> {
    const {
      registerGetHelpPrompt,
      registerGetToolHelpPrompt,
      registerAnalyzePathPrompt,
      registerCompareFilesPrompt,
    } = await import('../src/prompts.js');
    const { registerToolInfoResource } = await import('../src/resources.js');
    const { buildServerInstructions } =
      await import('../src/resources/generated-instructions.js');
    const { setAllowedDirectoriesResolved } =
      await import('../src/lib/paths.js');
    const { LinkedTransport } = await import('./linked-transport.js');

    const tmpDir = await mkdtemp(
      join(tmpdir(), `fsmcp-cc-${randomUUID().slice(0, 8)}-`)
    );
    await writeFile(join(tmpDir, 'sample.txt'), 'sample');
    await setAllowedDirectoriesResolved([tmpDir]);

    const server = new McpServer(
      { name: 'contract-completion-server', version: '0.0.0' },
      { capabilities: { completions: {} } }
    );

    const instructions = buildServerInstructions();
    registerGetHelpPrompt(server, instructions);
    registerGetToolHelpPrompt(server);
    registerAnalyzePathPrompt(server);
    registerCompareFilesPrompt(server);
    registerToolInfoResource(server);

    const client = new Client({ name: 'contract-client', version: '1.0.0' });
    const [ct, st] = LinkedTransport.createLinkedPair();
    await server.connect(st);
    await client.connect(ct);

    return {
      server,
      client,
      tmpDir,
      teardown: async () => {
        await client.close().catch(() => {});
        await server.close().catch(() => {});
        await rm(tmpDir, { recursive: true, force: true });
        await setAllowedDirectoriesResolved([]);
      },
    };
  }

  it('analyze-path: path arg returns path completions', async () => {
    const { client, tmpDir, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'analyze-path' },
        argument: { name: 'path', value: tmpDir },
      });
      assert.ok(
        result.completion.values.length > 0,
        'analyze-path.path must return completions'
      );
    } finally {
      await teardown();
    }
  });

  it('compare-files: original arg returns path completions', async () => {
    const { client, tmpDir, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'compare-files' },
        argument: { name: 'original', value: tmpDir },
      });
      assert.ok(
        result.completion.values.length > 0,
        'compare-files.original must return completions'
      );
    } finally {
      await teardown();
    }
  });

  it('compare-files: modified arg returns path completions', async () => {
    const { client, tmpDir, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'compare-files' },
        argument: { name: 'modified', value: tmpDir },
      });
      assert.ok(
        result.completion.values.length > 0,
        'compare-files.modified must return completions'
      );
    } finally {
      await teardown();
    }
  });

  it('get-help: topic arg returns section completions', async () => {
    const { client, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'topic', value: '' },
      });
      assert.ok(
        result.completion.values.length > 0,
        'get-help.topic must return at least one topic'
      );
    } finally {
      await teardown();
    }
  });

  it('get-help: undeclared arg returns empty', async () => {
    const { client, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-help' },
        argument: { name: 'path', value: '/any' },
      });
      assert.deepEqual(
        result.completion.values,
        [],
        'get-help has no path arg — must return empty (strict SDK dispatch)'
      );
    } finally {
      await teardown();
    }
  });

  it('get-tool-help: name arg returns tool name completions', async () => {
    const { client, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/prompt', name: 'get-tool-help' },
        argument: { name: 'name', value: 'gr' },
      });
      assert.ok(
        result.completion.values.includes('grep'),
        'get-tool-help.name must include grep for prefix "gr"'
      );
    } finally {
      await teardown();
    }
  });

  it('internal://tool-info/{name}: name variable returns tool name completions', async () => {
    const { client, teardown } = await makeServer();
    try {
      const result = await client.complete({
        ref: { type: 'ref/resource', uri: 'internal://tool-info/{name}' },
        argument: { name: 'name', value: 'wr' },
      });
      assert.ok(
        result.completion.values.includes('write'),
        'tool-info template must complete "wr" to include write'
      );
    } finally {
      await teardown();
    }
  });
});
```

- [ ] **Step 2: Run the full suite**

```bash
node scripts/tasks.mjs
```

Expected: all checks pass including the 7 new contract tests.

- [ ] **Step 3: Confirm knip doesn't flag path-completer as unused**

`path-completer.ts` exports `completePath` (for direct use if needed) and `completePathCached` (used in `prompts.ts`). Both should be reachable.

```bash
node scripts/tasks.mjs --quick
```

Expected: no knip violations.

- [ ] **Step 4: Commit**

```bash
git add __tests__/contract.test.ts
git commit -m "test: add completion contract tests for prompts and resource templates"
```

---

## Final Verification

- [ ] Run `node scripts/tasks.mjs` — all stages green (format, lint, type-check, knip, test, rebuild).
- [ ] Run `grep -rn "from 'zod'" src/` — zero matches.
- [ ] Run `grep -rn "completions\.js\|registerCompletions" src/` — zero matches.
- [ ] Run `node scripts/tasks.mjs --quick` — lint confirms no unused exports in path-completer.ts.
- [ ] Smoke test (optional): `npm run inspector` → ask for path completion on `analyze-path` prompt and confirm suggestions appear.

---

## Self-Review Notes

**Spec coverage check:**

- ✅ `zod/v4` migration — Task 4
- ✅ `completable()` on `get-help.topic` — Task 2 step 1
- ✅ `completable()` on `get-tool-help.name` — Task 2 step 1
- ✅ `completable()` on `analyze-path.path` — Task 2 step 1
- ✅ `completable()` on `compare-files.original` and `compare-files.modified` — Task 2 step 1
- ✅ `ResourceTemplate.complete.name` for tool-info — Task 2 step 2
- ✅ WeakMap per-server cache preserved — Task 1 (`completePathCached`)
- ✅ `completions.ts` deleted — Task 3 step 1
- ✅ `registerCompletions` removed from `bootstrap.ts` — Task 3 step 2
- ✅ `completions.test.ts` retargeted to actual prompts — Task 3 step 3
- ✅ New contract test for each prompt/resource — Task 5
- ✅ Cross-tool enum scan not migrated (it's simply gone) — covered by deletion in Task 3
- ✅ Spec migration risk #4 (context arg passing) — confirmed valid by reading SDK types: `CompleteCallback` receives `(value, context?: { arguments?: Record<string, string> })` — context IS available

**Placeholder check:** No TBDs or open questions. `require('path').sep` in symlink test: convert to top-level `import { sep } from 'node:path'` to stay ESM-clean.

**Type consistency:** `completePathCached` is used in `prompts.ts` (tasks 2 and 3); it's defined in `path-completer.ts` (task 1). `CompletePathOptions.server` is `McpServer` from `@modelcontextprotocol/server` — same type used in all registration functions.
