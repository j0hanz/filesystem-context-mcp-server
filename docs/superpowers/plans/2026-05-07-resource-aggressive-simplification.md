# Resource Layer — Aggressive Simplification Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cut from 7 MCP resources to 2 (slim instructions + result cache), delete all redundant content-builder modules, remove subscription infrastructure and `globalMetrics`, and remove the `get-tool-help` prompt.

**Architecture:** `src/resources.ts` becomes a flat ~45-LOC module that calls two `server.registerResource()` directly — no registry table, no lifecycle objects. Instructions content moves to a single `buildSlimInstructions()` in `src/resources/instructions-content.ts`. The result-cache handler is inlined in `resources.ts`. `ResourcesHandle` and all subscription wiring are deleted. `globalMetrics`/`onMetricsUpdate` are removed from observability; diagnostics still flow via `node:diagnostics_channel`.

**Tech Stack:** TypeScript strict mode, `@modelcontextprotocol/server` (McpServer, ResourceTemplate, ProtocolError), Node.js ≥ 24, `node:test` runner via `tsx/esm`.

---

## File Map

| Status  | Path                                               | Responsibility                                                                                         |
| ------- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| CREATE  | `src/resources/instructions-content.ts`            | `buildSlimInstructions()` → slim markdown, exported constant                                           |
| REPLACE | `src/resources.ts`                                 | Two direct `registerResource()` calls, `ResourceRegistrationOptions`, no lifecycle                     |
| MODIFY  | `src/resources/tool-info.ts`                       | Keep 4 nav helpers only — delete ~250 LOC of schema rendering                                          |
| MODIFY  | `src/lib/observability.ts`                         | Remove `globalMetrics`, `onMetricsUpdate`, `metricsListeners`, `updateMetrics`                         |
| MODIFY  | `src/server/bootstrap.ts`                          | No `ResourcesHandle`, `resources: {}` caps, no `debouncedNotificationMethods`, no `get-tool-help` call |
| MODIFY  | `src/prompts.ts`                                   | Remove `registerGetToolHelpPrompt` and helpers                                                         |
| DELETE  | `src/resources/contract.ts`                        | Types no longer needed                                                                                 |
| DELETE  | `src/resources/shared.ts`                          | Helpers no longer needed                                                                               |
| DELETE  | `src/resources/result.ts`                          | Handler inlined into `resources.ts`                                                                    |
| DELETE  | `src/resources/instructions.ts`                    | Replaced by `instructions-content.ts`                                                                  |
| DELETE  | `src/resources/generated-instructions.ts`          | Replaced by slim version                                                                               |
| DELETE  | `src/resources/filesystem-file.ts`                 | Resource removed                                                                                       |
| DELETE  | `src/resources/metrics.ts`                         | Resource removed                                                                                       |
| DELETE  | `src/resources/tool-catalog.ts`                    | Content no longer used                                                                                 |
| DELETE  | `src/resources/tool-catalog-resource.ts`           | Resource removed                                                                                       |
| DELETE  | `src/resources/workflows.ts`                       | Content no longer used                                                                                 |
| DELETE  | `src/resources/workflows-resource.ts`              | Resource removed                                                                                       |
| DELETE  | `src/resources/tool-info-resource.ts`              | Resource removed                                                                                       |
| CREATE  | `__tests__/resources/instructions-content.test.ts` | Unit tests for `buildSlimInstructions()`                                                               |
| MODIFY  | `__tests__/resources.test.ts`                      | Expect 1 static + 1 template, 3 prompts                                                                |
| DELETE  | `__tests__/resources/contract.test.ts`             | Tests deleted resource types                                                                           |
| DELETE  | `__tests__/resources/filesystem-file.test.ts`      | Tests deleted resource                                                                                 |
| DELETE  | `__tests__/resources/metrics.test.ts`              | Tests deleted resource                                                                                 |
| MODIFY  | `__tests__/prompts.test.ts`                        | Remove two `get-tool-help` tests, update prompt list                                                   |
| MODIFY  | `__tests__/prompts-stdio.test.ts`                  | Remove `get-tool-help` test                                                                            |
| MODIFY  | `__tests__/unit/completions.test.ts`               | Remove two tests, update imports and `makeCompletionServer`                                            |
| MODIFY  | `__tests__/http.test.ts`                           | Remove stale resource/prompt assertions in discovery test                                              |
| MODIFY  | `README.md`                                        | 2 resources, 3 prompts, updated tables                                                                 |

**Unchanged:** `src/lib/resource-store.ts`, `src/tools/shared.ts` (`maybeExternalizeTextContent`, `buildResourceLink`), all tool files, `src/lib/paths.ts`, `src/lib/path-guard.ts`.

---

### Task 1: Write failing test for `instructions-content.ts`

**Files:**

- Create: `__tests__/resources/instructions-content.test.ts`

The file does not exist yet — this test will fail at import time.

- [ ] **Step 1: Create `__tests__/resources/instructions-content.test.ts`**

```typescript
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { buildSlimInstructions } from '../../src/resources/instructions-content.js';

describe('buildSlimInstructions', () => {
  it('contains all four required sections', () => {
    const content = buildSlimInstructions();
    assert.match(content, /## Role/u);
    assert.match(content, /## Tools Overview/u);
    assert.match(content, /## Constraints/u);
    assert.match(content, /## Error Recovery/u);
  });

  it('includes known tool names in the overview table', () => {
    const content = buildSlimInstructions();
    assert.match(content, /`roots`/u);
    assert.match(content, /`ls`/u);
    assert.match(content, /`grep`/u);
    assert.match(content, /`read`/u);
    assert.match(content, /`write`/u);
  });

  it('points to tools/list for schemas', () => {
    const content = buildSlimInstructions();
    assert.match(content, /tools\/list/u);
  });

  it('includes all five error recovery codes', () => {
    const content = buildSlimInstructions();
    assert.match(content, /ACCESS_DENIED/u);
    assert.match(content, /NOT_FOUND/u);
    assert.match(content, /TOO_LARGE/u);
    assert.match(content, /TIMEOUT/u);
    assert.match(content, /INVALID_INPUT/u);
  });

  it('mentions resourceUri cache behaviour', () => {
    const content = buildSlimInstructions();
    assert.match(content, /resourceUri/u);
    assert.match(content, /resources\/read/u);
  });

  it('returns a non-empty string on every call (idempotent)', () => {
    assert.ok(buildSlimInstructions().length > 200);
    assert.strictEqual(buildSlimInstructions(), buildSlimInstructions());
  });
});
```

- [ ] **Step 2: Run test to verify it fails with module-not-found error**

```sh
node --test --import tsx/esm __tests__/resources/instructions-content.test.ts
```

Expected: `ERR_MODULE_NOT_FOUND` — `instructions-content.js` does not exist yet.

---

### Task 2: Create `src/resources/instructions-content.ts`

**Files:**

- Create: `src/resources/instructions-content.ts`

- [ ] **Step 1: Create `src/resources/instructions-content.ts`**

```typescript
import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';

import { formatToolNameList, pickAvailableToolNames } from './tool-info.js';

function buildToolsOverview(): string {
  const rows: [string, string[]][] = [
    ['Navigate', pickAvailableToolNames(['roots', 'ls', 'tree', 'find'])],
    [
      'Inspect',
      pickAvailableToolNames(['stat', 'stat_many', 'grep', 'calculate_hash']),
    ],
    ['Read', pickAvailableToolNames(['read', 'read_many', 'diff_files'])],
    [
      'Write',
      pickAvailableToolNames([
        'mkdir',
        'write',
        'edit',
        'mv',
        'rm',
        'apply_patch',
        'search_and_replace',
      ]),
    ],
  ];

  const header = '| Category | Tools |\n| -------- | ----- |';
  const rowLines = rows
    .filter(([, names]) => names.length > 0)
    .map(([cat, names]) => `| ${cat} | ${formatToolNameList(names)} |`);
  return `${header}\n${rowLines.join('\n')}`;
}

export function buildSlimInstructions(): string {
  const maxFileMb = Math.floor(MAX_TEXT_FILE_SIZE / 1024 / 1024);

  return `## Role

Secure filesystem agent. Operate strictly within allowed roots.
Resolve paths before acting — never assume.

## Tools Overview

${buildToolsOverview()}

Full schemas, descriptions, and annotations are in \`tools/list\`.

## Constraints

- Operate within allowed roots only (negotiated at startup via CLI).
- Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.
- Enforced limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.
- When a tool returns \`resourceUri\`, call \`resources/read\` immediately — cached results expire on server restart.

## Error Recovery

| Error Code        | Action                                                            |
| ----------------- | ----------------------------------------------------------------- |
| \`ACCESS_DENIED\` | Run \`roots\` to list allowed directories, retry with a valid path. |
| \`NOT_FOUND\`     | Run \`ls\` or \`find\` to verify the path.                        |
| \`TOO_LARGE\`     | Use head/tail, line ranges, or split across \`read_many\`.        |
| \`TIMEOUT\`       | Reduce scope, depth, or maxResults.                               |
| \`INVALID_INPUT\` | Re-read the tool schema in \`tools/list\`.                        |
`;
}

export const SLIM_INSTRUCTIONS_CONTENT = buildSlimInstructions();
```

- [ ] **Step 2: Run test to verify it passes**

```sh
node --test --import tsx/esm __tests__/resources/instructions-content.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 3: Commit**

```sh
git add __tests__/resources/instructions-content.test.ts src/resources/instructions-content.ts
git commit -m "feat: add slim instructions content builder with tests"
```

---

### Task 3: Update `__tests__/resources.test.ts` to expect 2 resources

**Files:**

- Modify: `__tests__/resources.test.ts`

These assertions will fail until `src/resources.ts` is replaced in Task 4.

- [ ] **Step 1: Replace the body of `__tests__/resources.test.ts`**

```typescript
import { Client } from '@modelcontextprotocol/client';

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import serverJson from '../server.json' with { type: 'json' };
import { createServer } from '../src/server.js';
import { LinkedTransport } from './linked-transport.js';

interface DiscoveryEnv {
  client: Client;
  cleanup: () => Promise<void>;
}

function getTextContent(
  content:
    | { uri: string; text: string; mimeType?: string | undefined }
    | { uri: string; blob: string; mimeType?: string | undefined }
): string {
  if ('text' in content) {
    return content.text;
  }
  throw new Error(`Expected text resource content for ${content.uri}`);
}

async function createDiscoveryEnv(): Promise<DiscoveryEnv> {
  const tempDir = await mkdtemp(join(tmpdir(), 'fsmcp-discovery-'));
  const { server, resourcesHandle } = await createServer({
    cliAllowedDirs: [tempDir],
  });
  const client = new Client({
    name: 'discovery-test-client',
    version: '1.0.0',
  });
  const [clientTransport, serverTransport] = LinkedTransport.createLinkedPair();

  await server.connect(serverTransport);
  await client.connect(clientTransport);

  return {
    client,
    cleanup: async () => {
      resourcesHandle?.destroy();
      await client.close().catch(() => {});
      await server.close().catch(() => {});
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

describe('resources and metadata', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const cleanup = cleanups.pop();
      if (!cleanup) continue;
      await cleanup();
    }
  });

  it('lists exactly 1 static resource and 1 resource template', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const { resources } = await env.client.listResources();
    const { resourceTemplates } = await env.client.listResourceTemplates();

    assert.equal(resources.length, 1);
    assert.equal(resources[0]?.uri, 'internal://instructions');

    assert.deepEqual(resourceTemplates.map((t) => t.uriTemplate).sort(), [
      'filesystem-mcp://result/{id}',
    ]);
  });

  it('reads instructions resource and exposes instructions through initialize metadata', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const instructions = env.client.getInstructions();
    assert.ok(instructions, 'Expected initialize instructions to be present');
    assert.match(
      instructions,
      /Start with: roots -> ls\/find -> stat -> read/u
    );

    const instructionsResource = await env.client.readResource({
      uri: 'internal://instructions',
    });
    assert.equal(instructionsResource.contents.length, 1);
    const [instructionsContent] = instructionsResource.contents;
    assert.ok(instructionsContent);
    assert.equal(instructionsContent.mimeType, 'text/markdown');
    const text = getTextContent(instructionsContent);
    assert.match(text, /## Role/u);
    assert.match(text, /## Tools Overview/u);
    assert.match(text, /## Constraints/u);
    assert.match(text, /## Error Recovery/u);
  });

  it('keeps README and server metadata in sync with the advertised discovery surface', async () => {
    const env = await createDiscoveryEnv();
    cleanups.push(env.cleanup);

    const readme = await readFile(join(process.cwd(), 'README.md'), 'utf8');
    const { tools } = await env.client.listTools();
    const { resources } = await env.client.listResources();
    const { resourceTemplates } = await env.client.listResourceTemplates();
    const { prompts } = await env.client.listPrompts();

    assert.match(readme, /\*\*18 filesystem tools\*\*/u);
    assert.match(readme, /\*\*Self-documenting\*\* — 2 built-in resources/u);
    assert.match(readme, /3 built-in prompts/u);

    assert.equal(tools.length, 18);
    assert.equal(resources.length, 1);
    assert.equal(resourceTemplates.length, 1);
    assert.equal(prompts.length, 3);

    assert.equal(serverJson.title, 'Filesystem MCP');
  });
});
```

> **Note:** `createServer` still returns `{ server, resourcesHandle }` at this point — the optional-chaining `resourcesHandle?.destroy()` handles both the old shape and the upcoming shape where it's removed. This will be cleaned up in Task 4.

- [ ] **Step 2: Run the updated test to confirm it fails**

```sh
node --test --import tsx/esm __tests__/resources.test.ts
```

Expected: "lists exactly 1 static resource" FAILS — currently 7 resources are registered. Do not fix yet.

---

### Task 4: Replace `src/resources.ts` and update `src/server/bootstrap.ts`

These two files are replaced together because `bootstrap.ts` imports `ResourcesHandle` from `resources.ts` — if they're not updated atomically the code won't compile.

**Files:**

- Replace: `src/resources.ts`
- Modify: `src/server/bootstrap.ts`

- [ ] **Step 1: Replace `src/resources.ts` with the slim 2-resource version**

```typescript
import {
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
  type ReadResourceResult,
  ResourceTemplate,
} from '@modelcontextprotocol/server';

import type { ResourceStore } from './lib/resource-store.js';

import { SLIM_INSTRUCTIONS_CONTENT } from './resources/instructions-content.js';
import { type IconInfo, withDefaultIcons } from './tools/shared.js';

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
}

export { SLIM_INSTRUCTIONS_CONTENT as serverInstructionsContent };

const INSTRUCTIONS_URI = 'internal://instructions';
const RESULT_TEMPLATE = new ResourceTemplate('filesystem-mcp://result/{id}', {
  list: undefined,
});

export function registerAllResources(
  server: McpServer,
  options: ResourceRegistrationOptions
): void {
  server.registerResource(
    'filesystem-mcp-instructions',
    INSTRUCTIONS_URI,
    withDefaultIcons(
      {
        title: 'Server Instructions',
        description:
          'Navigation guide for filesystem-mcp tools and constraints.',
        mimeType: 'text/markdown',
        annotations: { audience: ['assistant'], priority: 0.8 },
      },
      options.iconInfo
    ),
    (uri): ReadResourceResult => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'text/markdown',
          text: SLIM_INSTRUCTIONS_CONTENT,
        },
      ],
    })
  );

  server.registerResource(
    'filesystem-mcp-result',
    RESULT_TEMPLATE,
    withDefaultIcons(
      {
        title: 'Cached Tool Result',
        description:
          'Ephemeral cached tool output. Not listed via resources/list.',
        mimeType: 'text/plain',
        annotations: { audience: ['assistant'], priority: 0.3 },
      },
      options.iconInfo
    ),
    (uri, variables): ReadResourceResult => {
      const { id } = variables;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          'Cached result expired. Re-run the tool to regenerate.'
        );
      }
      const entry = options.resourceStore.getText(uri.toString());
      return {
        contents: [
          { uri: entry.uri, mimeType: entry.mimeType, text: entry.text },
        ],
      };
    }
  );
}
```

- [ ] **Step 2: Update `src/server/bootstrap.ts`**

Apply these changes to `bootstrap.ts`:

**2a. Update the import from `../resources.js`** — remove `ResourcesHandle`:

```typescript
// BEFORE:
import {
  registerAllResources,
  type ResourcesHandle,
  serverInstructionsContent,
} from '../resources.js';

// AFTER:
import {
  registerAllResources,
  serverInstructionsContent,
} from '../resources.js';
```

**2b. Update the import from `../prompts.js`** — remove `registerGetToolHelpPrompt`:

```typescript
// BEFORE:
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
  registerGetToolHelpPrompt,
} from '../prompts.js';

// AFTER:
import {
  registerAnalyzePathPrompt,
  registerCompareFilesPrompt,
  registerGetHelpPrompt,
} from '../prompts.js';
```

**2c. Update `buildServerCapabilities()`** — drop `subscribe` and `listChanged` from resources:

```typescript
// BEFORE:
resources: { listChanged: true, subscribe: true },

// AFTER:
resources: {},
```

**2d. Remove `debouncedNotificationMethods` from `serverConfig`** — delete these two lines entirely:

```typescript
debouncedNotificationMethods: [
  'notifications/resources/list_changed',
  'notifications/resources/updated',
],
```

**2e. Update `createServer()` return type and body** — `registerAllResources` now returns `void`:

```typescript
// BEFORE signature:
export async function createServer(
  options: ServerOptions = {}
): Promise<{ server: McpServer; resourcesHandle: ResourcesHandle }> {

// AFTER signature:
export async function createServer(
  options: ServerOptions = {}
): Promise<{ server: McpServer }> {
```

```typescript
// BEFORE call:
const resourcesHandle = registerAllResources(server, {
  pathGuard: rootsManager.pathGuard,
  resourceStore,
  ...(localIcon ? { iconInfo: localIcon } : {}),
});

// AFTER call (no pathGuard, no return value captured):
registerAllResources(server, {
  resourceStore,
  ...(localIcon ? { iconInfo: localIcon } : {}),
});
```

```typescript
// BEFORE return:
return { server, resourcesHandle };

// AFTER return:
return { server };
```

**2f. Update `registerGetToolHelpPrompt` call** — delete this one line from `createServer`:

```typescript
registerGetToolHelpPrompt(server, localIcon); // DELETE THIS LINE
```

**2g. Update `startServer()`** — remove `resourcesHandle` from param and cleanup:

```typescript
// BEFORE:
export async function startServer(serverAndHandle: {
  server: McpServer;
  resourcesHandle: ResourcesHandle;
}): Promise<void> {
  const { server, resourcesHandle } = serverAndHandle;

// AFTER:
export async function startServer(serverAndHandle: {
  server: McpServer;
}): Promise<void> {
  const { server } = serverAndHandle;
```

```typescript
// BEFORE onclose:
transport.onclose = () => {
  resourcesHandle.destroy();
  rootsManager.destroy();
  sdkOnClose?.();
};

// AFTER onclose:
transport.onclose = () => {
  rootsManager.destroy();
  sdkOnClose?.();
};
```

**2h. Update `HttpSession` interface** — remove `resourcesHandle` field:

```typescript
// BEFORE:
interface HttpSession {
  server: McpServer;
  rootsManager: RootsManager;
  resourcesHandle: ResourcesHandle;
  transport: NodeStreamableHTTPServerTransport;
  createdAt: number;
  cleanup: () => void;
  close: () => Promise<void>;
}

// AFTER:
interface HttpSession {
  server: McpServer;
  rootsManager: RootsManager;
  transport: NodeStreamableHTTPServerTransport;
  createdAt: number;
  cleanup: () => void;
  close: () => Promise<void>;
}
```

**2i. Update `createHttpSession()`** — remove `resourcesHandle` from destructure, session object, and cleanup:

```typescript
// BEFORE:
const { server: mcpServer, resourcesHandle } = await createServer(options);

// AFTER:
const { server: mcpServer } = await createServer(options);
```

```typescript
// BEFORE cleanup:
resourcesHandle.destroy();
rootsManager.destroy();

// AFTER cleanup (delete the resourcesHandle.destroy() line):
rootsManager.destroy();
```

```typescript
// BEFORE session object returned:
return {
  server: mcpServer,
  rootsManager,
  resourcesHandle,
  transport,
  createdAt: Date.now(),
  cleanup,
  close,
};

// AFTER:
return {
  server: mcpServer,
  rootsManager,
  transport,
  createdAt: Date.now(),
  cleanup,
  close,
};
```

- [ ] **Step 3: Run a quick type-check to verify compilation**

```sh
npm run type-check
```

Expected: 0 errors. The old resource files still exist (they'll be deleted in Task 5) but are no longer imported by anyone so they don't affect compilation.

- [ ] **Step 4: Run the updated resources test to verify it now passes**

```sh
node --test --import tsx/esm __tests__/resources.test.ts
```

Expected: "lists exactly 1 static resource" PASSES. "keeps README and server metadata in sync" will FAIL on README assertions — that's expected and fixed in Task 9.

- [ ] **Step 5: Commit**

```sh
git add src/resources.ts src/server/bootstrap.ts __tests__/resources.test.ts
git commit -m "feat: replace resources.ts with 2-resource slim version; update bootstrap"
```

---

### Task 5: Delete dead resource files and slim `tool-info.ts`

These must happen together — deleting the files removes the consumers of the exports being dropped from `tool-info.ts`.

**Files:**

- Delete: 11 files in `src/resources/`
- Modify: `src/resources/tool-info.ts`

- [ ] **Step 1: Delete the 11 orphaned resource files**

```sh
git rm src/resources/contract.ts src/resources/shared.ts src/resources/result.ts src/resources/instructions.ts src/resources/generated-instructions.ts src/resources/filesystem-file.ts src/resources/metrics.ts src/resources/tool-catalog.ts src/resources/tool-catalog-resource.ts src/resources/workflows.ts src/resources/workflows-resource.ts src/resources/tool-info-resource.ts
```

Expected: 12 files deleted (git confirms).

- [ ] **Step 2: Replace `src/resources/tool-info.ts` with the slimmed version**

```typescript
import { ALL_TOOLS } from '../tools.js';
import type { ToolContract } from '../tools/contract.js';

export function getToolContracts(): ToolContract[] {
  return ALL_TOOLS;
}

export function getSortedToolContracts(): ToolContract[] {
  return [...ALL_TOOLS].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

export function pickAvailableToolNames(names: readonly string[]): string[] {
  const nameSet = new Set(ALL_TOOLS.map((c) => c.name));
  return names.filter((name) => nameSet.has(name));
}

export function formatToolNameList(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(', ');
}
```

- [ ] **Step 3: Run type-check to verify compilation**

```sh
npm run type-check
```

Expected: 0 errors.

- [ ] **Step 4: Run instructions-content test to verify slim tool-info still feeds it**

```sh
node --test --import tsx/esm __tests__/resources/instructions-content.test.ts
```

Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```sh
git add src/resources/tool-info.ts
git commit -m "feat: delete 12 dead resource files; slim tool-info.ts to 4 nav helpers"
```

---

### Task 6: Remove `globalMetrics` and metrics listener from `src/lib/observability.ts`

**Files:**

- Modify: `src/lib/observability.ts`

- [ ] **Step 1: Delete the metrics state block** — find and remove these lines (approximately lines 92–136 in the original):

```typescript
// DELETE: ToolMetrics interface
interface ToolMetrics {
  calls: number;
  errors: number;
  totalDurationMs: number;
}

// DELETE: globalMetrics map
export const globalMetrics = new Map<string, ToolMetrics>();

// DELETE: listener types and set
type MetricsListener = () => void;
const metricsListeners = new Set<MetricsListener>();

// DELETE: onMetricsUpdate export
export function onMetricsUpdate(listener: MetricsListener): () => void {
  metricsListeners.add(listener);
  return (): void => {
    metricsListeners.delete(listener);
  };
}

// DELETE: updateMetrics function
function updateMetrics(tool: string, ok: boolean, durationMs: number): void {
  const current = globalMetrics.get(tool) ?? {
    calls: 0,
    errors: 0,
    totalDurationMs: 0,
  };
  current.calls++;
  if (!ok) current.errors++;
  current.totalDurationMs += durationMs;
  globalMetrics.set(tool, current);

  for (const listener of metricsListeners) {
    try {
      listener();
    } catch {
      // Intentionally swallowed: observability must not interrupt tool execution.
    }
  }
}
```

- [ ] **Step 2: Remove `updateMetrics` calls from `runAndObserve`**

Find `runAndObserve` and delete the `updateMetrics(tool, obs.ok, durationMs)` line inside the `finally` block:

```typescript
// BEFORE finally block in runAndObserve:
  } finally {
    const durationMs = performance.now() - startMs;
    loopMonitor?.disable();

    if (pubPerf && eluStart)
      publishPerfEnd(tool, durationMs, eluStart, loopMonitor);
    if (pubTool)
      publishToolEnd(tool, obs.ok, durationMs, obs.errorMsg, traceparent);

    updateMetrics(tool, obs.ok, durationMs);   // DELETE THIS LINE

    if (logErrors && !obs.ok) logError(tool, durationMs, obs.errorMsg);
  }

// AFTER finally block:
  } finally {
    const durationMs = performance.now() - startMs;
    loopMonitor?.disable();

    if (pubPerf && eluStart)
      publishPerfEnd(tool, durationMs, eluStart, loopMonitor);
    if (pubTool)
      publishToolEnd(tool, obs.ok, durationMs, obs.errorMsg, traceparent);

    if (logErrors && !obs.ok) logError(tool, durationMs, obs.errorMsg);
  }
```

- [ ] **Step 3: Simplify `withToolDiagnostics`** — remove all `updateMetrics` call sites and the now-unnecessary timing in fast paths. Replace the full function body:

```typescript
export async function withToolDiagnostics<T>(
  tool: string,
  run: () => Promise<T>,
  options?: { path?: string; traceContext?: TraceContext }
): Promise<T> {
  const config = readConfig();
  const normalizedPath = sanitizePathForDiagnostics(options?.path);

  const context: ToolAsyncContext = {
    tool,
    ...(options?.path ? { path: options.path } : {}),
    ...(options?.traceContext ? { traceContext: options.traceContext } : {}),
  };

  return toolContext.run(context, async () => {
    if (!config.enabled) {
      if (!config.logToolErrors) return run();

      const start = performance.now();
      try {
        const res = await run();
        const duration = performance.now() - start;
        const { ok, error } = extractOutcome(res);
        if (!ok) logError(tool, duration, error);
        return res;
      } catch (e) {
        const duration = performance.now() - start;
        logError(tool, duration, extractErrorMessage(e));
        throw e;
      }
    }

    const pubTool = CHANNELS.tool.hasSubscribers;
    const pubPerf = CHANNELS.perf.hasSubscribers;

    if (!pubTool && !pubPerf) return run();

    return runAndObserve(
      tool,
      run,
      pubTool,
      pubPerf,
      config.logToolErrors,
      normalizedPath,
      options?.traceContext?.traceparent
    );
  });
}
```

- [ ] **Step 4: Run type-check**

```sh
npm run type-check
```

Expected: 0 errors.

- [ ] **Step 5: Commit**

```sh
git add src/lib/observability.ts
git commit -m "feat: remove globalMetrics, onMetricsUpdate, metricsListeners from observability"
```

---

### Task 7: Remove `get-tool-help` from `src/prompts.ts`

**Files:**

- Modify: `src/prompts.ts`

- [ ] **Step 1: Remove the tool-info import line entirely**

```typescript
// DELETE this entire import:
import {
  buildToolInfo,
  getSortedToolContracts,
} from './resources/tool-info.js';
```

- [ ] **Step 2: Delete the four `get-tool-help` constants**

```typescript
// DELETE these four lines:
const GET_TOOL_HELP_PROMPT_NAME = 'get-tool-help';
const GET_TOOL_HELP_PROMPT_TITLE = 'Get Tool Help';
const GET_TOOL_HELP_PROMPT_DESCRIPTION =
  'Return a prompt with the authoritative contract for a specific filesystem-mcp tool.';
```

- [ ] **Step 3: Delete the `findKnownToolName` helper**

```typescript
// DELETE:
function findKnownToolName(rawName: string): string | undefined {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return undefined;

  return getSortedToolContracts().find(
    (contract) => contract.name.toLowerCase() === normalized
  )?.name;
}
```

- [ ] **Step 4: Delete `registerGetToolHelpPrompt` and its export**

```typescript
// DELETE the entire function (about 50 lines starting with):
export function registerGetToolHelpPrompt(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  // ...
}
```

- [ ] **Step 5: Run type-check**

```sh
npm run type-check
```

Expected: 0 errors.

- [ ] **Step 6: Commit**

```sh
git add src/prompts.ts
git commit -m "feat: remove get-tool-help prompt and buildToolInfo dependency"
```

---

### Task 8: Delete three dead test files

**Files:**

- Delete: `__tests__/resources/contract.test.ts`
- Delete: `__tests__/resources/filesystem-file.test.ts`
- Delete: `__tests__/resources/metrics.test.ts`

- [ ] **Step 1: Delete the three files**

```sh
git rm __tests__/resources/contract.test.ts __tests__/resources/filesystem-file.test.ts __tests__/resources/metrics.test.ts
```

- [ ] **Step 2: Remove the now-empty `__tests__/resources/` directory** (only `instructions-content.test.ts` remains — move it up if desired, or leave it in place)

The directory still has `instructions-content.test.ts`, so no action needed.

- [ ] **Step 3: Commit**

```sh
git commit -m "test: delete contract, filesystem-file, and metrics resource test files"
```

---

### Task 9: Update `__tests__/prompts.test.ts` and `__tests__/prompts-stdio.test.ts`

**Files:**

- Modify: `__tests__/prompts.test.ts`
- Modify: `__tests__/prompts-stdio.test.ts`

- [ ] **Step 1: In `__tests__/prompts.test.ts`, update the `listPrompts` assertion (around line 59)**

```typescript
// BEFORE:
assert.deepEqual(names, [
  'analyze-path',
  'compare-files',
  'get-help',
  'get-tool-help',
]);

// AFTER:
assert.deepEqual(names, ['analyze-path', 'compare-files', 'get-help']);
```

- [ ] **Step 2: In `__tests__/prompts.test.ts`, delete the two `get-tool-help` test cases** — find and remove the two `it(...)` blocks that start with these lines:

```
it('returns get-tool-help with embedded resource content', async () => {
```

and

```
it('returns an invalid-input error for an unknown get-tool-help target', async () => {
```

Both blocks run to their closing `});` — delete each block entirely (~35 lines total).

- [ ] **Step 3: In `__tests__/prompts-stdio.test.ts`, delete the `get-tool-help` test case** — find and remove the block starting with:

```
it('returns get-tool-help with required args over stdio transport', async (t) => {
```

Delete to its closing `});` (~27 lines).

- [ ] **Step 4: Run the prompt tests to verify they pass**

```sh
node --test --import tsx/esm __tests__/prompts.test.ts
```

Expected: 4 tests pass (list, analyze-path, compare-files, get-help). The get-tool-help tests are gone.

- [ ] **Step 5: Commit**

```sh
git add __tests__/prompts.test.ts __tests__/prompts-stdio.test.ts
git commit -m "test: remove get-tool-help prompt tests"
```

---

### Task 10: Update `__tests__/unit/completions.test.ts`

**Files:**

- Modify: `__tests__/unit/completions.test.ts`

- [ ] **Step 1: Remove the three stale imports at the top of the file**

```typescript
// DELETE these three lines:
import { registerGetToolHelpPrompt } from '../../src/prompts.js';
import { ALL_RESOURCES, registerAllResources } from '../../src/resources.js';
import { buildServerInstructions } from '../../src/resources/generated-instructions.js';
```

Add back only what the file still needs from `resources.js`:

```typescript
import { registerAllResources } from '../../src/resources.js';
```

- [ ] **Step 2: Update `makeCompletionServer()`** — remove `registerGetToolHelpPrompt`, fix `registerAllResources` call (no `pathGuard`), and fix instructions build:

```typescript
// AFTER:
import { serverInstructionsContent } from '../../src/resources.js';

// BEFORE:
function makeCompletionServer(withInstructions = false): McpServer {
  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { completions: {} } }
  );
  const instructions = withInstructions
    ? buildServerInstructions(ALL_RESOURCES)
    : '';
  registerGetHelpPrompt(server, instructions);
  registerGetToolHelpPrompt(server);
  registerAnalyzePathPrompt(server);
  registerCompareFilesPrompt(server);

  const resourceStore = createInMemoryResourceStore();
  const pathGuard = getDefaultPathGuard();

  registerAllResources(server, {
    pathGuard,
    resourceStore,
  });
  return server;
}

// (add this import at the top with the other resources.js import)

function makeCompletionServer(withInstructions = false): McpServer {
  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { completions: {} } }
  );
  const instructions = withInstructions ? serverInstructionsContent : '';
  registerGetHelpPrompt(server, instructions);
  registerAnalyzePathPrompt(server);
  registerCompareFilesPrompt(server);

  const resourceStore = createInMemoryResourceStore();

  registerAllResources(server, { resourceStore });
  return server;
}
```

- [ ] **Step 3: Delete the two obsolete `it(...)` test blocks** — find and remove:

```
it('completes tool names for the get-tool-help prompt', async () => {
```

(~25 lines, delete to its closing `});`)

```
it('completes tool-info template names for resource references', async () => {
```

(~25 lines, delete to its closing `});`)

- [ ] **Step 4: Remove unused import of `getDefaultPathGuard`** if it is now unused (grep the file first):

```sh
grep -n "getDefaultPathGuard\|pathGuard" __tests__/unit/completions.test.ts
```

If the only remaining usage was in `makeCompletionServer`, remove the import line.

- [ ] **Step 5: Run completions tests**

```sh
node --test --import tsx/esm __tests__/unit/completions.test.ts
```

Expected: all remaining tests pass (topic completion, path completion, etc.).

- [ ] **Step 6: Commit**

```sh
git add __tests__/unit/completions.test.ts
git commit -m "test: update completions test — remove get-tool-help and tool-info completions"
```

---

### Task 11: Update `__tests__/http.test.ts`

**Files:**

- Modify: `__tests__/http.test.ts`

- [ ] **Step 1: Remove stale imports at the top**

```typescript
// DELETE:
import { getToolContracts } from '../src/resources/tool-info.js';
```

- [ ] **Step 2: Remove the `staticResourceUris` array from the `describe` block** — find and delete these lines:

```typescript
const staticResourceUris = [
  'filesystem-mcp://metrics',
  'internal://instructions',
  'internal://tool-catalog',
  'internal://workflows',
];
```

- [ ] **Step 3: Find the HTTP discovery test** (the `it(...)` block that calls `client.listResources()` around line 514 in the original) and replace its resource/prompt assertions:

```typescript
// BEFORE (inside the discovery test):
const { tools } = await client.listTools();
const { resources } = await client.listResources();
const { resourceTemplates } = await client.listResourceTemplates();
const { prompts } = await client.listPrompts();
const toolInfoUris = getToolContracts()
  .map((contract) => `internal://tool-info/${contract.name}`)
  .sort();
const resourceUris = resources.map((resource) => resource.uri).sort();

assert.equal(tools.length, 18);
assert.deepEqual(
  resourceUris,
  [...staticResourceUris, ...toolInfoUris].sort()
);
assert.deepEqual(
  resourceTemplates.map((template) => template.uriTemplate).sort(),
  [
    'filesystem-mcp://file/{+path}',
    'filesystem-mcp://result/{id}',
    'internal://tool-info/{name}',
  ]
);
assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), [
  'analyze-path',
  'compare-files',
  'get-help',
  'get-tool-help',
]);

const metrics = await client.readResource({
  uri: 'filesystem-mcp://metrics',
});
assert.equal(metrics.contents.length, 1);

// AFTER:
const { tools } = await client.listTools();
const { resources } = await client.listResources();
const { resourceTemplates } = await client.listResourceTemplates();
const { prompts } = await client.listPrompts();

assert.equal(tools.length, 18);
assert.equal(resources.length, 1);
assert.equal(resources[0]?.uri, 'internal://instructions');
assert.deepEqual(
  resourceTemplates.map((template) => template.uriTemplate).sort(),
  ['filesystem-mcp://result/{id}']
);
assert.deepEqual(prompts.map((prompt) => prompt.name).sort(), [
  'analyze-path',
  'compare-files',
  'get-help',
]);
```

- [ ] **Step 4: Run the HTTP test suite**

```sh
node --test --import tsx/esm __tests__/http.test.ts
```

Expected: all HTTP tests pass.

- [ ] **Step 5: Commit**

```sh
git add __tests__/http.test.ts
git commit -m "test: update HTTP discovery test — 1 resource, 1 template, 3 prompts"
```

---

### Task 12: Update `README.md`

**Files:**

- Modify: `README.md`

- [ ] **Step 1: Update the headline bullet** — find and replace:

```
// BEFORE:
**Self-documenting** — 7 built-in resources (`internal://instructions`, `internal://tool-catalog`, etc.) and 4 built-in prompts (`get-help`, `compare-files`, `analyze-path`, `get-tool-help`)

// AFTER:
**Self-documenting** — 2 built-in resources (`internal://instructions`, `filesystem-mcp://result/{id}`) and 3 built-in prompts (`get-help`, `compare-files`, `analyze-path`)
```

- [ ] **Step 2: Update the `### Resources` table** — replace with:

```markdown
### Resources

| Resource     | URI                            | MIME Type     | Description                                                    |
| ------------ | ------------------------------ | ------------- | -------------------------------------------------------------- |
| Instructions | `internal://instructions`      | text/markdown | Navigation guide: role, tool overview, constraints, recovery   |
| Result Cache | `filesystem-mcp://result/{id}` | text/plain    | Ephemeral cached tool output (large results externalized here) |
```

- [ ] **Step 3: Update the `### Prompts` table** — remove the `get-tool-help` row:

```markdown
### Prompts

| Prompt          | Arguments              | Description                                                     |
| --------------- | ---------------------- | --------------------------------------------------------------- |
| `get-help`      | `topic` (optional)     | Return usage instructions. Optionally filter by section heading |
| `compare-files` | `original`, `modified` | Generate a workflow for comparing two files using `diff_files`  |
| `analyze-path`  | `path`                 | Generate a workflow for analyzing a file or directory           |
```

- [ ] **Step 4: Update the MCP Capabilities table** — find the `resources` row and update its evidence note:

```
// BEFORE:
| `resources`   | confirmed | `src/server/bootstrap.ts` — 6 resources registered                         |

// AFTER:
| `resources`   | confirmed | `src/server/bootstrap.ts` — 2 resources registered, no subscribe/listChanged |
```

- [ ] **Step 5: Update the headline tool count line** if it says `18 filesystem tools` — verify it's still accurate (it is, no tool changes).

- [ ] **Step 6: Search for any remaining references to deleted resources**

```sh
grep -n "tool-catalog\|filesystem-mcp://file\|filesystem-mcp://metrics\|internal://workflows\|internal://tool-info\|get-tool-help\|7 built-in resources\|4 built-in prompts" README.md
```

Fix any remaining hits.

- [ ] **Step 7: Commit**

```sh
git add README.md
git commit -m "docs: update README — 2 resources, 3 prompts, slim description"
```

---

### Task 13: Final verification

**Files:** none modified

- [ ] **Step 1: Run the full task suite**

```sh
node scripts/tasks.mjs
```

Expected output: format → lint → type-check → knip → test → rebuild all pass with 0 errors, 0 warnings.

- [ ] **Step 2: If any test fails, read the failure detail**

```sh
node scripts/tasks.mjs --detail 1
```

Fix the specific failure before proceeding.

- [ ] **Step 3: Verify the resource count in the running server matches expectations**

```sh
node --test --import tsx/esm __tests__/resources.test.ts
```

Expected: all 3 tests pass.

- [ ] **Step 4: Verify the HTTP discovery test is green**

```sh
node --test --import tsx/esm __tests__/http.test.ts
```

Expected: all HTTP tests pass.

- [ ] **Step 5: Final commit if anything was fixed in this task**

If any fixes were made, commit them:

```sh
git add -p
git commit -m "fix: address final verification failures"
```

---

## Self-Review

**Spec coverage check:**

| Spec requirement                                                               | Covered by                       |
| ------------------------------------------------------------------------------ | -------------------------------- |
| Cut to 2 resources (instructions + result cache)                               | Tasks 3, 4                       |
| Delete 11 dead resource files                                                  | Task 5                           |
| Slim `tool-info.ts` to 4 nav helpers                                           | Task 5                           |
| Create `instructions-content.ts` with slim markdown                            | Tasks 1, 2                       |
| `resources.ts` → flat 2-resource module                                        | Task 4                           |
| Drop `subscribe: true` / `listChanged: true` from capabilities                 | Task 4 (bootstrap)               |
| Remove `debouncedNotificationMethods`                                          | Task 4 (bootstrap)               |
| `createServer()` returns `{ server }` only                                     | Task 4 (bootstrap)               |
| Remove `ResourcesHandle` type and lifecycle                                    | Task 4 (bootstrap, resources.ts) |
| Remove `globalMetrics`, `onMetricsUpdate`, `metricsListeners`, `updateMetrics` | Task 6                           |
| Remove `get-tool-help` prompt                                                  | Task 7                           |
| Remove `registerGetToolHelpPrompt` from bootstrap                              | Task 4 step 2f                   |
| Delete 3 dead test files                                                       | Task 8                           |
| Update `resources.test.ts`                                                     | Task 3                           |
| Update `prompts.test.ts` + `prompts-stdio.test.ts`                             | Task 9                           |
| Update `completions.test.ts`                                                   | Task 10                          |
| Update `http.test.ts`                                                          | Task 11                          |
| Update `README.md`                                                             | Task 12                          |

No gaps found.

**Placeholder scan:** All code steps contain complete, runnable code. No TBD, TODO, or "similar to Task N" references.

**Type consistency:** `SLIM_INSTRUCTIONS_CONTENT` defined in Task 2, imported in `resources.ts` Task 4. `buildSlimInstructions()` defined in Task 2, tested in Task 1. `ResourceRegistrationOptions` defined in new `resources.ts` (Task 4) — used in completions.test.ts update (Task 10) as `{ resourceStore }` (no `pathGuard`). Consistent throughout.
