import type { McpServer, ServerContext } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';

import { PathGuard, resolveAllowedDirectoriesState } from '../../src/core/path.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';
import type { DefinedTool } from '../../src/tools/define.js';
import { type PendingState, requestStateCodec } from '../../src/tools/input-required.js';

export const NO_CTX = undefined as unknown as ServerContext;

export type CapturedHandler = (args: unknown, ctx: ServerContext) => Promise<unknown>;

export interface RegisteredShape {
  inputSchema: { '~standard': { validate: (value: unknown) => unknown } };
}

/**
 * Registers a tool against a stub server instance, captures its registered handler
 * and validates arguments through the tool's Standard Schema validator.
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
    assert.ok(
      !parsed.issues,
      `Expected ${tool.name} args to validate, got: ${JSON.stringify(parsed.issues)}`,
    );
    return registered(parsed.value, ctx);
  };
}

export interface RetryCtxOpts {
  responses?: Record<string, unknown>;
  state?: PendingState;
}

/** Constructs a synthetic ServerContext holding inputResponses and decoded requestState. */
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

/** Verifies and decodes the HMAC requestState from an input_required round-1 result. */
export async function retryState(round1: unknown): Promise<PendingState> {
  const r = round1 as { requestState?: string };
  assert.ok(typeof r.requestState === 'string', 'round 1 must mint a requestState');
  return await requestStateCodec.verify(r.requestState, NO_CTX);
}

/** Synthesizes an accepted confirmation response for confirm_0. */
export function accept(confirm = true): Record<string, unknown> {
  return { confirm_0: { action: 'accept', content: { confirm } } };
}
