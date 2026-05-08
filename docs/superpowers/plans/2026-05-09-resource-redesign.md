# Resource Layer Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor `src/resources.ts` to use a typed, contract-based registry and implement the `filesystem-mcp://file/{+path}` resource with file watching and path auto-completion.

**Architecture:** We will create a `ResourceContract` interface matching the declarative style of tools. We will split the current `resources.ts` into individual resource files (`instructions.ts`, `result.ts`, `filesystem.ts`) under `src/resources/`. A new `src/resources.ts` module will aggregate these into an `ALL_RESOURCES` array, register them with the `McpServer`, and centrally route `resources/subscribe` and `resources/unsubscribe` requests.

**Tech Stack:** Node.js, `node:fs`, `node:fs/promises`, `@modelcontextprotocol/server`.

---

### Task 1: Create the Resource Contract

**Files:**

- Create: `src/resources/contract.ts`

- [ ] **Step 1: Write the `ResourceContract` interface and subscription lifecycle type**

```typescript
import type {
  ReadResourceResult,
  ServerContext,
} from '@modelcontextprotocol/server';

export interface ResourceContract {
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;

  uri?: string;
  uriTemplate?: string;

  annotations?: {
    audience?: ('user' | 'assistant')[];
    priority?: number;
  };

  read: (
    uri: URL,
    variables: Record<string, string>,
    ctx: ServerContext
  ) => Promise<ReadResourceResult> | ReadResourceResult;
  complete?: (
    variable: string,
    value: string,
    ctx?: { arguments?: Record<string, string> }
  ) => Promise<string[]> | string[];

  subscribe?: (uri: string, notify: (uri: string) => void) => void;
  unsubscribe?: (uri: string) => void;
}
```

- [ ] **Step 2: Create a shared options interface for resource factories**

Create `src/resources/shared.ts` to hold dependencies needed by resource factories:

```typescript
import type { PathGuard } from '../lib/path-guard.js';
import type { ResourceStore } from '../lib/resource-store.js';

import type { IconInfo } from '../tools/shared.js';

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
  pathGuard?: PathGuard;
}

export interface ResourcesHandle {
  destroy(): void;
}
```

- [ ] **Step 3: Commit the contract and shared types**

```bash
git add src/resources/contract.ts src/resources/shared.ts
git commit -m "feat(resources): add ResourceContract and shared types"
```

---

### Task 2: Implement the Filesystem Resource

**Files:**

- Create: `src/resources/filesystem.ts`

- [ ] **Step 1: Write the Filesystem resource contract**

```typescript
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import { type FSWatcher, watch } from 'node:fs';

import { readFileWithStats } from '../lib/file-content.js';
import { completePathCached } from '../lib/path-completer.js';

import type { ResourceContract } from './contract.js';
import type { ResourceRegistrationOptions } from './shared.js';

export const FILESYSTEM_FILE_URI_TEMPLATE = 'filesystem-mcp://file/{+path}';
const FILE_URI_PREFIX = 'filesystem-mcp://file/';

function extractPath(uri: string): string | undefined {
  if (!uri.startsWith(FILE_URI_PREFIX)) return undefined;
  const rawPath = uri.slice(FILE_URI_PREFIX.length);
  if (!rawPath.startsWith('/')) return undefined;
  try {
    return decodeURIComponent(rawPath.slice(1));
  } catch {
    return undefined;
  }
}

export function createFilesystemResource(
  options: ResourceRegistrationOptions
): ResourceContract {
  const watchers = new Map<string, FSWatcher>();

  return {
    name: 'filesystem-mcp-file',
    title: 'Workspace File',
    description:
      'Read a file from the workspace. Subscribe to get updates when the file changes.',
    uriTemplate: FILESYSTEM_FILE_URI_TEMPLATE,
    annotations: { audience: ['assistant'], priority: 0.8 },

    async read(uri, variables) {
      if (!options.pathGuard) {
        throw new ProtocolError(
          ProtocolErrorCode.InternalError,
          'PathGuard not configured'
        );
      }
      const rawPath = variables.path;
      if (!rawPath) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          'Path variable is required'
        );
      }
      const targetPath = '/' + rawPath;
      const resolved = await options.pathGuard.validateExistingPath(targetPath);
      const readResult = await readFileWithStats(resolved);

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: readResult.mimeType || 'application/octet-stream',
            text: !readResult.isBinary
              ? readResult.content.toString('utf-8')
              : undefined,
            blob: readResult.isBinary
              ? readResult.content.toString('base64')
              : undefined,
          },
        ],
      };
    },

    async complete(variable, value) {
      if (variable === 'path' && options.pathGuard) {
        // value doesn't have the leading '/' because the template expands as {+path} (without root slash if typed as relative)
        // path-completer expects absolute paths starting with /, but we must handle relative typing
        return completePathCached('/' + value, options.pathGuard);
      }
      return [];
    },

    subscribe(uri, notify) {
      if (!options.pathGuard || watchers.has(uri)) return;
      const filePath = extractPath(uri);
      if (!filePath) return;

      options.pathGuard
        .validateExistingPath(filePath)
        .then((resolved) => {
          const watcher = watch(resolved, () => {
            notify(uri);
          });
          watcher.on('error', () => {
            /* ignore */
          });
          watchers.set(uri, watcher);
        })
        .catch(() => {
          /* silent ignore for unallowed/missing files */
        });
    },

    unsubscribe(uri) {
      const watcher = watchers.get(uri);
      if (watcher) {
        watcher.close();
        watchers.delete(uri);
      }
    },
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/resources/filesystem.ts
git commit -m "feat(resources): implement filesystem file resource"
```

---

### Task 3: Extract Instructions and Result Resources

**Files:**

- Create: `src/resources/instructions.ts`
- Create: `src/resources/result.ts`

- [ ] **Step 1: Extract `instructions.ts`**

```typescript
import type { ResourceContract } from './contract.js';
import { SLIM_INSTRUCTIONS_CONTENT } from './instructions-content.js';

export function createInstructionsResource(): ResourceContract {
  return {
    name: 'filesystem-mcp-instructions',
    title: 'Server Instructions',
    description: 'Navigation guide for filesystem-mcp tools and constraints.',
    mimeType: 'text/markdown',
    uri: 'internal://instructions',
    annotations: { audience: ['assistant'], priority: 0.8 },
    read(uri) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: SLIM_INSTRUCTIONS_CONTENT,
          },
        ],
      };
    },
  };
}
```

- [ ] **Step 2: Extract `result.ts`**

```typescript
import { ProtocolError, ProtocolErrorCode } from '@modelcontextprotocol/server';

import type { ResourceContract } from './contract.js';
import type { ResourceRegistrationOptions } from './shared.js';

export function createResultResource(
  options: ResourceRegistrationOptions
): ResourceContract {
  return {
    name: 'filesystem-mcp-result',
    title: 'Cached Tool Result',
    description: 'Ephemeral cached tool output. Not listed via resources/list.',
    mimeType: 'text/plain',
    uriTemplate: 'filesystem-mcp://result/{id}',
    annotations: { audience: ['assistant'], priority: 0.3 },
    read(uri, variables) {
      const { id } = variables;
      if (typeof id !== 'string' || id.length === 0) {
        throw new ProtocolError(
          ProtocolErrorCode.ResourceNotFound,
          'Cached result expired. Re-run the tool to regenerate.'
        );
      }

      const entry = options.resourceStore.getEntry(uri.toString());
      if (entry.kind === 'text') {
        return {
          contents: [
            { uri: entry.uri, mimeType: entry.mimeType, text: entry.text },
          ],
        };
      }
      return {
        contents: [
          {
            uri: entry.uri,
            mimeType: entry.mimeType,
            blob: entry.data.toString('base64'),
          },
        ],
      };
    },
  };
}
```

- [ ] **Step 3: Commit**

```bash
git add src/resources/instructions.ts src/resources/result.ts
git commit -m "refactor(resources): extract instruction and result contracts"
```

---

### Task 4: Rewrite the Central Registry

**Files:**

- Modify: `src/resources.ts`

- [ ] **Step 1: Build the registry and centralized subscription router**

Overwrite `src/resources.ts` completely:

```typescript
import { type McpServer, ResourceTemplate } from '@modelcontextprotocol/server';

import { uriTemplate } from 'uritemplate-rfc6570';

import type { ResourceContract } from './resources/contract.js';
import { createFilesystemResource } from './resources/filesystem.js';
import { createInstructionsResource } from './resources/instructions.js';
import { createResultResource } from './resources/result.js';
import type {
  ResourceRegistrationOptions,
  ResourcesHandle,
} from './resources/shared.js';
import { withDefaultIcons } from './tools/shared.js';

export { SLIM_INSTRUCTIONS_CONTENT as serverInstructionsContent } from './resources/instructions-content.js';
export type { ResourceRegistrationOptions, ResourcesHandle };

export function registerAllResources(
  server: McpServer,
  options: ResourceRegistrationOptions
): ResourcesHandle {
  const ALL_RESOURCES: ResourceContract[] = [
    createInstructionsResource(),
    createResultResource(options),
    createFilesystemResource(options),
  ];

  for (const contract of ALL_RESOURCES) {
    const config = withDefaultIcons(
      {
        title: contract.title,
        description: contract.description,
        mimeType: contract.mimeType,
        annotations: contract.annotations,
      },
      options.iconInfo
    );

    if (contract.uriTemplate) {
      const template = new ResourceTemplate(contract.uriTemplate, {
        list: undefined,
        complete: contract.complete
          ? Object.fromEntries(
              uriTemplate(contract.uriTemplate)
                .expressions.flatMap((expr) => expr.templateText.split(','))
                .map((v) => {
                  const varName = v.replace(/^[\+\#\.\/\;\?\&]/, '');
                  return [
                    varName,
                    (
                      val: string,
                      ctx?: { arguments?: Record<string, string> }
                    ) => contract.complete!(varName, val, ctx),
                  ];
                })
            )
          : undefined,
      });

      server.registerResourceTemplate(
        contract.name,
        template,
        config,
        (uri, variables, ctx) => contract.read(uri, variables, ctx)
      );
    } else if (contract.uri) {
      server.registerResource(contract.name, contract.uri, config, (uri, ctx) =>
        contract.read(uri, {}, ctx)
      );
    }
  }

  // Hook into subscriptions routing
  server.server.setRequestHandler(
    'resources/subscribe',
    async (req: { params: { uri: string } }) => {
      const { uri } = req.params;
      for (const contract of ALL_RESOURCES) {
        if (contract.subscribe) {
          // Simplistic routing - normally we'd check if URI matches template or exact URI
          let matches = false;
          if (contract.uri && uri === contract.uri) matches = true;
          if (contract.uriTemplate) {
            // Check if URI matches the template prefix (e.g. filesystem-mcp://file/)
            const prefix = contract.uriTemplate.split('{')[0];
            if (uri.startsWith(prefix)) matches = true;
          }

          if (matches) {
            contract.subscribe(uri, (updatedUri) => {
              void server.server
                .sendResourceUpdated({ uri: updatedUri })
                .catch(() => {});
            });
            break;
          }
        }
      }
      return {};
    }
  );

  server.server.setRequestHandler(
    'resources/unsubscribe',
    async (req: { params: { uri: string } }) => {
      const { uri } = req.params;
      for (const contract of ALL_RESOURCES) {
        if (contract.unsubscribe) {
          contract.unsubscribe(uri);
        }
      }
      return {};
    }
  );

  return {
    destroy(): void {
      for (const contract of ALL_RESOURCES) {
        if (contract.unsubscribe) {
          // Hack: we don't track all active URIs globally, but resources manage their own state.
          // Since the ResourceContract has no zero-arg cleanup, let's just ask each one to cleanup if they expose a method.
          // To fix this cleanly, add `destroy?(): void;` to ResourceContract.
          if (contract.destroy) {
            contract.destroy();
          }
        }
      }
    },
  };
}
```

Wait, `complete` signature expected by `@modelcontextprotocol/server` is `(value: string, context?: { arguments?: Record<string, string> }) => Promise<string[]> | string[]`. We mapped it but we need to ensure type safety. Let's fix `contract.ts` `destroy` hook in step 5.

- [ ] **Step 2: Add `destroy` hook to `ResourceContract`**

Edit `src/resources/contract.ts` to add:

```typescript
  /** Global teardown hook to clean up watchers/timers */
  destroy?: () => void;
```

Update `filesystem.ts`:

```typescript
    destroy() {
      for (const watcher of watchers.values()) {
        watcher.close();
      }
      watchers.clear();
    }
```

- [ ] **Step 3: Update Type signature mapping in `src/resources.ts`**

Adjust the complete callback mapping in `src/resources.ts`:

```typescript
        complete: contract.complete
          ? Object.fromEntries(
              uriTemplate(contract.uriTemplate)
                .expressions.flatMap(expr => expr.templateText.split(','))
                .map(v => {
                  const varName = v.replace(/^[\+\#\.\/\;\?\&]/, '');
                  return [
                    varName,
                    (value: string, ctx?: { arguments?: Record<string, string> }) =>
                      contract.complete!(varName, value, ctx)
                  ];
                })
            )
          : undefined,
```

- [ ] **Step 4: Run type checking to verify**

Run: `node scripts/tasks.mjs --quick`
Expected: Type checking passes.

- [ ] **Step 5: Commit**

```bash
git add src/resources/contract.ts src/resources/filesystem.ts src/resources.ts
git commit -m "feat(resources): implement centralized resource registry routing"
```

---

### Task 5: Run Final Checks

**Files:**

- Test: `__tests__/resources.test.ts` (if it exists) or general tests.

- [ ] **Step 1: Run all tests**

Run: `node scripts/tasks.mjs`
Expected: Everything passes. If any legacy tests referenced `src/resources.ts` internal variables, update their imports.

- [ ] **Step 2: Final Commit**

```bash
git commit -am "chore: fix resource tests"
```
