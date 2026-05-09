# Prompts Subsystem Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite `src/prompts.ts` end-to-end into a single-file, contract-driven registry shipping 5 prompts (`get-help`, `analyze-path`, `compare-files`, `find-in-tree`, `summarize-directory`) that use `resource_link` content blocks and consume a typed `INSTRUCTION_SECTIONS` source of truth.

**Architecture:** Single `src/prompts.ts` mirroring the `tools.ts`/`resources.ts` pattern: file-local `PromptContract` + `PromptEntry` types, inline helpers (`pathArg`, `topicArg`, `userText`, `linkToInstructions`, `linkToPath`, `wrapHandler`), 5 prompt entries, and one exported `registerAllPrompts(server, options)`. `src/resources/instructions.ts` exports `INSTRUCTION_SECTIONS: Record<string,string>` so `get-help` does typed key lookups instead of regex parsing.

**Tech Stack:** TypeScript (strict, NodeNext, verbatimModuleSyntax), Zod v4 (`zod/v4`), `@modelcontextprotocol/server` 2.x (`McpServer.registerPrompt`, `completable`), `node:test` via `tsx/esm`.

**Spec:** [docs/superpowers/specs/2026-05-09-prompts-redesign-design.md](../specs/2026-05-09-prompts-redesign-design.md)

---

## File Structure

| File                                 | Action         | Responsibility                                                                                                    |
| ------------------------------------ | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/resources/instructions.ts`      | Modify         | Add `INSTRUCTION_SECTIONS` typed map; keep rendering `SERVER_INSTRUCTIONS_CONTENT` from it.                       |
| `src/prompts.ts`                     | Rewrite (full) | Single registry: types, helpers, 5 prompt entries, `registerAllPrompts` export, `ALL_PROMPTS` export.             |
| `src/server/bootstrap.ts`            | Modify         | Replace 3 `register*Prompt` calls with one `registerAllPrompts` call.                                             |
| `__tests__/prompts.test.ts`          | Rewrite        | Structural assertions per prompt; cover all 5 prompts; path-guard rejection cases.                                |
| `__tests__/contract.test.ts`         | Modify         | Update `Completion contract` block to use `registerAllPrompts`; add prompts contract assertions on `ALL_PROMPTS`. |
| `__tests__/unit/completions.test.ts` | Modify         | Update imports + helper to use `registerAllPrompts`.                                                              |
| `__tests__/prompts-stdio.test.ts`    | Modify         | Update prose-matching assertions to structural ones; add new-prompt smoke test.                                   |

---

## Task 1: Refactor instructions.ts to expose typed sections

**Files:**

- Modify: `src/resources/instructions.ts`
- Test: `__tests__/resources/instructions.test.ts`

- [ ] **Step 1: Write failing test for INSTRUCTION_SECTIONS export**

Append to `__tests__/resources/instructions.test.ts`:

```ts
import { INSTRUCTION_SECTIONS } from '../../src/resources/instructions.js';

describe('INSTRUCTION_SECTIONS', () => {
  it('exposes the four documented sections as non-empty strings', () => {
    const keys = Object.keys(INSTRUCTION_SECTIONS).sort();
    assert.deepEqual(keys, ['constraints', 'error_recovery', 'guidelines', 'tools_overview']);
    for (const [name, body] of Object.entries(INSTRUCTION_SECTIONS)) {
      assert.equal(typeof body, 'string', `${name} must be string`);
      assert.ok(body.trim().length > 0, `${name} must not be empty`);
    }
  });

  it('SERVER_INSTRUCTIONS_CONTENT contains every section body', async () => {
    const { SERVER_INSTRUCTIONS_CONTENT } = await import('../../src/resources/instructions.js');
    for (const body of Object.values(INSTRUCTION_SECTIONS)) {
      assert.ok(
        SERVER_INSTRUCTIONS_CONTENT.includes(body.trim()),
        'rendered instructions must include every section body',
      );
    }
  });
});
```

- [ ] **Step 2: Run the new test and confirm it fails**

Run: `node --test --import tsx/esm __tests__/resources/instructions.test.ts`
Expected: FAIL — `INSTRUCTION_SECTIONS` is not exported.

- [ ] **Step 3: Refactor `src/resources/instructions.ts` to export the typed map**

Replace the body of `buildServerInstructions()` and the `SERVER_INSTRUCTIONS_CONTENT` const with:

````ts
function buildSectionsRecord(): Record<string, string> {
  const maxFileMb = Math.floor(MAX_TEXT_FILE_SIZE / 1024 / 1024);
  return {
    guidelines: [
      'Guidelines:',
      '```',
      'root_access: When using filesystem tools, operate strictly within allowed roots.',
      'path_resolution: Always resolve paths before acting — never assume.',
      '```',
    ].join('\n'),
    tools_overview: [
      'Tools Overview:',
      buildToolsOverview(),
      '',
      'Full schemas, descriptions, and annotations are in `tools/list`.',
    ].join('\n'),
    constraints: [
      'Constraints:',
      '```',
      'allowed_roots: Operate within allowed roots only (negotiated at startup via CLI).',
      'sensitive_paths: Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.',
      `enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.`,
      'ephemeral_results: When a tool returns resourceUri, call resources/read immediately — cached results are ephemeral and expire after 30 min, eviction, or restart.',
      '```',
    ].join('\n'),
    error_recovery: [
      'Error Recovery:',
      '```',
      'ACCESS_DENIED: Run roots to list allowed directories, retry with a valid path.',
      'NOT_FOUND: Run ls or find to verify the path.',
      'TOO_LARGE: Use head/tail, line ranges, or split across read_many.',
      'TIMEOUT: Reduce scope, depth, or maxResults.',
      'INVALID_INPUT: Re-read the tool schema in tools/list.',
      '```',
    ].join('\n'),
  };
}

export const INSTRUCTION_SECTIONS: Record<string, string> = buildSectionsRecord();

export const SERVER_INSTRUCTIONS_CONTENT = `\n${Object.values(INSTRUCTION_SECTIONS).join('\n\n')}\n`;
````

Delete the old `buildServerInstructions` function. The exported `createInstructionsResource()` continues to read `SERVER_INSTRUCTIONS_CONTENT` unchanged.

- [ ] **Step 4: Run tests**

Run: `node --test --import tsx/esm __tests__/resources/instructions.test.ts`
Expected: PASS.

Run: `npm run type-check`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add src/resources/instructions.ts __tests__/resources/instructions.test.ts
git commit -m "refactor(instructions): export INSTRUCTION_SECTIONS typed map"
```

---

## Task 2: Skeleton rewrite of prompts.ts (types, helpers, registry shell)

This task drops the prompts.ts internals and stands up the new shell. Existing tests will break temporarily; later tasks restore them.

**Files:**

- Rewrite: `src/prompts.ts`

- [ ] **Step 1: Replace `src/prompts.ts` entirely with the new shell**

```ts
import {
  completable,
  type GetPromptResult,
  type McpServer,
  type PromptMessage,
} from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { Logger } from './lib/logger.js';
import { completePathCached } from './lib/path-completer.js';
import type { PathGuard } from './lib/path-guard.js';

import { INSTRUCTION_SECTIONS } from './resources/instructions.js';
import { type IconInfo, withDefaultIcons } from './tools/shared.js';

// --- Types ---

export interface PromptContract {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly requiresPathGuard: boolean;
}

export interface PromptRegistrationOptions {
  pathGuard: PathGuard;
  instructions: string;
  isInitialized: () => boolean;
  iconInfo?: IconInfo;
}

interface PromptEntry {
  readonly contract: PromptContract;
  readonly register: (server: McpServer, options: PromptRegistrationOptions) => void;
}

// --- Helpers ---

function pathArg(
  server: McpServer,
  guard: PathGuard,
  argumentName: string,
  description: string,
): ReturnType<typeof completable<z.ZodString>> {
  return completable(z.string().describe(description), (value, ctx) =>
    completePathCached(value, {
      server,
      pathGuard: guard,
      argumentName,
      ...(ctx?.arguments ? { contextArguments: ctx.arguments } : {}),
    }),
  );
}

function topicArg(
  topics: readonly string[],
  description: string,
): ReturnType<typeof completable<z.ZodString>> {
  return completable(z.string().describe(description), (value) => {
    const lower = value.toLowerCase();
    return lower ? topics.filter((t) => t.startsWith(lower)) : [...topics];
  });
}

function userText(text: string): PromptMessage {
  return {
    role: 'user',
    content: {
      type: 'text',
      text,
      annotations: { audience: ['assistant'], priority: 1 },
    },
  };
}

function linkToInstructions(): PromptMessage {
  return {
    role: 'user',
    content: {
      type: 'resource_link',
      uri: 'internal://instructions',
      name: 'filesystem-mcp-instructions',
      mimeType: 'text/markdown',
      annotations: { audience: ['assistant'], priority: 0.5 },
    },
  };
}

function linkToPath(absPath: string): PromptMessage {
  return {
    role: 'user',
    content: {
      type: 'resource_link',
      uri: `file://${absPath}`,
      name: absPath,
      annotations: { audience: ['assistant'], priority: 1 },
    },
  };
}

function wrapHandler<T>(
  name: string,
  options: PromptRegistrationOptions,
  requiresInit: boolean,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  if (requiresInit && !options.isInitialized()) {
    throw new Error(`Prompt ${name} called before roots are initialized`);
  }
  const start = Date.now();
  const result = fn();
  if (result instanceof Promise) {
    return result.finally(() => {
      Logger.debug(`prompt resolved`, { name, durationMs: Date.now() - start });
    });
  }
  Logger.debug(`prompt resolved`, { name, durationMs: Date.now() - start });
  return result;
}

// --- Prompt entries (filled in by later tasks) ---

const PROMPT_ENTRIES: PromptEntry[] = [];

export const ALL_PROMPTS: PromptContract[] = PROMPT_ENTRIES.map((e) => e.contract);

export function registerAllPrompts(server: McpServer, options: PromptRegistrationOptions): void {
  for (const { register } of PROMPT_ENTRIES) {
    register(server, options);
  }
}
```

- [ ] **Step 2: Type-check (will fail downstream consumers)**

Run: `npm run type-check`
Expected: FAIL with errors in `bootstrap.ts`, `__tests__/prompts.test.ts`, `__tests__/unit/completions.test.ts`, `__tests__/contract.test.ts`, `__tests__/prompts-stdio.test.ts` (missing exports `registerGetHelpPrompt`, etc.). This is expected — fixed in tasks 8 + 10.

- [ ] **Step 3: Commit (skeleton, broken downstream)**

```sh
git add src/prompts.ts
git commit -m "refactor(prompts): introduce contract+registry skeleton (WIP)"
```

---

## Task 3: Implement `get-help` prompt entry

**Files:**

- Modify: `src/prompts.ts`

- [ ] **Step 1: Add the entry above `const PROMPT_ENTRIES`**

Insert just before `const PROMPT_ENTRIES: PromptEntry[] = [];`:

```ts
const GET_HELP: PromptEntry = {
  contract: {
    name: 'get-help',
    title: 'Get Help',
    description: 'Return filesystem-mcp usage instructions, optionally filtered to a section.',
    requiresPathGuard: false,
  },
  register(server, options) {
    const topics = Object.keys(INSTRUCTION_SECTIONS);
    server.registerPrompt(
      GET_HELP.contract.name,
      withDefaultIcons(
        {
          title: GET_HELP.contract.title,
          description: GET_HELP.contract.description,
          argsSchema: z.strictObject({
            topic: topicArg(
              topics,
              'Optional section key. Omit to return full instructions.',
            ).optional(),
          }),
        },
        options.iconInfo,
      ),
      ({ topic }): GetPromptResult =>
        wrapHandler(GET_HELP.contract.name, options, false, () => {
          const section = topic ? INSTRUCTION_SECTIONS[topic.toLowerCase()] : undefined;
          const text =
            section ??
            (topic
              ? `Section '${topic}' not found. Available: ${topics.join(', ')}\n\n${options.instructions}`
              : options.instructions);
          return {
            description: GET_HELP.contract.description,
            messages: [userText(text)],
          };
        }),
    );
  },
};
```

- [ ] **Step 2: Add to PROMPT_ENTRIES**

Change:

```ts
const PROMPT_ENTRIES: PromptEntry[] = [];
```

to:

```ts
const PROMPT_ENTRIES: PromptEntry[] = [GET_HELP];
```

- [ ] **Step 3: Type-check**

Run: `npm run type-check`
Expected: still fails on tests/bootstrap consumers; `prompts.ts` itself must be clean. If `prompts.ts` has errors, fix them before continuing.

- [ ] **Step 4: Commit**

```sh
git add src/prompts.ts
git commit -m "feat(prompts): implement get-help via INSTRUCTION_SECTIONS lookup"
```

---

## Task 4: Implement `analyze-path` prompt entry

**Files:**

- Modify: `src/prompts.ts`

- [ ] **Step 1: Add `node:fs/promises` import for `stat`**

At top of `prompts.ts`, add:

```ts
import { stat } from 'node:fs/promises';
```

- [ ] **Step 2: Add the entry**

Insert above `const PROMPT_ENTRIES`:

```ts
const ANALYZE_PATH: PromptEntry = {
  contract: {
    name: 'analyze-path',
    title: 'Analyze Path',
    description: 'Workflow for analyzing a file or directory using stat, read, and tree.',
    requiresPathGuard: true,
  },
  register(server, options) {
    server.registerPrompt(
      ANALYZE_PATH.contract.name,
      withDefaultIcons(
        {
          title: ANALYZE_PATH.contract.title,
          description: ANALYZE_PATH.contract.description,
          argsSchema: z.strictObject({
            path: pathArg(server, options.pathGuard, 'path', 'Absolute path to analyze.'),
          }),
        },
        options.iconInfo,
      ),
      async ({ path: rawPath }): Promise<GetPromptResult> =>
        wrapHandler(ANALYZE_PATH.contract.name, options, true, async () => {
          const resolved = await options.pathGuard.validateExistingPath(rawPath);
          const stats = await stat(resolved);
          const kind = stats.isDirectory() ? 'directory' : 'file';
          const task =
            kind === 'file'
              ? `Analyze this file: ${resolved}\n\n- Call \`stat\` to confirm size and permissions.\n- Call \`read\` (with \`includeHash: true\`) and summarize contents.\n- Report: type, size, permissions, key observations.`
              : `Analyze this directory: ${resolved}\n\n- Call \`tree\` (maxDepth: 3) for layout.\n- Call \`ls\` for top-level entries.\n- Report: structure, notable files/subdirs, observations.`;
          return {
            description: ANALYZE_PATH.contract.description,
            messages: [userText(task), linkToPath(resolved), linkToInstructions()],
          };
        }),
    );
  },
};
```

- [ ] **Step 3: Append to `PROMPT_ENTRIES`**

```ts
const PROMPT_ENTRIES: PromptEntry[] = [GET_HELP, ANALYZE_PATH];
```

- [ ] **Step 4: Commit**

```sh
git add src/prompts.ts
git commit -m "feat(prompts): implement analyze-path with kind-aware task + resource_link"
```

---

## Task 5: Implement `compare-files` prompt entry

**Files:**

- Modify: `src/prompts.ts`

- [ ] **Step 1: Add the entry**

Insert above `const PROMPT_ENTRIES`:

```ts
const COMPARE_FILES: PromptEntry = {
  contract: {
    name: 'compare-files',
    title: 'Compare Files',
    description: 'Workflow for comparing two files using diff_files.',
    requiresPathGuard: true,
  },
  register(server, options) {
    server.registerPrompt(
      COMPARE_FILES.contract.name,
      withDefaultIcons(
        {
          title: COMPARE_FILES.contract.title,
          description: COMPARE_FILES.contract.description,
          argsSchema: z.strictObject({
            original: pathArg(server, options.pathGuard, 'original', 'Path to the original file.'),
            modified: pathArg(server, options.pathGuard, 'modified', 'Path to the modified file.'),
          }),
        },
        options.iconInfo,
      ),
      async ({ original, modified }): Promise<GetPromptResult> =>
        wrapHandler(COMPARE_FILES.contract.name, options, true, async () => {
          const [resolvedOriginal, resolvedModified] = await Promise.all([
            options.pathGuard.validateExistingPath(original),
            options.pathGuard.validateExistingPath(modified),
          ]);
          const text = [
            'Call `diff_files` with:',
            `- original: ${resolvedOriginal}`,
            `- modified: ${resolvedModified}`,
            '',
            'Then summarize: additions, deletions, and semantic changes. Flag potential conflicts, regressions, or breaking changes.',
          ].join('\n');
          return {
            description: COMPARE_FILES.contract.description,
            messages: [userText(text), linkToPath(resolvedOriginal), linkToPath(resolvedModified)],
          };
        }),
    );
  },
};
```

- [ ] **Step 2: Append to `PROMPT_ENTRIES`**

```ts
const PROMPT_ENTRIES: PromptEntry[] = [GET_HELP, ANALYZE_PATH, COMPARE_FILES];
```

- [ ] **Step 3: Commit**

```sh
git add src/prompts.ts
git commit -m "feat(prompts): implement compare-files with resolved-path resource_links"
```

---

## Task 6: Implement `find-in-tree` prompt entry

**Files:**

- Modify: `src/prompts.ts`

- [ ] **Step 1: Add the entry**

Insert above `const PROMPT_ENTRIES`:

```ts
const FIND_IN_TREE_MODE = z.enum(['name', 'content', 'both']);

const FIND_IN_TREE: PromptEntry = {
  contract: {
    name: 'find-in-tree',
    title: 'Find in Tree',
    description: 'Locate files and matches by name and content under a directory.',
    requiresPathGuard: true,
  },
  register(server, options) {
    server.registerPrompt(
      FIND_IN_TREE.contract.name,
      withDefaultIcons(
        {
          title: FIND_IN_TREE.contract.title,
          description: FIND_IN_TREE.contract.description,
          argsSchema: z.strictObject({
            query: z.string().min(1).describe('Search term (name pattern or content regex).'),
            root: pathArg(
              server,
              options.pathGuard,
              'root',
              'Directory to search under. Defaults to first allowed root.',
            ).optional(),
            mode: FIND_IN_TREE_MODE.default('both').describe('Search by name, content, or both.'),
          }),
        },
        options.iconInfo,
      ),
      async ({ query, root, mode }): Promise<GetPromptResult> =>
        wrapHandler(FIND_IN_TREE.contract.name, options, true, async () => {
          const allowed = options.pathGuard.getAllowedDirectories();
          const candidate = root ?? allowed[0];
          if (!candidate) {
            throw new Error('find-in-tree: no root provided and no allowed directories');
          }
          const resolved = await options.pathGuard.validateExistingDirectory(candidate);
          const steps: string[] = [];
          if (mode === 'name' || mode === 'both') {
            steps.push(`- Call \`find\` with pattern "${query}" under "${resolved}".`);
          }
          if (mode === 'content' || mode === 'both') {
            steps.push(
              `- Call \`grep\` with pattern "${query}" under "${resolved}". Report relative paths, line numbers, and a 1-line context for each match.`,
            );
          }
          const text = [`Find "${query}" in ${resolved} (mode=${mode}):`, '', ...steps].join('\n');
          return {
            description: FIND_IN_TREE.contract.description,
            messages: [userText(text), linkToInstructions()],
          };
        }),
    );
  },
};
```

- [ ] **Step 2: Append to `PROMPT_ENTRIES`**

```ts
const PROMPT_ENTRIES: PromptEntry[] = [GET_HELP, ANALYZE_PATH, COMPARE_FILES, FIND_IN_TREE];
```

- [ ] **Step 3: Commit**

```sh
git add src/prompts.ts
git commit -m "feat(prompts): add find-in-tree workflow prompt"
```

---

## Task 7: Implement `summarize-directory` prompt entry

**Files:**

- Modify: `src/prompts.ts`

- [ ] **Step 1: Add the entry**

Insert above `const PROMPT_ENTRIES`:

```ts
const SUMMARIZE_DIRECTORY: PromptEntry = {
  contract: {
    name: 'summarize-directory',
    title: 'Summarize Directory',
    description: 'Onboarding summary: purpose, tech stack, entry points, structure.',
    requiresPathGuard: true,
  },
  register(server, options) {
    server.registerPrompt(
      SUMMARIZE_DIRECTORY.contract.name,
      withDefaultIcons(
        {
          title: SUMMARIZE_DIRECTORY.contract.title,
          description: SUMMARIZE_DIRECTORY.contract.description,
          argsSchema: z.strictObject({
            path: pathArg(server, options.pathGuard, 'path', 'Directory to summarize.'),
            depth: z.number().int().min(1).max(6).default(3).describe('Tree depth (1-6).'),
          }),
        },
        options.iconInfo,
      ),
      async ({ path: rawPath, depth }): Promise<GetPromptResult> =>
        wrapHandler(SUMMARIZE_DIRECTORY.contract.name, options, true, async () => {
          const resolved = await options.pathGuard.validateExistingDirectory(rawPath);
          const text = [
            `Summarize this project at ${resolved}:`,
            '',
            `- Call \`tree\` with maxDepth=${depth}.`,
            '- Call `read_many` for top-level manifests when present: README.md, package.json, Cargo.toml, pyproject.toml, go.mod, build.gradle, pom.xml, Dockerfile.',
            '- Produce: purpose, tech stack, entry points, notable directories.',
          ].join('\n');
          return {
            description: SUMMARIZE_DIRECTORY.contract.description,
            messages: [userText(text), linkToPath(resolved)],
          };
        }),
    );
  },
};
```

- [ ] **Step 2: Append to `PROMPT_ENTRIES`**

```ts
const PROMPT_ENTRIES: PromptEntry[] = [
  GET_HELP,
  ANALYZE_PATH,
  COMPARE_FILES,
  FIND_IN_TREE,
  SUMMARIZE_DIRECTORY,
];
```

- [ ] **Step 3: Run lint on prompts.ts**

Run: `npx eslint src/prompts.ts`
Expected: PASS, no warnings.

- [ ] **Step 4: Commit**

```sh
git add src/prompts.ts
git commit -m "feat(prompts): add summarize-directory workflow prompt"
```

---

## Task 8: Update bootstrap.ts call site

**Files:**

- Modify: `src/server/bootstrap.ts`

- [ ] **Step 1: Update the import**

Change:

```ts
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
} from '../prompts.js';
```

to:

```ts
import { registerAllPrompts } from '../prompts.js';
```

(If imports come from a single combined block, edit accordingly — confirm with `grep_search` `register.*Prompt` in the file before editing.)

- [ ] **Step 2: Replace the three call sites**

Replace:

```ts
registerGetHelpPrompt(server, serverInstructionsContent, localIcon);
registerCompareFilesPrompt(server, rootsManager.pathGuard, localIcon);
registerAnalyzePathPrompt(server, rootsManager.pathGuard, localIcon);
```

with:

```ts
registerAllPrompts(server, {
  pathGuard: rootsManager.pathGuard,
  instructions: serverInstructionsContent,
  isInitialized: () => rootsManager.isInitialized(),
  ...(localIcon ? { iconInfo: localIcon } : {}),
});
```

- [ ] **Step 3: Type-check**

Run: `npm run type-check`
Expected: passes for `bootstrap.ts`. Test files still fail — fixed in next tasks.

- [ ] **Step 4: Commit**

```sh
git add src/server/bootstrap.ts
git commit -m "refactor(bootstrap): wire prompts via registerAllPrompts"
```

---

## Task 9: Rewrite `__tests__/prompts.test.ts` for the new 5-prompt set

**Files:**

- Rewrite: `__tests__/prompts.test.ts`

- [ ] **Step 1: Replace file contents**

```ts
import { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createServer } from '../src/server.js';
import { LinkedTransport } from './linked-transport.js';

interface PromptEnv {
  client: Client;
  tempDir: string;
  cleanup: () => Promise<void>;
}

async function createPromptEnv(): Promise<PromptEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-prompts-'));
  const { server } = await createServer({ cliAllowedDirs: [tempDir] });
  const client = new Client({ name: 'prompt-test-client', version: '1.0.0' });
  const [clientTransport, serverTransport] = LinkedTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    tempDir,
    cleanup: async () => {
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function expectText(message: { content: { type: string } }): asserts message is {
  content: { type: 'text'; text: string };
} {
  assert.equal(message.content.type, 'text');
}

function expectLink(message: { content: { type: string } }): asserts message is {
  content: { type: 'resource_link'; uri: string };
} {
  assert.equal(message.content.type, 'resource_link');
}

describe('prompts', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (cleanup) await cleanup();
    }
  });

  it('lists all 5 prompts', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.listPrompts();
    const names = result.prompts.map((p) => p.name).sort();
    assert.deepEqual(names, [
      'analyze-path',
      'compare-files',
      'find-in-tree',
      'get-help',
      'summarize-directory',
    ]);
  });

  it('get-help returns full instructions when no topic', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({ name: 'get-help', arguments: {} });
    assert.equal(result.messages.length, 1);
    const [message] = result.messages;
    assert.ok(message);
    expectText(message);
    assert.match(message.content.text, /Guidelines:/u);
    assert.match(message.content.text, /Constraints:/u);
  });

  it('get-help filters to a known topic', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'get-help',
      arguments: { topic: 'constraints' },
    });
    const [message] = result.messages;
    assert.ok(message);
    expectText(message);
    assert.match(message.content.text, /Constraints:/u);
    assert.doesNotMatch(message.content.text, /Error Recovery:/u);
  });

  it('analyze-path on a file returns text + path link + instructions link', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const filePath = join(env.tempDir, 'sample.txt');
    await writeFile(filePath, 'hello\n', 'utf8');
    const result = await env.client.getPrompt({
      name: 'analyze-path',
      arguments: { path: filePath },
    });
    assert.equal(result.messages.length, 3);
    const [m0, m1, m2] = result.messages;
    assert.ok(m0 && m1 && m2);
    expectText(m0);
    assert.match(m0.content.text, /Analyze this file:/u);
    expectLink(m1);
    assert.equal(m1.content.uri, `file://${filePath}`);
    expectLink(m2);
    assert.equal(m2.content.uri, 'internal://instructions');
  });

  it('analyze-path on a directory adapts the task statement', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'analyze-path',
      arguments: { path: env.tempDir },
    });
    const [m0] = result.messages;
    assert.ok(m0);
    expectText(m0);
    assert.match(m0.content.text, /Analyze this directory:/u);
  });

  it('compare-files returns text + 2 path links', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const original = join(env.tempDir, 'original.txt');
    const modified = join(env.tempDir, 'modified.txt');
    await writeFile(original, 'before\n', 'utf8');
    await writeFile(modified, 'after\n', 'utf8');
    const result = await env.client.getPrompt({
      name: 'compare-files',
      arguments: { original, modified },
    });
    assert.equal(result.messages.length, 3);
    const [m0, m1, m2] = result.messages;
    assert.ok(m0 && m1 && m2);
    expectText(m0);
    assert.match(m0.content.text, /Call `diff_files`/u);
    assert.match(m0.content.text, /- original: /u);
    assert.match(m0.content.text, /- modified: /u);
    expectLink(m1);
    assert.equal(m1.content.uri, `file://${original}`);
    expectLink(m2);
    assert.equal(m2.content.uri, `file://${modified}`);
  });

  it('find-in-tree defaults root to first allowed dir and includes both modes', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'find-in-tree',
      arguments: { query: 'foo' },
    });
    assert.equal(result.messages.length, 2);
    const [m0, m1] = result.messages;
    assert.ok(m0 && m1);
    expectText(m0);
    assert.match(m0.content.text, /Call `find`/u);
    assert.match(m0.content.text, /Call `grep`/u);
    expectLink(m1);
    assert.equal(m1.content.uri, 'internal://instructions');
  });

  it('find-in-tree mode=name omits grep', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'find-in-tree',
      arguments: { query: 'foo', mode: 'name' },
    });
    const [m0] = result.messages;
    assert.ok(m0);
    expectText(m0);
    assert.match(m0.content.text, /Call `find`/u);
    assert.doesNotMatch(m0.content.text, /Call `grep`/u);
  });

  it('summarize-directory returns text + path link', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'summarize-directory',
      arguments: { path: env.tempDir },
    });
    assert.equal(result.messages.length, 2);
    const [m0, m1] = result.messages;
    assert.ok(m0 && m1);
    expectText(m0);
    assert.match(m0.content.text, /Summarize this project/u);
    assert.match(m0.content.text, /maxDepth=3/u);
    expectLink(m1);
    assert.equal(m1.content.uri, `file://${env.tempDir}`);
  });

  it('summarize-directory honors custom depth', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    const result = await env.client.getPrompt({
      name: 'summarize-directory',
      arguments: { path: env.tempDir, depth: 5 },
    });
    const [m0] = result.messages;
    assert.ok(m0);
    expectText(m0);
    assert.match(m0.content.text, /maxDepth=5/u);
  });

  it('analyze-path rejects a path outside allowed roots', async () => {
    const env = await createPromptEnv();
    cleanups.push(env.cleanup);
    await assert.rejects(
      env.client.getPrompt({
        name: 'analyze-path',
        arguments: { path: '/definitely/not/allowed' },
      }),
    );
  });
});
```

- [ ] **Step 2: Run the test file**

Run: `node --test --import tsx/esm __tests__/prompts.test.ts`
Expected: PASS (all 11 cases).

- [ ] **Step 3: Commit**

```sh
git add __tests__/prompts.test.ts
git commit -m "test(prompts): structural assertions for new 5-prompt set"
```

---

## Task 10: Update `__tests__/unit/completions.test.ts`

**Files:**

- Modify: `__tests__/unit/completions.test.ts`

- [ ] **Step 1: Replace the import block**

Change:

```ts
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
} from '../../src/prompts.js';
```

to:

```ts
import { registerAllPrompts } from '../../src/prompts.js';
```

- [ ] **Step 2: Replace `makeCompletionServer`**

Replace the existing helper body. New version:

```ts
function makeCompletionServer(withInstructions = false, pathGuard?: PathGuard): McpServer {
  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { completions: {} } },
  );
  const instructions = withInstructions ? serverInstructionsContent : '';
  const resourceStore = createInMemoryResourceStore();

  if (pathGuard) {
    registerAllPrompts(server, {
      pathGuard,
      instructions,
      isInitialized: () => true,
    });
  } else {
    // get-help-only path: synthesize a no-op PathGuard via fromAllowedDirectories on a tmp dir is overkill.
    // Tests in this file that omit pathGuard are about get-help only; create a guard against a tiny tmp.
    throw new Error('makeCompletionServer requires a pathGuard for the unified registry');
  }

  registerAllResources(server, { resourceStore });
  return server;
}
```

If any existing test calls `makeCompletionServer(false)` (no pathGuard), update those callers to construct a tmp `PathGuard` first. Use `grep_search` `makeCompletionServer\(` to locate all call sites.

- [ ] **Step 3: Run the test file**

Run: `node --test --import tsx/esm __tests__/unit/completions.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```sh
git add __tests__/unit/completions.test.ts
git commit -m "test(completions): consume registerAllPrompts"
```

---

## Task 11: Update `__tests__/contract.test.ts`

**Files:**

- Modify: `__tests__/contract.test.ts`

- [ ] **Step 1: Replace the prompt-registration block in `makeServer`**

Find the lines:

```ts
const { registerGetHelpPrompt, registerAnalyzePathPrompt, registerCompareFilesPrompt } =
  await import('../src/prompts.js');
```

…and (lower) the three calls:

```ts
registerGetHelpPrompt(server, serverInstructionsContent);
registerAnalyzePathPrompt(server, pathGuard);
registerCompareFilesPrompt(server, pathGuard);
```

Replace the import with:

```ts
const { registerAllPrompts } = await import('../src/prompts.js');
```

Replace the three calls with:

```ts
registerAllPrompts(server, {
  pathGuard,
  instructions: serverInstructionsContent,
  isInitialized: () => true,
});
```

- [ ] **Step 2: Append a new `describe('Prompts contract', …)` block at the end of the file**

```ts
describe('Prompts contract', () => {
  it('ALL_PROMPTS exposes the expected 5 prompts with required metadata', async () => {
    const { ALL_PROMPTS } = await import('../src/prompts.js');
    const names = ALL_PROMPTS.map((p) => p.name).sort();
    assert.deepEqual(names, [
      'analyze-path',
      'compare-files',
      'find-in-tree',
      'get-help',
      'summarize-directory',
    ]);
    for (const contract of ALL_PROMPTS) {
      assert.ok(contract.title.length > 0, `${contract.name}: title required`);
      assert.ok(contract.description.length > 0, `${contract.name}: description required`);
    }
    const requiresGuard = new Map(ALL_PROMPTS.map((p) => [p.name, p.requiresPathGuard]));
    assert.equal(requiresGuard.get('get-help'), false);
    assert.equal(requiresGuard.get('analyze-path'), true);
    assert.equal(requiresGuard.get('compare-files'), true);
    assert.equal(requiresGuard.get('find-in-tree'), true);
    assert.equal(requiresGuard.get('summarize-directory'), true);
  });
});
```

- [ ] **Step 3: Run the test file**

Run: `node --test --import tsx/esm __tests__/contract.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```sh
git add __tests__/contract.test.ts
git commit -m "test(contract): assert prompts contract registry"
```

---

## Task 12: Update `__tests__/prompts-stdio.test.ts`

**Files:**

- Modify: `__tests__/prompts-stdio.test.ts`

- [ ] **Step 1: Update the analyze-path stdio assertions**

Replace:

```ts
assert.equal(result.messages.length, 1);
const [message] = result.messages;
assert.ok(message);
assert.equal(message.content.type, 'text');
assert.match(message.content.text, /Analyze the path:/u);
assert.match(message.content.text, /sample\.txt/u);
```

with:

```ts
assert.equal(result.messages.length, 3);
const [m0, m1, m2] = result.messages;
assert.ok(m0 && m1 && m2);
assert.equal(m0.content.type, 'text');
assert.match(m0.content.text, /Analyze this file:/u);
assert.match(m0.content.text, /sample\.txt/u);
assert.equal(m1.content.type, 'resource_link');
assert.equal(m2.content.type, 'resource_link');
assert.equal(m2.content.uri, 'internal://instructions');
```

- [ ] **Step 2: Add a smoke test for find-in-tree over stdio**

After the existing `it(...)` block, append:

```ts
it('returns find-in-tree with required args over stdio transport', async (t) => {
  try {
    await access(resolve('dist/index.js'));
  } catch {
    t.skip('dist runtime not present');
    return;
  }
  const env = await createPromptStdIoEnv();
  cleanups.push(env.cleanup);

  const result = await env.client.getPrompt({
    name: 'find-in-tree',
    arguments: { query: 'needle' },
  });
  assert.equal(result.messages.length, 2);
  const [m0] = result.messages;
  assert.ok(m0);
  assert.equal(m0.content.type, 'text');
  assert.match(m0.content.text, /Call `find`/u);
});
```

- [ ] **Step 3: Build dist (required for stdio tests)**

Run: `npm run build`
Expected: PASS (tsc emits to `dist/`).

- [ ] **Step 4: Run the stdio test file**

Run: `node --test --import tsx/esm __tests__/prompts-stdio.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```sh
git add __tests__/prompts-stdio.test.ts
git commit -m "test(prompts-stdio): align with new message structure + find-in-tree smoke"
```

---

## Task 13: Final full validation

**Files:** none (verification only)

- [ ] **Step 1: Run the full task suite with auto-fix**

Run: `node scripts/tasks.mjs --fix`
Expected: PASS (format → lint → type-check → knip → test → rebuild). If `knip` flags `INSTRUCTION_SECTIONS` or `ALL_PROMPTS` as unused, ensure they remain exported and re-check call sites.

- [ ] **Step 2: Run the contract suite explicitly**

Run: `npm run test`
Expected: PASS for all 73+ test files including `prompts.test.ts`, `contract.test.ts`, `prompts-stdio.test.ts`, `unit/completions.test.ts`, `resources/instructions.test.ts`.

- [ ] **Step 3: Sanity-list prompts via inspector (optional manual check)**

Run: `npm run inspector`
Then in the inspector, list prompts. Expected: 5 entries with the new titles/descriptions. Close the inspector.

- [ ] **Step 4: Final commit if any auto-fixes were applied**

```sh
git status
# If files changed:
git add -A
git commit -m "chore(prompts): apply tooling auto-fixes"
```

---

## Self-Review Checklist (run after writing this plan)

- [x] Spec coverage: every section of [the spec](../specs/2026-05-09-prompts-redesign-design.md) maps to a task.
  - §3.1–3.3 module/types/helpers → Task 2
  - §3.4 INSTRUCTION_SECTIONS → Task 1
  - §3.5 bootstrap → Task 8
  - §4.1–4.5 five prompts → Tasks 3–7
  - §5 security/validation → built into Tasks 4–7 (`validateExistingPath`, `validateExistingDirectory`, `requiresPathGuard` flag)
  - §6 logging via `wrapHandler` → Task 2
  - §7 test plan → Tasks 9–12
- [x] No placeholders.
- [x] Type consistency: `PromptContract`, `PromptEntry`, `PromptRegistrationOptions`, `pathArg`, `topicArg`, `userText`, `linkToInstructions`, `linkToPath`, `wrapHandler` defined in Task 2 and used identically in Tasks 3–7. Path-guard methods used: `validateExistingPath`, `validateExistingDirectory`, `getAllowedDirectories` (verified against `src/lib/path-guard.ts`).
- [x] Commit cadence: one per task, plus a final tooling commit.
