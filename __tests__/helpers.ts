import { Client } from '@modelcontextprotocol/client';
import type { ElicitResult } from '@modelcontextprotocol/client';
import { InMemoryTaskMessageQueue, McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PathGuard, resolveAllowedDirectoriesState } from '../src/core/path.js';
import { createInMemoryResourceStore, type ResourceStore } from '../src/core/store.js';
import { TaskOrchestrator } from '../src/tasks.js';
import { CALCULATE_HASH } from '../src/tools/calculate-hash.js';
import { CREATE } from '../src/tools/create.js';
import { DELETE_FILE } from '../src/tools/delete-file.js';
import { EDIT } from '../src/tools/edit.js';
import { LIST } from '../src/tools/list.js';
import { MOVE } from '../src/tools/move.js';
import { READ_FILE } from '../src/tools/read.js';
import { SEARCH_AND_REPLACE } from '../src/tools/replace-in-files.js';
import { LIST_ALLOWED_DIRECTORIES } from '../src/tools/roots.js';
import { SEARCH_CONTENT } from '../src/tools/search-content.js';
import { SEARCH_FILES } from '../src/tools/search-files.js';
import { GET_FILE_INFO } from '../src/tools/stat.js';
import { LinkedTransport } from './linked-transport.js';

// Disable worker threads in integration tests — workers are tested separately.
process.env.FS_DISABLE_WORKERS ??= '1';

interface TestContentBlock {
  type: string;
  text?: string;
}

export interface ToolResult {
  isError?: boolean;
  content: TestContentBlock[];
  structuredContent?: unknown;
}

export interface TestEnv {
  client: Client;
  tmpDir: string;
  resourceStore: ResourceStore;
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated MCP test environment with a unique temp directory.
 * Registers all tools with isInitialized=true and sets the allowed directory
 * singleton to [tmpDir] so path validation works correctly.
 */
export async function createTestEnv(): Promise<TestEnv> {
  const tmpDir = await mkdtemp(join(tmpdir(), `fsmcp-${randomUUID().slice(0, 8)}-`));

  const orchestrator = new TaskOrchestrator();
  const taskStore = orchestrator;

  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
        completions: {},
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
          taskStore,
          taskMessageQueue: new InMemoryTaskMessageQueue(),
        },
      },
    },
  );

  const resourceStore = createInMemoryResourceStore();
  const pathGuard = new PathGuard();
  const state = await resolveAllowedDirectoriesState([tmpDir]);
  pathGuard.initialize(state);
  const deps = {
    server,
    pathGuard,
    resourceStore,
    isInitialized: () => true,
    orchestrator,
  };
  const ALL_TOOLS = [
    CALCULATE_HASH,
    CREATE,
    DELETE_FILE,
    EDIT,
    LIST,
    MOVE,
    READ_FILE,
    SEARCH_AND_REPLACE,
    LIST_ALLOWED_DIRECTORIES,
    SEARCH_CONTENT,
    SEARCH_FILES,
    GET_FILE_INFO,
  ];
  for (const tool of ALL_TOOLS) {
    tool.register(deps);
  }

  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    {
      capabilities: {
        tasks: {},
        experimental: {
          tasks: {
            requests: {
              tools: {
                call: {},
              },
            },
          },
        },
      },
    },
  );
  const [ct, st] = LinkedTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  const cleanup = async (): Promise<void> => {
    taskStore.cleanup();
    try {
      await client.close();
    } catch {
      // ignore – transport may already be closed
    }
    try {
      await server.close();
    } catch {
      // ignore
    }
    await rm(tmpDir, { recursive: true, force: true });
  };

  return { client, tmpDir, resourceStore, cleanup };
}

export type ElicitationHandler = (params: {
  mode: string;
  message: string;
  requestedSchema: unknown;
}) => Promise<ElicitResult>;

/**
 * Like createTestEnv but the MCP client advertises `elicitation: {}` capability
 * and delegates all elicitation/create requests to `handler`.
 */
export async function createTestEnvWithElicitation(handler: ElicitationHandler): Promise<TestEnv> {
  const tmpDir = await mkdtemp(join(tmpdir(), `fsmcp-${randomUUID().slice(0, 8)}-`));

  const orchestrator = new TaskOrchestrator();
  const taskStore = orchestrator;

  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
        completions: {},
        tasks: {
          list: {},
          cancel: {},
          requests: { tools: { call: {} } },
          taskStore,
          taskMessageQueue: new InMemoryTaskMessageQueue(),
        },
      },
    },
  );

  const resourceStore = createInMemoryResourceStore();
  const pathGuard = new PathGuard();
  const state = await resolveAllowedDirectoriesState([tmpDir]);
  pathGuard.initialize(state);
  const deps2 = {
    server,
    pathGuard,
    resourceStore,
    isInitialized: () => true,
    orchestrator,
  };
  const ALL_TOOLS = [
    CALCULATE_HASH,
    CREATE,
    DELETE_FILE,
    EDIT,
    LIST,
    MOVE,
    READ_FILE,
    SEARCH_AND_REPLACE,
    LIST_ALLOWED_DIRECTORIES,
    SEARCH_CONTENT,
    SEARCH_FILES,
    GET_FILE_INFO,
  ];
  for (const tool of ALL_TOOLS) {
    tool.register(deps2);
  }

  // Client advertises elicitation capability so the server will call elicitInput
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    {
      capabilities: {
        elicitation: {},
        experimental: {
          tasks: {
            requests: {
              tools: {
                call: {},
              },
            },
          },
        },
      },
    },
  );

  // Register the elicitation handler for server→client elicitation/create requests.
  client.setRequestHandler('elicitation/create', (request) =>
    handler(
      request.params as {
        mode: string;
        message: string;
        requestedSchema: unknown;
      },
    ),
  );

  const [ct, st] = LinkedTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  const cleanup = async (): Promise<void> => {
    taskStore.cleanup();
    try {
      await client.close();
    } catch {
      /* ignore */
    }
    try {
      await server.close();
    } catch {
      /* ignore */
    }
    await rm(tmpDir, { recursive: true, force: true });
  };

  return { client, tmpDir, resourceStore, cleanup };
}

/**
 * Assert that a tool call returned an MCP-level error result.
 * Optionally verifies the error code from "CODE: …" format.
 */
export function assertToolError(result: unknown, expectedCode?: string): void {
  const r = result as ToolResult;
  assert.equal(r.isError, true, 'Expected isError to be true');
  const textBlock = r.content.find(
    (b): b is { type: string; text: string } => typeof b.text === 'string',
  );
  assert.ok(textBlock, 'Error result must have a text block');
  if (expectedCode !== undefined) {
    const match = /^([A-Z][A-Z_]+):/.exec(textBlock.text);
    assert.ok(match, `Expected "${expectedCode}: …" pattern in:\n${textBlock.text}`);
    assert.equal(match[1], expectedCode);
  }
}

/**
 * Assert that a tool call succeeded.
 * Fails with the error text if the result has isError: true.
 */
export function assertOk(result: unknown): void {
  const r = result as ToolResult;
  if (r.isError === true) {
    const textBlock = r.content.find(
      (b): b is { type: string; text: string } => typeof b.text === 'string',
    );
    assert.fail(`Expected success, got error: ${textBlock?.text ?? 'unknown error'}`);
  }
  assert.ok(r.content.length > 0, 'Result must have at least one content block');
}

/**
 * Return structuredContent cast as a plain record.
 * Asserts it is non-null and non-undefined.
 */
export function getStructured(result: unknown): Record<string, unknown> {
  const r = result as ToolResult;
  const sc = r.structuredContent;
  assert.ok(
    sc !== undefined && sc !== null,
    'structuredContent must be present on success results',
  );
  return sc as Record<string, unknown>;
}

/**
 * Read a resource link from a tool response (for testing).
 * Fetches the resource via the ResourceStore.
 * @param store ResourceStore instance
 * @param result Tool result with content blocks
 * @returns Promise with decoded content and metadata, or null if no resource_link found
 */
export async function readResourceLink(
  store: ResourceStore,
  result: {
    content?: {
      type: string;
      uri?: string;
      [key: string]: unknown;
    }[];
  },
): Promise<{
  text?: string;
  blob?: Buffer;
  mimeType?: string;
  size?: number;
} | null> {
  if (!result.content) return null;

  // Find first resource_link block
  const linkBlock = result.content.find((b) => b.type === 'resource_link');
  if (!linkBlock?.uri) return null;

  const uri = linkBlock.uri;

  // Try to read as text first
  try {
    const entry = store.getText(uri);
    return { text: entry.text, mimeType: entry.mimeType, size: entry.size };
  } catch {
    // Not a text entry, try blob
  }

  // Try to read as blob
  try {
    const entry = store.getBlob(uri);
    return { blob: entry.data, mimeType: entry.mimeType, size: entry.size };
  } catch {
    // Not found
  }

  return null;
}
