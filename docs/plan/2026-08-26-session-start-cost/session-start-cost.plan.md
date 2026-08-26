# Plan: Cut the session-start payload and close the shared-state grant leak

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `528760ea`, 2026-08-26. Working tree was clean.
> **Drift check (run first)**:
> `git diff --stat 528760ea..HEAD -- src/ __tests__/ README.md`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

An MCP client pays 11,829 tokens to this server before its first tool call, and
96% of that is `tools/list` (41,410 characters, 11,352 tokens over
`o200k_base`). Output schemas alone are 6,013 tokens — 53% of the tool list —
on a field the 2026-07-28 spec marks optional. A 60-second `ttlMs` on a tool
list that cannot change tells compliant clients to re-fetch all of it every
minute. Separately, the HTTP leg shares one mutable `PathGuard` across every
caller, so one client's accepted access grant permanently widens the allowed
roots for every other client on the endpoint.

When this lands: `tools/list` is under 18,500 characters (a ~56% cut), cache
hints match the spec's own examples, the advertised capability set matches what
each protocol era actually answers, and access grants and cached results are
scoped to the authorization that produced them.

Requirements covered: none — this is a fix, derived from an architecture audit
of this repository against
`https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture.md` and
`https://modelcontextprotocol.io/specification/2026-07-28/server/tools`.

## Current state

### Measured baseline (reproduce before changing anything)

An in-memory client pair against the current tree yields:

- `readOnly=false` → 13 tools, `JSON.stringify(tools).length === 41410`
- `readOnly=true` → 7 tools, `JSON.stringify(tools).length === 20862`

Per-tool token cost, worst first (`o200k_base`, exact):

| Tool | Total | desc | input | output | annot |
| :--- | ---: | ---: | ---: | ---: | ---: |
| `edit` | 1532 | 86 | 599 | 790 | 29 |
| `replace_text` | 1481 | 69 | 664 | 688 | 29 |
| `read` | 1341 | 51 | 393 | 840 | 29 |
| `search_text` | 1172 | 54 | 507 | 553 | 29 |
| `stat` | 971 | 49 | 157 | 706 | 29 |
| `list` | 840 | 50 | 295 | 439 | 29 |
| `find_files` | 832 | 49 | 386 | 339 | 29 |
| `create` | 733 | 40 | 152 | 475 | 29 |
| `move` | 682 | 86 | 213 | 324 | 29 |
| `delete` | 600 | 76 | 173 | 294 | 29 |
| `patch` | 586 | 69 | 128 | 333 | 29 |
| `diff` | 402 | 32 | 135 | 179 | 29 |
| `list_roots` | 176 | 48 | 16 | 53 | 29 |

### Spec text this plan relies on

The executor has not read these pages. Quoted verbatim:

> `outputSchema`: Optional JSON Schema defining expected output structure

— `specification/2026-07-28/server/tools`, §Data Types → Tool.

> Servers **SHOULD** return tools in a deterministic order (i.e., the same
> ordering across requests when the underlying set of tools has not changed).
> Deterministic ordering enables clients to reliably cache the tool list and
> improves LLM prompt cache hit rates when tools are included in model context.

— same page, §Capabilities.

> The set **MAY** vary by the authorization presented on the request — for
> example, returning only the tools the caller's granted scopes permit — since
> credentials are per-request input, not connection state.

— same page, §Capabilities. This is the sentence Step 14 acts on.

> The client declares its capabilities in
> `io.modelcontextprotocol/clientCapabilities` on every request, and the server
> returns its own `capabilities` object from `server/discover`. This tells each
> party which primitives the other can handle […] so unsupported operations are
> never attempted.

— `docs/2026-07-28/learn/architecture.md`, §Understanding the Discovery
Exchange. This is the sentence Step 3 acts on.

The architecture doc's own worked example uses `"ttlMs": 300000` on
`tools/list` and `"ttlMs": 3600000` on `server/discover`.

### Code as it exists today

[`src/server.ts:104-133`](../../../src/server.ts#L104-L133) — capability set and
cache hints, both era-blind:

```ts
  const capabilities = {
    resources: { subscribe: true, listChanged: true },
    tools: {},
    prompts: {},
    completions: {},
  } satisfies ServerCapabilities;

  const cacheScope = extraDeps?.apiKey ? 'private' : 'public';
  const serverConfig: NonNullable<ConstructorParameters<typeof McpServer>[1]> = {
    capabilities,
    enforceStrictCapabilities: true,
    cacheHints: {
      'tools/list': { ttlMs: 60_000, cacheScope },
      'prompts/list': { ttlMs: 60_000, cacheScope },
      'resources/list': { ttlMs: 30_000, cacheScope: 'private' },
      'resources/templates/list': { ttlMs: 60_000, cacheScope },
      'server/discover': { ttlMs: 60_000, cacheScope },
    },
```

`extraDeps.era` is already threaded into `createServer`
([`src/server.ts:89-90`](../../../src/server.ts#L89-L90)) and passed on to
`registerResources` ([`src/server.ts:182`](../../../src/server.ts#L182)), but
`capabilities` never reads it.

[`src/resources.ts:520-526`](../../../src/resources.ts#L520-L526) — the era gate
that makes the advertised `subscribe: true` false on the modern era:

```ts
  // `resources/subscribe`/`unsubscribe` are 2025-era-only verbs; a modern
  // server answers `-32601 Method not found` for them, so registering these
  // handlers on a modern-era instance would dispatch to code no request can
  // reach.
  if (deps.era !== 'modern') {
```

Confirmed on the wire: a modern `server/discover` returns
`"resources":{"subscribe":true,"listChanged":true}` while
`resources/subscribe` returns `{"code":-32601,"message":"Method not found"}`.

[`src/tools/define.ts:478-491`](../../../src/tools/define.ts#L478-L491) — the
one place the wire copy of every schema is generated:

```ts
function toDraft202012(schema: z.ZodType, io: 'input' | 'output'): JsonSchemaType {
  const generated = z.toJSONSchema(schema, {
    target: 'draft-2020-12',
    io,
    override: ({ jsonSchema }) => {
      const node = jsonSchema as Record<string, unknown>;
      delete node['title'];
      if (node['maximum'] === Number.MAX_SAFE_INTEGER) delete node['maximum'];
      if (io === 'output') delete node['examples'];
    },
  }) as Record<string, unknown>;
  delete generated['$schema'];
  return generated;
}
```

[`src/tools/define.ts:502-508`](../../../src/tools/define.ts#L502-L508) — where
the published shape is assembled, once per tool definition:

```ts
  const toolDefShape = {
    title: def.title,
    description: def.description,
    inputSchema: fromJsonSchema<z.infer<I>>(inputJsonSchema, zodJsonSchemaValidator(def.input)),
    outputSchema: fromJsonSchema<z.infer<O>>(outputJsonSchema, zodJsonSchemaValidator(def.output)),
    annotations: def.annotations,
  };
```

[`src/core/schema.ts:140-172`](../../../src/core/schema.ts#L140-L172) — the
shared schemas whose descriptions restate their own key names:

```ts
export const FileInfoSchema = z.strictObject({
  name: z.string().describe('Name'),
  path: z.string().describe('Absolute path'),
  type: FileType.describe('Type'),
  size: NonNegInt.describe('Size (bytes)'),
  tokenEstimate: NonNegInt.optional().describe('Rough token estimate; use to pre-screen read cost'),
  created: IsoDateTime.describe('Created'),
  modified: IsoDateTime.describe('Modified'),
  accessed: IsoDateTime.describe('Accessed'),
  permissions: z.string().describe('Permissions'),
  isHidden: z.boolean().describe('Hidden?'),
  mimeType: z.string().optional().describe('MIME type'),
  symlinkTarget: z.string().optional().describe('Target (symlink)'),
});

export const OperationSummarySchema = z.strictObject({
  total: NonNegInt.describe('Total'),
  succeeded: NonNegInt.describe('Succeeded'),
  failed: NonNegInt.describe('Failed'),
});

export const PerFileErrorSchema = z.strictObject({
  code: z.string().describe('Error code'),
  message: z.string().describe('Error message'),
  path: z.string().optional().describe('Path involved'),
  suggestion: z.string().optional().describe('Suggested fix'),
});
```

[`src/core/concurrency.ts:6-8`](../../../src/core/concurrency.ts#L6-L8) — the
shared three-value enum:

```ts
export type StoppedReason = 'maxResults' | 'maxFiles' | 'timeout';

export const StoppedReasonSchema = z.enum(['maxResults', 'maxFiles', 'timeout']).optional();
```

Only `replace_text` can produce `maxFiles`.
[`src/core/search.ts:248-251`](../../../src/core/search.ts#L248-L251) and
[`:324-327`](../../../src/core/search.ts#L324-L327) — the code paths behind
`search_text` and `find_files` — call only `hitMaxResults()` and `hitAbort()`,
never `hitMaxFiles()`. Both tools' descriptions already document two values:

- [`src/tools/search-files.ts:65-67`](../../../src/tools/search-files.ts#L65-L67)
- [`src/tools/search-content.ts:140-142`](../../../src/tools/search-content.ts#L140-L142)

Both read:

```ts
  stoppedReason: StoppedReasonSchema.describe(
    'Why the search ended early: maxResults = result cap reached, timeout = time limit hit or the request was cancelled. Absent when the scan ran to completion.',
  ),
```

[`src/tools/edit.ts:31-46`](../../../src/tools/edit.ts#L31-L46) — inlined at two
use sites inside one schema document (~1,341 characters of duplication):

```ts
const EditSpecSchema = z.strictObject({
  oldText: z
    .string()
    .min(1, 'oldText required')
    .refine((val) => !isBlank(val), {
      message: 'oldText cannot be empty or whitespace-only',
    })
    .describe(
      'Exact literal text to locate in the file. Must include 3-5 lines of context to ensure uniqueness and avoid matching the wrong block.',
    )
    .meta({ examples: ['const x = 1;', 'function oldName('] }),
  newText: z
    .string()
    .describe('Replacement text. Use an empty string to delete the matched oldText.')
    .meta({ examples: ['const x = 2;', 'function newName(', ''] }),
});
```

Referenced from `edits` ([`edit.ts:55`](../../../src/tools/edit.ts#L55)) and
again from `files[].edits` ([`edit.ts:65`](../../../src/tools/edit.ts#L65)).

[`src/tools/read.ts:74-86`](../../../src/tools/read.ts#L74-L86) — the published
exclusivity block:

```ts
  .meta({
    oneOf: [{ required: ['path'] }, { required: ['paths'] }],
    not: {
      anyOf: [
        { required: ['head', 'tail'] },
        { required: ['head', 'startLine'] },
        { required: ['head', 'endLine'] },
        { required: ['tail', 'startLine'] },
        { required: ['tail', 'endLine'] },
      ],
    },
    dependentRequired: { endLine: ['startLine'] },
  });
```

The runtime rule it mirrors lives in
[`validateReadRange()`](../../../src/core/schema.ts#L227-L293) and is invoked
from [`read.ts:51-65`](../../../src/tools/read.ts#L51-L65).

[`src/transport/http.ts:294-314`](../../../src/transport/http.ts#L294-L314) —
the three endpoint-wide singletons:

```ts
  const sharedRegistry = createWatcherRegistry();
  const sharedStore = new ResourceStore(() => {
    modernHandler.notify.resourcesChanged();
  });
  const sharedPathGuard = new PathGuard(options, true);
  await sharedPathGuard.recomputeAllowedDirectories();
```

`sharedPathGuard` and `sharedStore` reach every per-request instance through
[`makeHttpModernFactory`](../../../src/transport/http.ts#L87-L112).

[`src/core/path.ts:513-530`](../../../src/core/path.ts#L513-L530) — the
mutation that leaks across callers:

```ts
  async applyGrant(targetDir: string): Promise<boolean> {
    if (isUnsafeCwdPath(normalizePath(targetDir))) {
      return false;
    }
    if (!(await this.isWithinBoundary(targetDir))) {
      return false;
    }
    return this.runExclusive(async () => {
      await this.#setRootsLocked([...this.getAllowedDirectories(), targetDir]);
      return true;
    });
  }
```

[`src/transport/http.ts:151-154`](../../../src/transport/http.ts#L151-L154) —
the rate limiter, mounted only when a key is configured:

```ts
  if (apiKey) {
    const rpm = parseEnvInt('FILESYSTEM_MCP_RATE_LIMIT_RPM', 120, 1, 100_000);
    app.use('/mcp', createRateLimiter(rpm));
  }
```

[`src/transport/stdio.ts:154-160`](../../../src/transport/stdio.ts#L154-L160) —
the undefended monkey-patch:

```ts
  const deliver = wire.onmessage;
  let gated = Promise.resolve();
  wire.onmessage = (message) => {
    if (listenSubscriptionUris(message).length === 0) {
      deliver?.(message);
      return;
    }
```

If a future SDK release stops installing `onmessage` synchronously, `deliver`
is `undefined`, `deliver?.(message)` silently drops every message, and no test
fails loudly.

### Existing tests that pin the behavior this plan changes

These will fail unless updated in the same step. Each is listed with the step
that must touch it.

- [`__tests__/tools.test.ts:164-190`](../../../__tests__/tools.test.ts#L164-L190)
  — asserts `outputSchema.$defs` is `undefined` on every tool. Reads
  `tool.outputSchema` unconditionally. → Step 9.
- [`__tests__/tools.test.ts:456-459`](../../../__tests__/tools.test.ts#L456-L459)
  — `TC-FUNC-058: list tool declares idempotentHint`. → Step 5.
- [`__tests__/tools.test.ts:1038-1059`](../../../__tests__/tools.test.ts#L1038-L1059)
  — asserts `create`/`edit`/`patch`/`stat` output schemas have no `$defs` and
  keep `"format":"date-time"` inline. → Steps 8, 9.
- [`__tests__/tools.test.ts:1075-1086`](../../../__tests__/tools.test.ts#L1075-L1086)
  — asserts `edit`'s input contains no `$ref` **and** that
  `'Exact literal text to locate'` appears exactly twice. Directly contradicts
  Step 8. → Step 8.
- [`__tests__/tools.test.ts:1114-1124`](../../../__tests__/tools.test.ts#L1114-L1124)
  — asserts `read`'s `not.anyOf` holds all five pairs. Directly contradicts
  Step 7. → Step 7.
- [`__tests__/http-transport.test.ts:82-88`](../../../__tests__/http-transport.test.ts#L82-L88)
  — asserts `discover.ttlMs === 60_000`. → Step 2.
- [`__tests__/resources.test.ts:526-531`](../../../__tests__/resources.test.ts#L526-L531)
  — asserts `capabilities.resources?.subscribe === true` from a `createServer`
  call with no `era`. → Step 3.

### Conventions to match

- Tool definitions: every tool is a `defineTool({...})` call whose object
  literal orders `name, title, description, input, output, annotations, …`.
  Imitate [`src/tools/roots.ts:12-36`](../../../src/tools/roots.ts#L12-L36) —
  the smallest complete example in the repo.
- Shared schema fragments live in
  [`src/core/schema.ts`](../../../src/core/schema.ts) and are imported, never
  redeclared per tool.
- Comments explain *why*, not *what*, and are full sentences. Match the density
  of [`src/tools/define.ts:460-477`](../../../src/tools/define.ts#L460-L477).
- Tests are `node:test` `describe`/`it` with `node:assert/strict`, and behavior
  tests drive a real client through
  [`createTestClientPair()`](../../../__tests__/helpers.ts#L88-L107). Imitate
  [`__tests__/tools.test.ts:164-190`](../../../__tests__/tools.test.ts#L164-L190).
- Never hand-edit the `version` field in
  [`package.json`](../../../package.json) or
  [`server.json`](../../../server.json) — the Release workflow owns both
  (see [`AGENTS.md`](../../../AGENTS.md)).

## Commands

| Purpose | Command | Expected on success |
| :--- | :--- | :--- |
| Static checks | `node scripts/tasks.mjs --quick` | exit 0; ends with `All matched files use Prettier code style!` |
| Tests | `node scripts/tasks.mjs test` | exit 0; `pass 214` (or higher), `fail 0` |
| Full check | `node scripts/tasks.mjs` | exit 0 |
| Format + lint-fix, then check | `node scripts/tasks.mjs fix` | exit 0 |
| One test file | `node scripts/tasks.mjs test __tests__/tools.test.ts` | exit 0, `fail 0` |

Run commands from the repository root. Do not call the npm scripts directly —
`scripts/tasks.mjs` is the cross-platform wrapper this repo standardizes on.

## Scope

**In scope** — the only files to modify:

- [`src/server.ts`](../../../src/server.ts)
- [`src/tools/define.ts`](../../../src/tools/define.ts)
- [`src/core/schema.ts`](../../../src/core/schema.ts)
- [`src/core/concurrency.ts`](../../../src/core/concurrency.ts)
- [`src/tools/edit.ts`](../../../src/tools/edit.ts)
- [`src/tools/read.ts`](../../../src/tools/read.ts)
- [`src/tools/stat.ts`](../../../src/tools/stat.ts)
- [`src/tools/create.ts`](../../../src/tools/create.ts)
- [`src/tools/delete-file.ts`](../../../src/tools/delete-file.ts)
- [`src/tools/diff.ts`](../../../src/tools/diff.ts)
- [`src/tools/list.ts`](../../../src/tools/list.ts)
- [`src/tools/move.ts`](../../../src/tools/move.ts)
- [`src/tools/patch.ts`](../../../src/tools/patch.ts)
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts)
- [`src/tools/roots.ts`](../../../src/tools/roots.ts)
- [`src/tools/search-content.ts`](../../../src/tools/search-content.ts)
- [`src/tools/search-files.ts`](../../../src/tools/search-files.ts)
- [`src/tools/index.ts`](../../../src/tools/index.ts)
- [`src/transport/http.ts`](../../../src/transport/http.ts)
- [`src/transport/stdio.ts`](../../../src/transport/stdio.ts)
- [`src/instructions.ts`](../../../src/instructions.ts)
- [`src/prompts.ts`](../../../src/prompts.ts)
- [`src/resources.ts`](../../../src/resources.ts)
- [`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts)
- [`__tests__/http-transport.test.ts`](../../../__tests__/http-transport.test.ts)
- [`__tests__/resources.test.ts`](../../../__tests__/resources.test.ts)
- [`__tests__/http-policy.test.ts`](../../../__tests__/http-policy.test.ts)
- [`__tests__/stdio.test.ts`](../../../__tests__/stdio.test.ts)
- [`README.md`](../../../README.md) — Step 13 and Step 16 only

**Files out of scope** — leave alone even though they look related:

- [`package.json`](../../../package.json) and
  [`server.json`](../../../server.json) — the Release workflow bumps and syncs
  the version fields; a hand edit desynchronizes them.
- [`src/core/path.ts`](../../../src/core/path.ts) — `applyGrant`'s behavior is
  correct in isolation; Step 14 changes *who owns the guard*, not what a grant
  does. Editing the guard would widen a security fix into a rewrite.
- [`src/core/watcher-registry.ts`](../../../src/core/watcher-registry.ts) — the
  per-URI ref-count and missing per-subscription id are a known, separately
  tracked limitation. Nothing here depends on changing them.
- [`src/http-policy.ts`](../../../src/http-policy.ts) — Step 15 changes where
  `createRateLimiter` is *mounted*, not the limiter itself.
- [`src/core/store.ts`](../../../src/core/store.ts) — Step 14 changes how many
  `ResourceStore` instances exist and who reaches them, not the store's own
  API.
- [`scripts/tasks.mjs`](../../../scripts/tasks.mjs) — the task runner is the
  gate; changing it invalidates every Verify line in this plan.

## Steps

Phases are cumulative. Do not start a phase before its predecessor's Verify
passes.

---

## Phase A — install the gate

### 1. Add a payload-budget test at the current baseline

Append a new `it(...)` to the existing `describe` block that closes at
[`__tests__/tools.test.ts:1131`](../../../__tests__/tools.test.ts#L1131) —
the same block that holds `TOOL-SURFACE-001`, whose own `it(...)` closes at
[`:1130`](../../../__tests__/tools.test.ts#L1130). It measures the exact byte cost a
client pays and fails if it grows. Later steps lower `BUDGET_CHARS`; nothing
else in the test changes.

Target shape:

```ts
  // The session-start cost a client pays before its first tool call. Lower this
  // ceiling when a step in the payload plan removes weight; never raise it
  // without a recorded reason. Baseline at commit 528760ea: 41410 / 20862.
  it('TOOL-SURFACE-002: tools/list stays within the session-start budget', async () => {
    const BUDGET_CHARS = 41_410;
    const BUDGET_CHARS_READ_ONLY = 20_862;

    const full = await createTestClientPair([tmpDir]);
    try {
      const { tools } = await full.client.listTools();
      assert.strictEqual(tools.length, 13, 'tool count changed; update the budget deliberately');
      const size = JSON.stringify(tools).length;
      assert.ok(
        size <= BUDGET_CHARS,
        `tools/list is ${String(size)} chars, over the ${String(BUDGET_CHARS)} budget`,
      );
    } finally {
      await full.close();
    }

    const ro = await createTestClientPair([tmpDir], { readOnly: true });
    try {
      const { tools } = await ro.client.listTools();
      const size = JSON.stringify(tools).length;
      assert.ok(
        size <= BUDGET_CHARS_READ_ONLY,
        `read-only tools/list is ${String(size)} chars, over the ${String(BUDGET_CHARS_READ_ONLY)} budget`,
      );
    } finally {
      await ro.close();
    }
  });
```

`createTestClientPair` is already imported in this file; confirm it, and confirm
`tmpDir` is the surrounding suite's temp root (it is used the same way at
[`tools.test.ts:165`](../../../__tests__/tools.test.ts#L165)).

**Verify**: `node scripts/tasks.mjs test __tests__/tools.test.ts` → exit 0,
`fail 0`, and the new test name appears in the output as
`✔ TOOL-SURFACE-002: tools/list stays within the session-start budget`.

---

## Phase B — spec conformance (no payload change)

### 2. Raise the cache TTLs on the static lists

In [`src/server.ts:115-125`](../../../src/server.ts#L115-L125), raise every hint
that describes a list which cannot change at runtime. The tool, prompt, and
template lists are built from frozen module-level arrays; only `resources/list`
enumerates the mutable `ResourceStore`.

- `'tools/list'` → `ttlMs: 3_600_000`
- `'prompts/list'` → `ttlMs: 3_600_000`
- `'resources/templates/list'` → `ttlMs: 3_600_000`
- `'server/discover'` → `ttlMs: 3_600_000`
- `'resources/list'` → unchanged at `30_000` / `'private'`

Replace the comment above `'resources/list'` so it also records why the other
four are an hour: the lists are frozen at module scope, so a shorter hint only
buys the client a re-fetch of bytes that cannot have changed, and costs it the
prompt-cache stability the spec asks for.

Then update
[`__tests__/http-transport.test.ts:86`](../../../__tests__/http-transport.test.ts#L86)
from `assert.strictEqual(discover.ttlMs, 60_000);` to `3_600_000`. Leave the
`cacheScope` assertion on the next line alone.

**Verify**: `node scripts/tasks.mjs test __tests__/http-transport.test.ts` →
exit 0, `fail 0`.

### 3. Advertise `resources.subscribe` only on the era that answers it

In [`src/server.ts:104-109`](../../../src/server.ts#L104-L109), make the
capability object depend on `extraDeps?.era`. The modern era answers
`resources/subscribe` with `-32601` (see
[`src/resources.ts:524`](../../../src/resources.ts#L524)), so advertising it
there tells the client an operation is available that is not.

Target shape:

```ts
  // `resources/subscribe` is a 2025-era verb. A modern instance answers it with
  // -32601 (resources.ts gates the handler on the same era), so advertising it
  // there breaks the promise the capability exchange exists to make: that an
  // unsupported operation is never attempted. `undefined` era means the caller
  // could not say — keep the legacy answer, which is what predates this check.
  const capabilities = {
    resources: {
      ...(extraDeps?.era === 'modern' ? {} : { subscribe: true }),
      listChanged: true,
    },
    tools: {},
    prompts: {},
    completions: {},
  } satisfies ServerCapabilities;
```

Then split
[`__tests__/resources.test.ts:526-531`](../../../__tests__/resources.test.ts#L526-L531)
into two cases: the existing one (no `era`, still expects
`subscribe === true`), plus a new one passing
`{ era: 'modern' }` as the second argument to `createServer` and asserting
`capabilities.resources?.subscribe` is `undefined`. `listChanged` stays `true`
in both.

> `enforceStrictCapabilities` is `true`
> ([`src/server.ts:114`](../../../src/server.ts#L114)), and the removed comment
> at [`server.ts:100-103`](../../../src/server.ts#L100-L103) claims the SDK
> gates outbound `notifications/resources/updated` on this same bit. If the
> subscription tests in Step 3's Verify fail *for that reason*, that is the
> [STOP](#stop) condition on this step — do not restore the capability to make
> them pass.

**Verify**: `node scripts/tasks.mjs test __tests__/resources.test.ts` and
`node scripts/tasks.mjs test __tests__/subscriptions-listen.test.ts` → both
exit 0, `fail 0`.

### 4. Split `stoppedReason` so each tool publishes only its reachable values

In [`src/core/concurrency.ts:8`](../../../src/core/concurrency.ts#L8), keep
`StoppedReasonSchema` as-is for `replace_text` and add a two-value sibling
beside it:

```ts
/**
 * The subset `search_text` and `find_files` can actually emit. Their scans call
 * only `hitMaxResults` and `hitAbort` (search.ts), never `hitMaxFiles`, so the
 * three-value enum published a value no response can carry and disagreed with
 * both tools' own descriptions.
 */
export const SearchStoppedReasonSchema = z.enum(['maxResults', 'timeout']).optional();
```

Switch the two search tools to it:

- [`src/tools/search-files.ts:65`](../../../src/tools/search-files.ts#L65) and
  its import at [`:3`](../../../src/tools/search-files.ts#L3)
- [`src/tools/search-content.ts:140`](../../../src/tools/search-content.ts#L140)
  and its import at [`:3`](../../../src/tools/search-content.ts#L3)

Leave both `.describe(...)` strings unchanged — they already document exactly
these two values. Leave
[`src/tools/replace-in-files.ts:136-137`](../../../src/tools/replace-in-files.ts#L136-L137)
on the three-value schema; `maxFiles` is reachable there via `args.maxFiles`.

If `tsc` reports that the narrowed enum no longer accepts the value assigned at
[`search-files.ts:138-140`](../../../src/tools/search-files.ts#L138-L140) or
[`search-content.ts:64`](../../../src/tools/search-content.ts#L64), narrow the
output type alongside — do not widen the schema back.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, then
`node scripts/tasks.mjs test` → exit 0, `fail 0`.

---

## Phase C — payload trims

### 5. Emit only the annotations that carry information

Three of the four hints are constant across all 13 tools and two of them are
inert on read-only tools. Trim at the one place the shape is assembled rather
than editing 13 files, so a future tool cannot regress it.

In [`src/tools/define.ts:502-508`](../../../src/tools/define.ts#L502-L508),
derive the published annotations from `def.annotations` instead of passing it
through:

```ts
  // Published annotations are derived, not passed through. `readOnlyHint` is
  // load-bearing (MUTATING_TOOL_NAMES derives the --read-only gate from it) and
  // `openWorldHint: false` is a real claim for a filesystem server. The other
  // two describe behavior a read-only tool cannot have, and restate the default
  // for a mutating one — 29 tokens per tool for nothing a client acts on.
  const publishedAnnotations: ToolAnnotations = {
    readOnlyHint: def.annotations.readOnlyHint,
    openWorldHint: def.annotations.openWorldHint ?? false,
    ...(def.annotations.readOnlyHint
      ? {}
      : { destructiveHint: def.annotations.destructiveHint ?? true }),
  };
```

Keep `DeclaredAnnotations`
([`define.ts:103`](../../../src/tools/define.ts#L103)) and every tool's literal
unchanged — the full declaration stays the source of truth in code; only the
wire copy narrows. `DefinedTool.annotations`
([`define.ts:512`](../../../src/tools/define.ts#L512)) must keep returning
`def.annotations`, because
[`MUTATING_TOOL_NAMES`](../../../src/tools/index.ts#L36-L38) reads it.

Then update
[`__tests__/tools.test.ts:456-459`](../../../__tests__/tools.test.ts#L456-L459):
`TC-FUNC-058` reads `ALL_TOOLS`, not the wire, so it still passes as written —
confirm that, and add one wire assertion beside it that `list`'s published
annotations contain no `idempotentHint`.

**Verify**: `node scripts/tasks.mjs test __tests__/tools.test.ts` → exit 0,
`fail 0`.

### 6. Drop `examples` from input schemas

[`src/tools/define.ts:487`](../../../src/tools/define.ts#L487) already drops
`examples` from output schemas. Extend it to both directions — the glob examples
`['**/*.ts', 'src/**/*.js', '*.{ts,tsx}']` appear in three tools, and `edit`'s
`oldText`/`newText` examples appear twice each, while every affected
`description` already carries the same example inline (e.g.
[`schema.ts:137`](../../../src/core/schema.ts#L137) reads
`(e.g. "**/*.ts", "src/**/*.js")`).

Change the `override` body so the `examples` delete is unconditional, and update
the doc comment at
[`define.ts:460-477`](../../../src/tools/define.ts#L460-L477) — the bullet that
currently says output schemas "additionally drop `examples`" is now the rule for
both.

**Verify**: `node scripts/tasks.mjs test __tests__/tools.test.ts` → exit 0,
`fail 0`.

### 7. Replace `read`'s `not/anyOf` block with one description sentence

Delete the `not: { anyOf: [...] }` entry from the `.meta({...})` call at
[`src/tools/read.ts:76-84`](../../../src/tools/read.ts#L76-L84). Keep `oneOf`
and `dependentRequired` — both are single-line and both express rules a model
cannot infer.

The runtime rule is unchanged:
[`validateReadRange()`](../../../src/core/schema.ts#L227-L293) still rejects
every conflicting combination with a named message, and that rejection reaches
the client as a tool error. Move the wire-side statement into the tool
description at
[`src/tools/read.ts:386-389`](../../../src/tools/read.ts#L386-L389) by appending
one sentence:

`'head, tail, and startLine/endLine are mutually exclusive — use exactly one.'`

Then replace the assertion at
[`__tests__/tools.test.ts:1114-1124`](../../../__tests__/tools.test.ts#L1114-L1124):
assert `readSchema.not` is `undefined`, keep the `dependentRequired`
assertion, and add a live call asserting `{ path, head: 1, tail: 1 }` returns
`isError: true` with `head` or `tail` in the message — so the rule is still
proven, at the layer that enforces it.

**Verify**: `node scripts/tasks.mjs test __tests__/tools.test.ts` → exit 0,
`fail 0`.

### 8. Hoist `EditSpecSchema` into `$defs`

`edit` is the one document where a `$ref` pays: the same ~1,341-character
subschema is inlined at both
[`edits`](../../../src/tools/edit.ts#L55) and
[`files[].edits`](../../../src/tools/edit.ts#L65).

Add `.meta({ id: 'EditSpec' })` to the `EditSpecSchema` declaration at
[`src/tools/edit.ts:31-46`](../../../src/tools/edit.ts#L31-L46). Per the note at
[`src/core/schema.ts:10-12`](../../../src/core/schema.ts#L10-L12), an `id`
makes zod hoist the schema into `$defs` and leave a `$ref` at each use site —
which is what this document wants and what the other shared schemas correctly
avoid. Do **not** add an `id` to any schema in `core/schema.ts`: those appear at
most once per tool document, so a `$ref` there costs more than it saves.

Then update the two contradicting assertions:

- [`__tests__/tools.test.ts:1078`](../../../__tests__/tools.test.ts#L1078) —
  `assert.ok(!editInput.includes('$ref'), ...)` must invert: `edit`'s input
  schema **must** contain exactly two `$ref` occurrences and one `$defs.EditSpec`
  entry.
- [`__tests__/tools.test.ts:1082-1086`](../../../__tests__/tools.test.ts#L1082-L1086)
  — the sentinel count of `'Exact literal text to locate'` drops from `2` to
  `1`.

Leave the `$defs`-is-undefined assertions for `create`/`patch`/`stat` at
[`:1042-1046`](../../../__tests__/tools.test.ts#L1042-L1046) alone; they are
output schemas and unaffected. `edit` is not in that list.

> Spec note for the reviewer: clients **SHOULD** "follow the `$ref` resolution
> requirements when validating tool inputs and outputs"
> (`specification/2026-07-28/server/tools`, §Security Considerations), so a
> `$ref` inside one schema document is supported. If a target client is known
> not to dereference, revert this step alone — it is independent of every other.

**Verify**: `node scripts/tasks.mjs test __tests__/tools.test.ts` → exit 0,
`fail 0`.

### 9. Delete descriptions that restate their own key

In [`src/core/schema.ts:140-172`](../../../src/core/schema.ts#L140-L172), remove
`.describe(...)` from every field whose text is the key name in prose. Keep the
ones that carry a contract the key does not:

| Schema | Drop `.describe` from | Keep |
| :--- | :--- | :--- |
| `FileInfoSchema` | `name`, `path`, `type`, `size`, `created`, `modified`, `accessed`, `permissions`, `isHidden`, `mimeType` | `tokenEstimate`, `symlinkTarget` |
| `OperationSummarySchema` | `total`, `succeeded`, `failed` | — |
| `PerFileErrorSchema` | `code`, `message`, `path`, `suggestion` | — |

Also drop the `'Aggregate counts: total, succeeded, failed'` description at each
`OperationSummarySchema` use site — it restates the three child keys. Find them
with `grep -rn "Aggregate counts" src/`.

Do **not** touch
[`pairFailureSchema()`](../../../src/core/schema.ts#L178-L184): its
`source`/`destination` descriptions distinguish two same-typed string fields,
which the keys alone do not.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `fail 0`.

### 10. Lower the budget to the Phase C ceiling

Set `BUDGET_CHARS = 39_000` and `BUDGET_CHARS_READ_ONLY = 19_500` in the test
added by Step 1. Projection from the measured tree is ~38,545 full / ~19,300
read-only; the ceilings carry headroom for wording differences.

If the measured size is **above** the ceiling, a step in Phase C did not land —
find which by diffing `JSON.stringify(tools)` against the baseline, do not
raise the ceiling.

**Verify**: `node scripts/tasks.mjs test __tests__/tools.test.ts` → exit 0,
`fail 0`, and the failure message never appears.

---

## Phase D — the output-schema policy (largest single win)

### 11. Make `outputSchema` opt-in per tool

Output schemas are 6,013 of 11,352 tokens in `tools/list` — 53% — on a field the
spec marks optional. Publish one only where the result shape is genuinely not
inferable from the tool's `description` plus its text content.

Add an optional field to `ToolDef` at
[`src/tools/define.ts:105-129`](../../../src/tools/define.ts#L105-L129):

```ts
  /**
   * Publish `output` as the tool's wire `outputSchema`. Off by default: the
   * spec makes the field optional and it costs more than every other part of
   * a tool entry combined. Turn it on only where the shape is not inferable —
   * a discriminated per-path union, or a field that appears under one flag and
   * not another. The Zod object still validates every result either way.
   */
  readonly publishOutputSchema?: boolean;
```

In [`defineTool`](../../../src/tools/define.ts#L493-L520), compute
`outputJsonSchema` as today (the validator still needs it) but spread
`outputSchema` into `toolDefShape` only when the flag is set.

Set `publishOutputSchema: true` on exactly three tools, whose result shapes are
unions the description cannot state:

- [`READ_FILE`](../../../src/tools/read.ts#L383) — `results[].value` XOR
  `results[].error`, and `value` has no required field at all.
- [`EDIT`](../../../src/tools/edit.ts#L506) — same per-path union, plus `diff`
  present only under `dryRun`.
- [`DELETE_FILE`](../../../src/tools/delete-file.ts#L360) — returns `path` XOR
  `paths` depending on the input count.

Every other tool returns a flat object whose keys its description already names.

Then repair the tests that read `tool.outputSchema` unconditionally:

- [`__tests__/tools.test.ts:181-186`](../../../__tests__/tools.test.ts#L181-L186)
  — the `$defs`-is-undefined loop already uses `?.`; confirm it still passes
  with `outputSchema` absent.
- [`__tests__/tools.test.ts:1038-1059`](../../../__tests__/tools.test.ts#L1038-L1059)
  — narrow the tool list from `['create', 'edit', 'patch', 'stat']` to
  `['edit']`, the only one in that set that still publishes an output schema.
  Add an assertion beside it that `create`, `patch`, and `stat` publish no
  `outputSchema` at all.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `fail 0`.

### 12. Lower the budget to the Phase D ceiling

Set `BUDGET_CHARS = 18_500` and `BUDGET_CHARS_READ_ONLY = 9_500`. Projection
from the measured tree with all output schemas dropped is ~17,972 full; three
kept schemas add back roughly 4,000, so if the measured size lands between
21,000 and 23,000 the three-tool exemption list in Step 11 is correct but the
ceiling here is wrong — record the measured number and raise the ceiling to it
plus 500, noting why.

**Verify**: `node scripts/tasks.mjs test` → exit 0, `fail 0`.

---

## Phase E — tool-surface consolidation (breaking)

> **Gate**: Phase E removes and renames tools. Every existing client's prompt
> and every saved workflow that names `find_files`, `patch`, or `diff` breaks.
> Do not start Phase E unless the plan's owner has confirmed a major-version
> bump. If that confirmation is not recorded, stop here and report Phases A–D
> complete — see [STOP](#stop).

### 13. Merge `find_files` into `search_text`

The two tools share `path`, `pattern`, `includeHidden`, `includeIgnored`,
`maxDepth`, `maxResults`, `cursor`, `stoppedReason`, `filesScanned`,
`skippedInaccessible`, `resourceUri`, and `nextCursor`. The only difference is
whether the pattern is applied to file contents — and each tool's description
already points at the other
([`search-content.ts:377`](../../../src/tools/search-content.ts#L377),
[`search-files.ts:174`](../../../src/tools/search-files.ts#L174)).

Make `searchPattern` optional in
[`GrepInputSchema`](../../../src/tools/search-content.ts#L80) — the field is
declared at [`search-content.ts:87`](../../../src/tools/search-content.ts#L87) —
and route the handler:
absent `searchPattern` runs the filename-only path that
[`handleSearchFiles`](../../../src/tools/search-files.ts#L100-L166) runs today;
present `searchPattern` keeps current behavior. Output gains an optional
`results[]` (matched paths) alongside `matches[]`, and the description states
which arrives under which mode.

Remove `SEARCH_FILES` from
[`ALL_TOOLS`](../../../src/tools/index.ts#L20-L34) and from the re-export list
at [`index.ts:52`](../../../src/tools/index.ts#L52). Fix all four references in
[`src/instructions.ts`](../../../src/instructions.ts) — the import at
[`:15`](../../../src/instructions.ts#L15), the `Navigate` row at
[`:20`](../../../src/instructions.ts#L20), the `path_resolution` line at
[`:45`](../../../src/instructions.ts#L45), and the `NOT_FOUND` recovery line at
[`:67`](../../../src/instructions.ts#L67) — to name `search_text`. Update the
tool table in [`README.md:213`](../../../README.md#L213).

Keep [`src/tools/search-files.ts`](../../../src/tools/search-files.ts)'s
internal helpers if `search_text` calls them; knip fails the build on a module
that becomes wholly unreachable, so delete the file if nothing imports it.

Fix `TC-FUNC-014` at
[`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts) (search for
`'TC-FUNC-014: find_files returns matched files via callTool'`) to call
`search_text` with no `searchPattern`.

**Verify**: `node scripts/tasks.mjs` → exit 0, `fail 0`, and knip reports no
unused files.

### 14. Retire `patch` and `diff`

`patch` applies a unified diff that `edit` can express as `oldText`/`newText`;
its own description at
[`src/tools/patch.ts:184-189`](../../../src/tools/patch.ts#L184-L189) points at
`diff`. `diff` compares two files, which `edit --dryRun` covers for the
edit-preview case its description names.

Remove `PATCH` and `DIFF` from
[`ALL_TOOLS`](../../../src/tools/index.ts#L20-L34), delete
[`src/tools/patch.ts`](../../../src/tools/patch.ts) and
[`src/tools/diff.ts`](../../../src/tools/diff.ts), and drop the rows at
[`README.md:221`](../../../README.md#L221) and
[`README.md:238`](../../../README.md#L238). `patch` is in
`MUTATING_TOOL_NAMES`, so the `--read-only` help text at
[`src/cli.ts:140`](../../../src/cli.ts#L140) and the two README lines that
enumerate write tools ([`:199`](../../../README.md#L199),
[`:357`](../../../README.md#L357)) update themselves from the set — confirm by
running `node dist/index.js --help` after the build and reading the
`--read-only` line.

Delete the `patch` and `diff` test cases in
[`__tests__/tools.test.ts`](../../../__tests__/tools.test.ts) (search for
`name: 'patch'` and `name: 'diff'`).

> This step is the one the audit hedged on: both tools are the cheapest on the
> list (586 and 402 tokens) and each covers a case its replacement does not
> exactly match. If the owner's confirmation covered only Step 13, do Step 13
> and stop.

**Verify**: `node scripts/tasks.mjs` → exit 0, `fail 0`, and the budget test
reports 10 tools.

### 15. Lower the budget to the Phase E ceiling

Set `BUDGET_CHARS = 15_500`, `BUDGET_CHARS_READ_ONLY = 8_500`, and change the
tool-count assertion in Step 1's test from `13` to `10`.

**Verify**: `node scripts/tasks.mjs test __tests__/tools.test.ts` → exit 0,
`fail 0`.

---

## Phase F — security and robustness

Independent of Phases C–E. May be done before them if the payload work is
deferred.

### 16. Scope the shared `PathGuard` and `ResourceStore` by authorization

> **Security.** This is the one finding in this plan that is a live defect
> rather than a cost. On the HTTP leg,
> [`startHttpServer`](../../../src/transport/http.ts#L294-L314) builds one
> `PathGuard` and one `ResourceStore` for the whole endpoint and injects both
> into every per-request server. `applyGrant`
> ([`src/core/path.ts:513-530`](../../../src/core/path.ts#L513-L530)) mutates
> that guard's root set permanently. One caller confirming a grant for a
> directory therefore widens the allowed roots for every other caller on the
> endpoint, for the process lifetime, with no revocation. `resources/list` over
> the shared store likewise exposes another caller's externalized file contents
> by URI.

The code's own justification — "with API_KEY set every caller presents the same
key (one auth context by construction)"
([`http.ts:308-312`](../../../src/transport/http.ts#L308-L312)) — is the
assumption the spec declines to make: tool availability "**MAY** vary by the
authorization presented on the request […] since credentials are per-request
input, not connection state."

Replace the two singletons with a keyed map. The key is a SHA-256 hex digest of
the presented bearer token, or the literal `'anonymous'` when no `apiKey` is
configured (that bind is loopback-only, enforced by
[`assertHttpBindingPolicy`](../../../src/http-policy.ts#L123-L138)).

Target shape, inside `startHttpServer`:

```ts
  // One guard and one store per auth context, not per endpoint. A grant is
  // authorization state: the caller who accepted it is the only one it may
  // widen. Keyed on a digest of the presented credential so the raw token is
  // never held in a long-lived map. `anonymous` covers the keyless bind, which
  // assertHttpBindingPolicy already pins to loopback.
  const contexts = new Map<string, { guard: PathGuard; store: ResourceStore }>();
  const contextFor = async (authKey: string) => { /* create on first use */ };
```

`makeHttpModernFactory`'s callback receives the SDK's per-request context; read
the validated `authInfo.token` that
[`bearerAuthMiddleware`](../../../src/http-policy.ts#L270-L306) already attaches
at [`http-policy.ts:288-293`](../../../src/http-policy.ts#L288-L293), digest it,
and resolve the pair before calling `createServer`.

`sharedRegistry` stays a single instance — a file watcher is not
authorization-scoped, and `MAX_WATCHERS` bounds it globally. But
[`prepareListenWatchers`](../../../src/transport/shared.ts#L74-L91) validates
each URI against a `PathGuard`: pass the caller's guard, not a shared one, at
both call sites
([`http.ts:215-220`](../../../src/transport/http.ts#L215-L220)).

Leave [`src/transport/stdio.ts`](../../../src/transport/stdio.ts) alone: a stdio
connection has exactly one client by construction, and its guard is already
per-connection.

Add a test in
[`__tests__/http-policy.test.ts`](../../../__tests__/http-policy.test.ts) that
boots one HTTP server with
[`bootHttpTest`](../../../__tests__/helpers.ts#L285-L344), connects two clients
with *different* bearer tokens, has the first accept a grant for a directory
outside the configured roots, and asserts the second still gets `ACCESS_DENIED`
for a path under it. `bootHttpTest` currently hands every client the same
`TEST_API_KEY` ([`helpers.ts:314`](../../../__tests__/helpers.ts#L314)) — extend
`makeClient` to take an optional token override rather than writing a second
harness.

> If the SDK's per-request context does not expose the validated `authInfo`
> before the factory runs, that is the [STOP](#stop) condition on this step.
> Report it rather than falling back to reading the raw `Authorization` header
> a second time — a second parse is a second place for the two to disagree.

**Verify**: `node scripts/tasks.mjs test __tests__/http-policy.test.ts` and
`node scripts/tasks.mjs test __tests__/path-guard-grant.test.ts` → both exit 0,
`fail 0`, and the new cross-caller test fails if the `contexts` map is replaced
with a single shared pair.

### 17. Rate-limit the keyless bind too

[`src/transport/http.ts:151-154`](../../../src/transport/http.ts#L151-L154)
mounts `createRateLimiter` only when `apiKey` is set. The spec's tool security
section states servers **MUST** "Rate limit tool invocations", without
qualification.

Mount it unconditionally, keeping the configured cap for the authenticated case
and a higher default for the loopback keyless one:

```ts
  // Unconditional: the spec's rate-limit MUST is not scoped to authenticated
  // binds. A keyless bind is loopback-only, so the cap is looser, not absent.
  const rpm = parseEnvInt(
    'FILESYSTEM_MCP_RATE_LIMIT_RPM',
    apiKey ? 120 : 6_000,
    1,
    100_000,
  );
  app.use('/mcp', createRateLimiter(rpm));
```

No existing test asserts the absence of a limiter on the keyless path —
[`http-policy.test.ts:565`](../../../__tests__/http-policy.test.ts#L565)
(`TC-SEC-036`) exercises `createRateLimiter` directly, and
[`http-server.test.ts:262`](../../../__tests__/http-server.test.ts#L262) boots
through [`bootHttpTest`](../../../__tests__/helpers.ts#L285-L344), which always
sets `TEST_API_KEY`. So nothing needs inverting: add one case that boots a
keyless server and asserts the limiter is mounted (a 429 after exceeding a
`FILESYSTEM_MCP_RATE_LIMIT_RPM` of `2`).

**Verify**: `node scripts/tasks.mjs test __tests__/http-policy.test.ts` and
`node scripts/tasks.mjs test __tests__/http-server.test.ts` → both exit 0,
`fail 0`.

### 18. Fail loudly if the stdio listen gate loses its seam

[`src/transport/stdio.ts:154`](../../../src/transport/stdio.ts#L154) captures
`wire.onmessage` immediately after `serveStdio` installs it. The whole stdio
file-watching path depends on that callback existing at that moment. If a
future SDK release installs it asynchronously, `deliver` is `undefined`, every
message is silently dropped by `deliver?.(message)`, and nothing fails.

Insert an assertion between the `serveStdio` call
([`stdio.ts:134-140`](../../../src/transport/stdio.ts#L134-L140)) and the
capture:

```ts
  // serveStdio installs its onmessage synchronously and only then starts the
  // wire; this wrapper is only correct because of that ordering. Assert it
  // rather than degrade to a silent no-op if a future SDK release changes it.
  const deliver = wire.onmessage;
  if (!deliver) {
    throw new Error(
      'serveStdio did not install a synchronous onmessage handler; the subscriptions/listen watcher gate cannot attach. This is an SDK contract change, not a configuration error.',
    );
  }
```

Then replace both `deliver?.(message)` call sites — at
[`stdio.ts:158`](../../../src/transport/stdio.ts#L158) and
[`:176`](../../../src/transport/stdio.ts#L176) — with `deliver(message)`.

Add a regression case to
[`__tests__/stdio.test.ts`](../../../__tests__/stdio.test.ts) asserting a stdio
server still delivers a `subscriptions/listen` acknowledgment and a subsequent
file-change notification — the behavior the assertion protects.

**Verify**: `node scripts/tasks.mjs test __tests__/stdio.test.ts` and
`node scripts/tasks.mjs test __tests__/subscriptions-listen.test.ts` → both
exit 0, `fail 0`.

### 19. Collapse the four overlapping guidance strings into one

The same "read this for guidance" sentence exists four times:

- `serverInfo.description`, from
  [`package.json:5`](../../../package.json#L5) via
  [`server.ts:144`](../../../src/server.ts#L144)
- the `instructions` string at
  [`server.ts:135-138`](../../../src/server.ts#L135-L138)
- the `get-help` prompt description at
  [`src/prompts.ts:99-100`](../../../src/prompts.ts#L99-L100)
- the instructions-resource description at
  [`src/resources.ts:145`](../../../src/resources.ts#L145)

Export one constant from
[`src/instructions.ts`](../../../src/instructions.ts) — the module that already
owns `INSTRUCTIONS_URI` — and have `server.ts`, `prompts.ts`, and `resources.ts`
import it. Leave `package.json`'s `description` alone: it is the npm registry
description and out of scope.

**Verify**: `node scripts/tasks.mjs` → exit 0, `fail 0`.

---

## Done

Machine-checkable. All must hold:

- [ ] `node scripts/tasks.mjs --quick` exits 0
- [ ] `node scripts/tasks.mjs test` exits 0 with `fail 0` and at least 216 tests
      (214 baseline + `TOOL-SURFACE-002` + the cross-caller grant test)
- [ ] `node scripts/tasks.mjs` exits 0
- [ ] `TOOL-SURFACE-002` passes at `BUDGET_CHARS = 18_500` (Phase D complete) or
      `15_500` (Phase E complete)
- [ ] A modern-era `server/discover` no longer reports
      `resources.subscribe: true`, and a legacy one still does
- [ ] Two HTTP clients with different bearer tokens do not share access grants
- [ ] `git status` shows no modified files outside the
      [in-scope list](#scope)
- [ ] `git diff --stat -- package.json server.json` is empty

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  quoted excerpt. The excerpts were verified at `528760ea`; a mismatch means
  the drift check missed a change and the plan's assumptions are stale.
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation.
- **Step 3**: removing `subscribe: true` from the modern capability set breaks
  `__tests__/subscriptions-listen.test.ts`. That would confirm the SDK gates
  outbound `notifications/resources/updated` on the same capability bit, as the
  comment at [`server.ts:100-103`](../../../src/server.ts#L100-L103) claims. Do
  not restore the capability to make the test pass — report it as an SDK issue
  to file, and leave Step 3 reverted.
- **Step 11**: any tool that stops publishing `outputSchema` also stops
  returning `structuredContent`, or the SDK refuses to register a tool without
  one. The spec's rule runs the other way (a published schema obliges
  conforming output, not vice versa), so an SDK that requires the field is a
  bug worth reporting rather than working around.
- **Step 16**: the SDK's per-request server factory does not expose the
  validated `authInfo` before the factory runs. Do not re-parse the
  `Authorization` header as a fallback.
- **Phase E**: no recorded owner confirmation of a major-version bump. Report
  Phases A–D (and F, if done) complete and stop.
- The fix appears to require a file on the
  [out-of-scope list](#scope).
- The measured `tools/list` size after Phase D exceeds 23,000 characters. That
  means output schemas are still being published for more than the three tools
  Step 11 names, and the exemption list — not the budget — is wrong.

## Notes

- **What a reviewer should scrutinize.** Step 11 is the largest behavioral
  change to the public surface: it removes a field clients **SHOULD** validate
  against. Confirm the three exempted tools are the right three by reading what
  each returns, not by trusting the list. Step 16 is a security fix — confirm
  the new test actually fails when the `contexts` map is collapsed back to a
  singleton, or it proves nothing.
- **Deliberately deferred.** The audit's "one architectural change worth a
  rewrite" is not in this plan: moving access grants from mutable server state
  to a request-carried, HMAC-sealed capability, riding the
  [`requestStateCodec`](../../../src/core/input-required.ts#L118) that already
  binds `{op, paths}` and verifies on every round. Step 16 is the bounded fix
  that closes the leak; the rewrite is the correct end state and deserves its
  own spec.
- **Also deferred.** The SDK injects `tools.listChanged: true` despite
  `tools: {}` in the config, inviting clients to open a listen stream for a
  notification this server never sends. One round-trip in cost, and it is
  SDK-owned.
- **Rollback.** Every step is a source change with no migration and no
  persisted state. `git revert` the commit, or for a single step:
  `git checkout 528760ea -- <the step's files>` then re-run
  `node scripts/tasks.mjs`. Step 8 (`$defs` hoist) and Step 17 (rate limiter)
  are independent of everything else and revert cleanly on their own. Steps 13
  and 14 remove tools from the public surface — reverting them after a release
  requires another version bump, not just a code revert.
