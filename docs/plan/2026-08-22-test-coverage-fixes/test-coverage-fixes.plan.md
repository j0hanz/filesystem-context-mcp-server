# Plan: Close test-suite gaps from the `__tests__` analysis

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `4ebc284`, 2026-08-22.
> **Drift check (run first)**: `git diff --stat 4ebc284..HEAD -- src/core/schema.ts src/tools/move.ts __tests__/helpers.ts __tests__/tools.test.ts __tests__/http-policy.test.ts __tests__/stdio.test.ts`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

The `__tests__` analysis found six gaps: two Major (no end-to-end HTTP auth
coverage, no stdio coverage) and four Minor (magic error code, AJV `unknown
format` stderr noise on every server start, a spurious `move` warning on a
normal rename, and an undocumented helper asymmetry). Each ships cosmetic noise
or leaves a transport/auth seam untested. This plan closes all six with the
smallest source changes and the fewest new tests that actually cover the
untested code. Requirements covered: none, this is a fix.

## Current state

The facts, inlined — every excerpt readable without opening another document:

- [`src/core/schema.ts:15-19`](../../../../src/core/schema.ts#L15-L19) — `Sha256Hex`
  uses `z.hash('sha256')`, which zod serializes to JSON-Schema as
  `format: "sha256_hex"`. The SDK's AJV validator does not know that format and
  warns at server start.

  ```ts
  export const Sha256Hex = z.hash('sha256').meta({
    id: 'Sha256Hex',
    title: 'SHA-256 Hash',
    description: 'SHA-256 digest as a 64-character lowercase hex string',
  });
  ```

- [`src/core/schema.ts:446-458`](../../../../src/core/schema.ts#L446-L458) —
  `CursorSchema` and `NextCursorSchema` use `z.base64url()`, which serializes as
  `format: "base64url"`; AJV does not know `base64url` either (it knows `base64`,
  not `base64url`) and warns.

  ```ts
  export const CursorSchema = z
    .base64url()
    .optional()
    .describe(
      'Opaque pagination cursor from a prior response; pass unchanged to fetch the next page. ' +
        'list cursors expire after ~5 min or server restart; find_files cursors re-run the full query per page, ' +
        'so matches may shift (duplicate or skip) if files change between page requests.',
    );

  export const NextCursorSchema = z
    .base64url()
    .optional()
    .describe('Cursor for the next page; omitted when this is the final page.');
  ```

  Emitter confirmed: the warning text `unknown format "${schema}" ignored in
schema` comes from `node_modules/@modelcontextprotocol/server/dist/ajvProvider-CEoC__sr.mjs:5452`
  (AJV inside the SDK). The SDK owns that validator instance; the formats cannot
  be registered from this codebase. The only root-cause fix is to stop emitting
  the unknown `format` keywords by replacing them with `pattern` (regex), which
  AJV does not warn about.

- [`src/tools/move.ts:156-166`](../../../../src/tools/move.ts#L156-L166) — phase-1
  dest stat. The guarded `fs.stat` wraps `ENOENT` as `FsError(NOT_FOUND)`, so
  `isNodeError(err)` is true (an `FsError` is an `Error` with a string `.code`)
  but `err.code !== 'ENOENT'` is also true → the "unexpected" warning fires on
  every normal rename whose destination does not yet exist.

  ```ts
  let destExistedOriginally = false;
  if (!isCaseOnlyRename) {
    try {
      await fs.stat(validDest);
      destExistedOriginally = true;
    } catch (err) {
      if (isNodeError(err) && err.code !== 'ENOENT') {
        Logger.warn(`move: dest stat failed unexpectedly for "${validDest}": ${String(err)}`);
      }
    }
  }
  ```

- [`src/tools/move.ts:202-212`](../../../../src/tools/move.ts#L202-L212) — phase-2
  TOCTOU stat, the same misclassification:

  ```ts
  let existsNow = false;
  if (!plan.isCaseOnlyRename) {
    try {
      await ctx.fs.stat(plan.validDest);
      existsNow = true;
    } catch (err) {
      if (isNodeError(err) && err.code !== 'ENOENT') {
        Logger.warn(`move: dest stat failed unexpectedly for "${plan.validDest}": ${String(err)}`);
      }
    }
  }
  ```

  `isFsError`, `ErrorCode`, `isNodeError` are already imported in
  [`src/tools/move.ts:9-16`](../../../../src/tools/move.ts#L9-L16). The move logic
  itself is correct (`destExistedOriginally`/`existsNow` only go true on a
  succeeding stat); only the warning is spurious.

- [`__tests__/tools.test.ts:91-106`](../../../../__tests__/tools.test.ts#L91-L106) —
  the read-only reject asserts the literal `-32602`:

  ```ts
  await assert.rejects(
    async () => {
      await readOnlyHarness.client.callTool({
        name: 'create',
        arguments: { files: [{ path: join(tmpDir, 'fail.txt'), content: 'fail' }] },
      });
    },
    (err: unknown) => {
      return (
        typeof err === 'object' &&
        err !== null &&
        'code' in err &&
        (err as { code: number }).code === -32602
      );
    },
  );
  ```

  `ProtocolErrorCode` (a numeric enum; `InvalidParams === -32602`) is exported
  from `@modelcontextprotocol/server` and already used as a value in
  [`src/transport.ts:27`](../../../../src/transport.ts#L27).

- [`src/http-policy.ts:228-262`](../../../../src/http-policy.ts#L228-L262) —
  `bearerAuthMiddleware` is exported but never tested. With no key it calls
  `next()`; with a secure key and a matching `Bearer` it calls `next()`;
  otherwise it writes a `401` JSON-RPC body and a `WWW-Authenticate` header.

  ```ts
  export function bearerAuthMiddleware(
    apiKey: string | undefined,
    hostValidated: boolean,
  ): RequestHandler {
    return (req: Request, res: Response, next: NextFunction): void => {
      if (!apiKey) {
        next();
        return;
      }
      if (
        isSecureApiKey(apiKey) &&
        validateBearerAuthorization(apiKey, req.headers.authorization)
      ) {
        next();
        return;
      }
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': buildAuthChallenge(
          req,
          req.headers.authorization !== undefined,
          hostValidated,
        ),
      });
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          id: null,
          error: { code: -32000, message: 'Unauthorized' },
        }),
      );
    };
  }
  ```

  `isSecureApiKey` is not exported; it requires the key be ≥16 chars (the
  existing `http-policy.test.ts` uses `secureKey = 'secure-key-16-characters-long'`
  for this). `validateBearerAuthorization` is already tested at
  [`__tests__/http-policy.test.ts:85-170`](../../../../__tests__/http-policy.test.ts#L85-L170);
  the middleware wrapper that turns its boolean into a 401 response is not.

- [`__tests__/http-policy.test.ts:33-82`](../../../../__tests__/http-policy.test.ts#L33-L82) —
  the existing `createMockRequest` / `createMockResponse` helpers. The new
  middleware tests reuse them verbatim (same pattern as the
  `corsPreflightHandler` tests at
  [`__tests__/http-policy.test.ts:319-378`](../../../../__tests__/http-policy.test.ts#L319-L378)).
  `bearerAuthMiddleware` is NOT in the current import list at
  [`__tests__/http-policy.test.ts:7-20`](../../../../__tests__/http-policy.test.ts#L7-L20).

- [`__tests__/helpers.ts:46-70`](../../../../__tests__/helpers.ts#L46-L70) —
  `createTestClientPair` arms the synchronizer with `registerHandlers` (the
  legacy/push-roots era).
- [`__tests__/helpers.ts:78-124`](../../../../__tests__/helpers.ts#L78-L124) —
  `createTestHttpHarness` arms it with `markInitialized` (the modern per-request
  era). The asymmetry is intentional and mirrors
  [`src/transport.ts:194-208`](../../../../src/transport.ts#L194-L208) (legacy
  `registerHandlers` vs modern `markInitialized`); it is currently undocumented,
  so a future test author can miswire it.

- Stdio transport: the server entry is
  [`src/index.ts:159-167`](../../../../src/index.ts#L159-L167) — with no `--port`,
  `startServer({ cliAllowedDirs: allowedDirs, ... })` serves stdio, and the
  allowed dirs are positional CLI args (see
  [`src/cli.ts:366-432`](../../../../src/cli.ts#L366-L432)). Startup messages go
  to `console.error` (stderr), never stdout, so the JSON-RPC stream is clean.
  `StdioClientTransport` is exported from the **subpath**
  `@modelcontextprotocol/client/stdio` (confirmed: the package root does NOT
  re-export it; `import('@modelcontextprotocol/client/stdio').StdioClientTransport`
  is a function).

## Commands

| Purpose         | Command                                                                                                            | Expected on success     |
| --------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------- |
| Typecheck       | `npx tsc -p tsconfig.json --noEmit`                                                                                | exit 0, no errors       |
| Tests           | `node --test --import tsx "__tests__/**/*.test.ts"`                                                                | all pass, exit 0        |
| Noise check     | `node --test --import tsx "__tests__/**/*.test.ts" 2>&1 \| grep -q "unknown format" && echo FOUND \|\| echo CLEAN` | prints `CLEAN`          |
| Full validation | `node scripts/tasks.mjs`                                                                                           | exit 0 (static + tests) |

All commands are bash (Git Bash / the project's POSIX shell). The test command
is the one in `package.json` `scripts.test` and is verified to pass today
(91 tests, ~1.1s).

## Scope

**In scope** — the only files to modify:

- [`src/core/schema.ts`](../../../../src/core/schema.ts) — replace `z.hash('sha256')` and `z.base64url()` with regex strings.
- [`src/tools/move.ts`](../../../../src/tools/move.ts) — treat `FsError(NOT_FOUND)` as expected-missing in both dest-stat blocks.
- [`__tests__/tools.test.ts`](../../../../__tests__/tools.test.ts) — replace the `-32602` literal with `ProtocolErrorCode.InvalidParams`.
- [`__tests__/helpers.ts`](../../../../__tests__/helpers.ts) — add `createStdioClient` helper; add two era-mirror comments.
- [`__tests__/stdio.test.ts`](../../../../__tests__/stdio.test.ts) — new file, two stdio tests.
- [`__tests__/http-policy.test.ts`](../../../../__tests__/http-policy.test.ts) — import `bearerAuthMiddleware`, add three middleware tests.

**Files out of scope** — leave alone even though they look related:

- [`src/transport.ts`](../../../../src/transport.ts) — the Express wiring that mounts `bearerAuthMiddleware` before the modern handler. The middleware is now tested directly; full real-port transport integration is deferred (see Notes), so no change here.
- [`src/http-policy.ts`](../../../../src/http-policy.ts) — already exports `bearerAuthMiddleware`; no source change needed to test it.
- [`src/server.ts`](../../../../src/server.ts) — `createServer` intentionally leaves synchronizer arming to the caller (era-dependent); the helper asymmetry mirrors this and is fixed by a comment, not a refactor.
- `package.json` — no new deps. `StdioClientTransport` is already in `@modelcontextprotocol/client` (devDep).

## Steps

### 1. Silence AJV `unknown format` warnings in `schema.ts`

Replace the three format-emitting definitions with `pattern`-emitting regex
strings. The inferred TS type stays `string`, so callers are unaffected.

In [`src/core/schema.ts:15-19`](../../../../src/core/schema.ts#L15-L19), replace
the `Sha256Hex` definition:

```ts
// pattern (not z.hash('sha256')) so no `format: "sha256_hex"` keyword is emitted;
// the SDK's AJV validator warns on that unknown format at every server start.
export const Sha256Hex = z
  .string()
  .regex(/^[0-9a-f]{64}$/)
  .meta({
    id: 'Sha256Hex',
    title: 'SHA-256 Hash',
    description: 'SHA-256 digest as a 64-character lowercase hex string',
  });
```

In [`src/core/schema.ts:446-458`](../../../../src/core/schema.ts#L446-L458),
replace `z.base64url()` with a base64url-alphabet regex in both
`CursorSchema` and `NextCursorSchema`. Keep the `.optional()` and the existing
`.describe(...)` text unchanged. The cursor is opaque; the server re-decodes and
re-validates it in [`src/core/cursor.ts`](../../../../src/core/cursor.ts), so a
charset regex is sufficient client-side (the real check is the server decode).

```ts
// ponytail: charset regex, not z.base64url() — the SDK's AJV warns on the
// unknown `base64url` format; the server's own decode (cursor.ts) is the real
// validation, so loosening the client-facing schema to the alphabet is safe.
const base64urlCursor = z.string().regex(/^[A-Za-z0-9_-]+$/);

export const CursorSchema = base64urlCursor
  .optional()
  .describe(
    'Opaque pagination cursor from a prior response; pass unchanged to fetch the next page. ' +
      'list cursors expire after ~5 min or server restart; find_files cursors re-run the full query per page, ' +
      'so matches may shift (duplicate or skip) if files change between page requests.',
  );

export const NextCursorSchema = base64urlCursor
  .optional()
  .describe('Cursor for the next page; omitted when this is the final page.');
```

**Verify**:

- `npx tsc -p tsconfig.json --noEmit` → exit 0
- `node --test --import tsx "__tests__/**/*.test.ts"` → all pass, exit 0
- `node --test --import tsx "__tests__/**/*.test.ts" 2>&1 | grep -q "unknown format" && echo FOUND || echo CLEAN` → prints `CLEAN`

### 2. Stop the spurious `move` warning on a normal rename

In [`src/tools/move.ts:161-164`](../../../../src/tools/move.ts#L161-L164), change
the `catch` so a guarded `FsError(NOT_FOUND)` is treated as expected-missing
(same as a raw `ENOENT`):

```ts
    } catch (err) {
      const missing =
        (isNodeError(err) && err.code === 'ENOENT') ||
        (isFsError(err) && err.code === ErrorCode.NOT_FOUND);
      if (!missing) {
        Logger.warn(`move: dest stat failed unexpectedly for "${validDest}": ${String(err)}`);
      }
    }
```

Apply the identical change to the phase-2 block at
[`src/tools/move.ts:207-210`](../../../../src/tools/move.ts#L207-L210) (use
`plan.validDest` in the message, as it does today). `isFsError`, `ErrorCode`,
and `isNodeError` are already imported — add no imports.

**Verify**:

- `npx tsc -p tsconfig.json --noEmit` → exit 0
- `node --test --import tsx "__tests__/**/*.test.ts"` → all pass, exit 0
- `node --test --import tsx "__tests__/**/*.test.ts" 2>&1 | grep -q "dest stat failed unexpectedly" && echo FOUND || echo CLEAN` → prints `CLEAN` (TC-FUNC-021 performs a normal rename and no longer logs the warning)

### 3. Replace the magic `-32602` in `tools.test.ts`

In [`__tests__/tools.test.ts`](../../../../__tests__/tools.test.ts), add the
import at the top (after the existing `node:test` import block):

```ts
import { ProtocolErrorCode } from '@modelcontextprotocol/server';
```

Then at [`__tests__/tools.test.ts:103`](../../../../__tests__/tools.test.ts#L103)
change `(err as { code: number }).code === -32602` to
`(err as { code: number }).code === ProtocolErrorCode.InvalidParams`. The enum
member equals `-32602`, so the test stays green; the magic number is gone.

**Verify**: `node --test --import tsx "__tests__/**/*.test.ts"` → all pass, exit 0 (TC-FUNC-012 still passes).

### 4. Add `createStdioClient` helper and document the helper asymmetry

In [`__tests__/helpers.ts`](../../../../__tests__/helpers.ts):

1. Add to the existing `@modelcontextprotocol/client` imports (currently
   [`__tests__/helpers.ts:1-3`](../../../../__tests__/helpers.ts#L1-L3)) the
   subpath import on its own line:

   ```ts
   import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
   ```

2. Add `fileURLToPath` to the `node:url` import (helpers does not import `node:url`
   yet) — add a new line:

   ```ts
   import { fileURLToPath } from 'node:url';
   ```

3. Add the `TestStdioContext` interface and `createStdioClient` factory after
   `createTestHttpHarness` (after
   [`__tests__/helpers.ts:124`](../../../../__tests__/helpers.ts#L124)):

   ```ts
   export interface TestStdioContext {
     client: Client;
     close: () => Promise<void>;
   }

   /**
    * Spawn the real stdio server (via tsx, no build step) and connect a client.
    * stdio has no in-process shortcut — the only honest coverage spawns a real
    * process, mirroring `node --import tsx src/index.ts <allowedDir>`.
    */
   export async function createStdioClient(allowedDir: string): Promise<TestStdioContext> {
     const repoRoot = fileURLToPath(new URL('..', import.meta.url));
     const transport = new StdioClientTransport({
       command: process.execPath,
       args: ['--import', 'tsx', 'src/index.ts', allowedDir],
       cwd: repoRoot,
     });
     const client = new Client(
       { name: 'stdio-test-harness', version: '1.0.0' },
       { versionNegotiation: { mode: 'auto' } },
     );
     await client.connect(transport);
     return {
       client,
       close: async () => {
         await client.close();
         await transport.close();
       },
     };
   }
   ```

4. Document the era asymmetry. In `createTestClientPair` at
   [`__tests__/helpers.ts:52`](../../../../__tests__/helpers.ts#L52), add a
   one-line comment above `serverCtx.synchronizer.registerHandlers(...)`:

   ```ts
   // Mirrors the legacy stdio era: push-style roots via registerHandlers.
   ```

   In `createTestHttpHarness` at
   [`__tests__/helpers.ts:98`](../../../../__tests__/helpers.ts#L98), add above
   `serverCtx.synchronizer.markInitialized();`:

   ```ts
   // Mirrors the modern per-request era: roots from config, no push handlers.
   ```

**Verify**: `npx tsc -p tsconfig.json --noEmit` → exit 0.

### 5. Add the stdio transport tests

Create [`__tests__/stdio.test.ts`](../../../../__tests__/stdio.test.ts):

```ts
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { ALL_REGISTERED_TOOL_NAMES } from '../src/tools/index.js';
import {
  cleanupTestRoot,
  createStdioClient,
  createTestRoot,
  firstTextBlock,
  writeTestFile,
} from './helpers.js';

describe('Stdio Transport (real subprocess)', () => {
  let tmpDir: string;
  let harness: Awaited<ReturnType<typeof createStdioClient>>;

  before(async () => {
    tmpDir = await createTestRoot();
    harness = await createStdioClient(tmpDir);
  });

  after(async () => {
    if (harness) await harness.close();
    if (tmpDir) await cleanupTestRoot(tmpDir);
  });

  it('STDIO-001: lists all tools over a real stdio subprocess', async () => {
    const tools = await harness.client.listTools();
    assert.strictEqual(tools.tools.length, ALL_REGISTERED_TOOL_NAMES.length);
  });

  it('STDIO-002: reads a file over a real stdio subprocess', async () => {
    const filePath = await writeTestFile(tmpDir, 'stdio.txt', 'stdio content');
    const result = await harness.client.callTool({
      name: 'read',
      arguments: { path: filePath },
    });
    assert.notStrictEqual(result.isError, true);
    assert.ok(firstTextBlock(result).text?.includes('stdio content'));
  });
});
```

**Verify**: `node --test --import tsx "__tests__/**/*.test.ts"` → all pass, exit 0, including the two new `STDIO-*` tests (suite count rises from 91 to 93). The subprocess spawn adds ~1–2s; a connect timeout means a STOP, not a failure.

### 6. Add `bearerAuthMiddleware` tests

In [`__tests__/http-policy.test.ts`](../../../../__tests__/http-policy.test.ts):

1. Add `bearerAuthMiddleware` to the import from `../src/http-policy.js` at
   [`__tests__/http-policy.test.ts:7-20`](../../../../__tests__/http-policy.test.ts#L7-L20).
2. Add a new `describe` block (reuse the existing `createMockRequest` /
   `createMockResponse` and the `secureKey = 'secure-key-16-characters-long'`
   convention from
   [`__tests__/http-policy.test.ts:173`](../../../../__tests__/http-policy.test.ts#L173))
   after the `validateBearerAuthorization` block:

   ```ts
   describe('bearerAuthMiddleware (TC-SEC-038 - TC-SEC-040)', () => {
     const secureKey = 'secure-key-16-characters-long';

     it('TC-SEC-038: calls next() when no API key is configured', () => {
       const mw = bearerAuthMiddleware(undefined, false);
       const req = createMockRequest();
       const res = createMockResponse();
       let nextCalled = false;
       mw(req, res, () => {
         nextCalled = true;
       });
       assert.strictEqual(nextCalled, true);
       assert.strictEqual(res.statusCode, undefined);
     });

     it('TC-SEC-039: calls next() for a matching Bearer token, 401 otherwise', () => {
       const mw = bearerAuthMiddleware(secureKey, false);

       // Matching bearer -> next()
       const okReq = createMockRequest({ headers: { authorization: `Bearer ${secureKey}` } });
       const okRes = createMockResponse();
       let okNext = false;
       mw(okReq, okRes, () => {
         okNext = true;
       });
       assert.strictEqual(okNext, true);
       assert.strictEqual(okRes.statusCode, undefined);

       // Wrong bearer -> 401 JSON-RPC error
       const badReq = createMockRequest({
         headers: { authorization: 'Bearer wrong-key-here-123456' },
       });
       const badRes = createMockResponse();
       let badNext = false;
       mw(badReq, badRes, () => {
         badNext = true;
       });
       assert.strictEqual(badNext, false);
       assert.strictEqual(badRes.statusCode, 401);
       assert.strictEqual(badRes.headers['content-type'], 'application/json');
       assert.ok(badRes.headers['www-authenticate'], 'WWW-Authenticate header should be present');
       const body = JSON.parse(badRes.body ?? '{}');
       assert.strictEqual(body.jsonrpc, '2.0');
       assert.strictEqual(body.error.code, -32000);
     });

     it('TC-SEC-040: returns 401 when the Authorization header is missing', () => {
       const mw = bearerAuthMiddleware(secureKey, false);
       const req = createMockRequest({ headers: {} });
       const res = createMockResponse();
       let nextCalled = false;
       mw(req, res, () => {
         nextCalled = true;
       });
       assert.strictEqual(nextCalled, false);
       assert.strictEqual(res.statusCode, 401);
       assert.ok(res.headers['www-authenticate']);
     });
   });
   ```

**Verify**: `node --test --import tsx "__tests__/**/*.test.ts"` → all pass, exit 0, including the three new `TC-SEC-038..040` tests (suite count rises to 96).

## Done

Machine-checkable. All must hold:

- [ ] `npx tsc -p tsconfig.json --noEmit` exits 0
- [ ] `node --test --import tsx "__tests__/**/*.test.ts"` exits 0, with 96 tests (91 + 2 stdio + 3 middleware)
- [ ] `node --test --import tsx "__tests__/**/*.test.ts" 2>&1 | grep -q "unknown format" && echo FOUND || echo CLEAN` prints `CLEAN`
- [ ] `node --test --import tsx "__tests__/**/*.test.ts" 2>&1 | grep -q "dest stat failed unexpectedly" && echo FOUND || echo CLEAN` prints `CLEAN`
- [ ] `node scripts/tasks.mjs` exits 0
- [ ] `git status` shows changes only in the six in-scope files (one new: `__tests__/stdio.test.ts`)

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt — the SDK may have shifted.
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation.
- The fix appears to require an out-of-scope file.
- `StdioClientTransport` is not exported from `@modelcontextprotocol/client/stdio`
  (the plan rests on this subpath export, verified at `4ebc284`).
- The stdio subprocess does not connect within ~10s — likely stdout pollution
  from a startup path, which breaks JSON-RPC (the skill's #1 stdio gotcha); report
  the subprocess's stdout/stderr rather than retrying.
- `ProtocolErrorCode.InvalidParams` is not `-32602` — the enum would have moved;
  keep the literal and report.

## Notes

- **What a reviewer should scrutinize.** Step 1 changes the _public_ JSON-Schema
  keyword for `Sha256Hex`, `CursorSchema`, and `NextCursorSchema` from `format`
  to `pattern`. Clients that programmatically keyed off `format: "base64url"`
  will see `pattern` instead. The validation semantics for callers are
  equivalent-or-looser (charset regex), and the server re-validates cursors on
  decode, so this is safe — but it is a visible schema-surface change, not
  purely internal.
- **Deferred (out of scope).** A real-port HTTP integration test that connects a
  `StreamableHTTPClientTransport` to a live `startHttpServer` with `API_KEY` set
  and asserts `SdkHttpError.status === 401` / `429` end-to-end. It is the
  strongest form of the HTTP-auth finding, but it opens an ephemeral network
  port (the skill's test guidance keeps standard runs port-free) and is
  flakier/slower. Step 6 covers the actual untested code — the
  `bearerAuthMiddleware` response shape — at the unit level, which is the
  ponytail call. Add the real-port test when a flaky-test budget allows.
- **Rollback.** No migrations, deletions, or production data. Rollback is
  `git revert` of the commit; no separate commands.
- The helper asymmetry (Step 4 comments) is intentional and mirrors the
  era-branch in `src/transport.ts`; the comments document it, they do not change
  behavior.
