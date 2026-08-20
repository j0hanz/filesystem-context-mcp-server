/**
 * The 2026-07-28 protocol era removed push-style server->client requests, so
 * `ctx.mcpReq.elicitInput` throws locally — before anything reaches the client
 * — with SdkErrorCode.MethodNotSupportedByProtocolVersion. Tools that ask for
 * confirmation must read that as "this connection cannot be asked", the same
 * as a client that never advertised the capability, and NOT as a user saying
 * no. The wire-level handler cannot simulate this (the throw never leaves the
 * server), so these drive the registered handler directly.
 */
import type { McpServer, ServerContext } from '@modelcontextprotocol/server';
import { SdkError, SdkErrorCode } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { PathGuard, resolveAllowedDirectoriesState } from '../../src/core/path.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';
import type { DefinedTool } from '../../src/tools/define.js';
import { DELETE_FILE } from '../../src/tools/delete-file.js';
import { MOVE } from '../../src/tools/move.js';

type CapturedHandler = (args: unknown, ctx: ServerContext) => Promise<unknown>;

/**
 * Register `tool` against a stub server and return its call handler. Arguments
 * are parsed through the tool's own input schema first — the SDK does that in
 * production, so a stub that skipped it would hand handlers unparsed args
 * missing every schema default.
 */
async function registerAgainstStub(tool: DefinedTool, root: string): Promise<CapturedHandler> {
  let handler: CapturedHandler | undefined;
  let registeredSchema: RegisteredShape | undefined;
  const mockServer = {
    registerTool: (_name: string, schema: unknown, h: unknown): void => {
      registeredSchema = schema as RegisteredShape;
      handler = h as CapturedHandler;
    },
  } as unknown as McpServer;

  const pathGuard = new PathGuard();
  pathGuard.initialize(await resolveAllowedDirectoriesState([root]));

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

/** The shape `defineTool` hands to `registerTool` — the same object production uses. */
interface RegisteredShape {
  inputSchema: {
    '~standard': { validate: (value: unknown) => unknown };
  };
}

/** A ServerContext whose elicitInput fails the way the 2026-07-28 era does. */
function eraContext(): ServerContext {
  return {
    mcpReq: {
      signal: new AbortController().signal,
      notify: async () => undefined,
      log: async () => undefined,
      elicitInput: () =>
        Promise.reject(
          new SdkError(
            SdkErrorCode.MethodNotSupportedByProtocolVersion,
            "Server-to-client requests are not available on protocol revision 2026-07-28: 'elicitation/create' cannot be sent",
          ),
        ),
    },
  } as unknown as ServerContext;
}

describe('elicitation on a 2026-07-28 connection', () => {
  it('delete: removes a non-empty directory instead of reporting it cancelled', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-era-delete-'));
    try {
      const dir = join(tmp, 'to-delete');
      await mkdir(dir);
      await writeFile(join(dir, 'file.txt'), 'content', 'utf8');

      const handler = await registerAgainstStub(DELETE_FILE, tmp);
      const raw = await handler({ paths: [dir], recursive: true }, eraContext());

      const result = raw as {
        isError?: boolean;
        structuredContent?: { ok?: unknown; failures?: { error?: { code?: unknown } }[] };
      };
      assert.notEqual(result.isError, true);
      assert.equal(result.structuredContent?.ok, true);
      assert.equal(result.structuredContent?.failures, undefined);
      await assert.rejects(readFile(join(dir, 'file.txt')), { code: 'ENOENT' });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it('move: overwrites an existing destination instead of failing CANCELLED', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'fsmcp-era-move-'));
    try {
      const source = join(tmp, 'src.txt');
      const destination = join(tmp, 'dest.txt');
      await writeFile(source, 'source content', 'utf8');
      await writeFile(destination, 'original dest', 'utf8');

      const handler = await registerAgainstStub(MOVE, tmp);
      const raw = await handler({ moves: [{ source, destination }] }, eraContext());

      const result = raw as { isError?: boolean };
      assert.notEqual(result.isError, true);
      assert.equal(await readFile(destination, 'utf8'), 'source content');
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
