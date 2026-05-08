import { Client } from '@modelcontextprotocol/client';
import type { ElicitResult } from '@modelcontextprotocol/client';
import {
  InMemoryTaskMessageQueue,
  McpServer,
} from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SENSITIVE_FILE_DENYLIST } from '../src/lib/constants.js';
import { PathGuard, setDefaultPathGuard } from '../src/lib/path-guard.js';
import { resolveAllowedDirectoriesState } from '../src/lib/paths.js';
import { createInMemoryResourceStore } from '../src/lib/resource-store.js';
import { createTaskStore } from '../src/server/task-store.js';
import { registerAllTools } from '../src/tools.js';
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
  cleanup: () => Promise<void>;
}

/**
 * Create an isolated MCP test environment with a unique temp directory.
 * Registers all tools with isInitialized=true and sets the allowed directory
 * singleton to [tmpDir] so path validation works correctly.
 */
export async function createTestEnv(): Promise<TestEnv> {
  const tmpDir = await mkdtemp(
    join(tmpdir(), `fsmcp-${randomUUID().slice(0, 8)}-`)
  );

  const taskStore = createTaskStore();

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
    }
  );

  const resourceStore = createInMemoryResourceStore();
  const pathGuard = new PathGuard(SENSITIVE_FILE_DENYLIST);
  const state = await resolveAllowedDirectoriesState([tmpDir]);
  pathGuard.initialize(state);
  setDefaultPathGuard(pathGuard);
  registerAllTools(server, {
    pathGuard,
    resourceStore,
    isInitialized: () => true,
    hasTaskSupport: true,
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' });
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

  return { client, tmpDir, cleanup };
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
export async function createTestEnvWithElicitation(
  handler: ElicitationHandler
): Promise<TestEnv> {
  const tmpDir = await mkdtemp(
    join(tmpdir(), `fsmcp-${randomUUID().slice(0, 8)}-`)
  );

  const taskStore = createTaskStore();

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
    }
  );

  const resourceStore = createInMemoryResourceStore();
  const pathGuard = new PathGuard(SENSITIVE_FILE_DENYLIST);
  const state = await resolveAllowedDirectoriesState([tmpDir]);
  pathGuard.initialize(state);
  setDefaultPathGuard(pathGuard);
  registerAllTools(server, {
    pathGuard,
    resourceStore,
    isInitialized: () => true,
    hasTaskSupport: true,
  });

  // Client advertises elicitation capability so the server will call elicitInput
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } }
  );

  // Register the elicitation handler for server→client elicitation/create requests.
  client.setRequestHandler('elicitation/create', (request) =>
    handler(
      request.params as {
        mode: string;
        message: string;
        requestedSchema: unknown;
      }
    )
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

  return { client, tmpDir, cleanup };
}

/**
 * Assert that a tool call returned an MCP-level error result.
 * Optionally verifies the error code from "CODE: …" format.
 */
export function assertToolError(result: unknown, expectedCode?: string): void {
  const r = result as ToolResult;
  assert.equal(r.isError, true, 'Expected isError to be true');
  const textBlock = r.content.find(
    (b): b is { type: string; text: string } => typeof b.text === 'string'
  );
  assert.ok(textBlock, 'Error result must have a text block');
  if (expectedCode !== undefined) {
    const match = /^([A-Z][A-Z_]+):/.exec(textBlock.text);
    assert.ok(
      match,
      `Expected "${expectedCode}: …" pattern in:\n${textBlock.text}`
    );
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
      (b): b is { type: string; text: string } => typeof b.text === 'string'
    );
    assert.fail(
      `Expected success, got error: ${textBlock?.text ?? 'unknown error'}`
    );
  }
  assert.ok(
    r.content.length > 0,
    'Result must have at least one content block'
  );
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
    'structuredContent must be present on success results'
  );
  return sc as Record<string, unknown>;
}
