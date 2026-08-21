import { Client } from '@modelcontextprotocol/client';
import type { ElicitResult } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';
import type { ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PathGuard, resolveAllowedDirectoriesState } from '../src/core/path.js';
import { createInMemoryResourceStore, type ResourceStore } from '../src/core/store.js';
import type { DefinedTool } from '../src/tools/define.js';
import { ALL_TOOLS } from '../src/tools/index.js';
import { type PendingState, requestStateCodec } from '../src/tools/input-required.js';

/**
 * The tool inventory as a human declares it, independent of what `src/` derives.
 * Deliberately literal: tests use these to check the derivation, so deriving
 * them from the same annotations would make those assertions tautological.
 */
export const ORACLE_ALL_TOOL_NAMES = [
  'create',
  'delete',
  'edit',
  'find_files',
  'hash_file',
  'list',
  'list_roots',
  'move',
  'read',
  'replace_text',
  'search_text',
  'stat',
] as const;

export const ORACLE_MUTATING_TOOL_NAMES = [
  'create',
  'delete',
  'edit',
  'move',
  'replace_text',
] as const;

export const ORACLE_READ_ONLY_TOOL_NAMES = [
  'find_files',
  'hash_file',
  'list',
  'list_roots',
  'read',
  'search_text',
  'stat',
] as const;

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

  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
        completions: {},
      },
    },
  );

  const resourceStore = createInMemoryResourceStore();
  const pathGuard = new PathGuard();
  await pathGuard.setRoots([tmpDir]);
  const deps = {
    server,
    pathGuard,
    resourceStore,
    isInitialized: () => true,
  };
  for (const tool of ALL_TOOLS) {
    tool.register(deps);
  }

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  const cleanup = async (): Promise<void> => {
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

  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    {
      capabilities: {
        tools: {},
        resources: {},
        prompts: {},
        logging: {},
        completions: {},
      },
    },
  );

  const resourceStore = createInMemoryResourceStore();
  const pathGuard = new PathGuard();
  await pathGuard.setRoots([tmpDir]);
  const deps2 = {
    server,
    pathGuard,
    resourceStore,
    isInitialized: () => true,
  };
  for (const tool of ALL_TOOLS) {
    tool.register(deps2);
  }

  // Client advertises elicitation capability so the server will call elicitInput
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: { elicitation: {} } },
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

  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  const cleanup = async (): Promise<void> => {
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
 * Over the legacy-era wire harness (no elicitation capability), an out-of-root
 * call returns input_required and the SDK legacy shim fail-closes: isError:true
 * with the missing-capability message (R6 — nothing on disk is touched). Asserts
 * that fail-close shape. Not a raw input_required — see the plan's era constraint.
 */
export function assertInputRequiredFailClose(result: unknown): void {
  const raw = result as { isError?: boolean; content?: { text?: string }[] };
  assert.equal(
    raw.isError,
    true,
    'out-of-root call must fail-closed (isError) on the legacy-era harness',
  );
  const text = raw.content?.[0]?.text ?? '';
  assert.ok(
    text.includes('did not declare the required capability'),
    `expected legacy-era fail-close message, got: ${text}`,
  );
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

// ── direct-handler round-trip stub harness (SEP-2577 input_required) ─────────

/** The codec is created without a `bind` callback, so `verify` ignores its ctx. */
export const NO_CTX = undefined as unknown as ServerContext;

export type CapturedHandler = (args: unknown, ctx: ServerContext) => Promise<unknown>;

export interface RegisteredShape {
  inputSchema: { '~standard': { validate: (value: unknown) => unknown } };
}

/**
 * Register `tool` against a stub server with `root` as the only allowed
 * directory, and return its call handler. Args are parsed through the tool's
 * own input schema first — the SDK does that in production. The PathGuard is
 * captured at registration and persists across calls, so an accepted grant
 * (applyGrant) mutates the same instance the next call pre-checks against.
 * `init` seeds the PathGuard's roots; defaults to `initialize` (skips
 * ROOT_BOUNDARY resolution) — pass `(pg, root) => pg.setRoots([root])` when a
 * test needs ROOT_BOUNDARY resolved into `rootBoundaries`.
 */
export async function registerAgainstStub(
  tool: DefinedTool,
  root: string,
  init: (pathGuard: PathGuard, root: string) => Promise<void> = async (pathGuard, r) =>
    pathGuard.initialize(await resolveAllowedDirectoriesState([r])),
): Promise<CapturedHandler> {
  let handler: CapturedHandler | undefined;
  let registeredSchema: RegisteredShape | undefined;
  const mockServer = {
    registerTool: (_name: string, schema: unknown, h: unknown): void => {
      registeredSchema = schema as RegisteredShape;
      handler = h as CapturedHandler;
    },
  } as unknown as McpServer;

  const pathGuard = new PathGuard();
  await init(pathGuard, root);

  tool.register({
    server: mockServer,
    pathGuard,
    resourceStore: createInMemoryResourceStore(),
    isInitialized: () => true,
  });

  const registered = handler;
  const validate = registeredSchema?.inputSchema['~standard'].validate;
  assert.ok(registered, `Expected ${tool.name} to register a handler`);
  assert.ok(validate, `Expected ${tool.name} to register a validating input schema`);
  return (args, ctx) => {
    const parsed = validate(args) as { value?: unknown; issues?: readonly unknown[] };
    assert.ok(!parsed.issues, `Expected ${tool.name} args to validate`);
    return registered(parsed.value, ctx);
  };
}

export interface RetryCtxOpts {
  responses?: Record<string, unknown>;
  state?: PendingState;
}

/** A ServerContext carrying the retry round's `inputResponses` and verified state. */
export function retryCtx(opts: RetryCtxOpts = {}): ServerContext {
  return {
    mcpReq: {
      signal: new AbortController().signal,
      notify: async () => undefined,
      log: async () => undefined,
      inputResponses: opts.responses,
      requestState: () => opts.state,
    },
  } as unknown as ServerContext;
}

/** Verify the round-1 `input_required` result's requestState into the retried state. */
export async function retryState(round1: unknown): Promise<PendingState> {
  const r = round1 as { requestState?: string };
  assert.ok(typeof r.requestState === 'string', 'round 1 must mint a requestState');
  return await requestStateCodec.verify(r.requestState, NO_CTX);
}

/** A single-item accepted response for `confirm_0`. */
export function accept(confirm = true): Record<string, unknown> {
  return { confirm_0: { action: 'accept', content: { confirm } } };
}
