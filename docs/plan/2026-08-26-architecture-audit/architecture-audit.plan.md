# Plan: Land the four architecture-audit findings

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `2fb2de7c`, 2026-08-26.
> **Drift check (run first)**: `git diff --stat 2fb2de7c..HEAD -- src knip.json __tests__`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

An architecture audit of this server produced four findings. This plan lands
all four.

The largest is a dead gate: `knip.json` declares every source file as its own
entry point, so the `knip` run wired into `check:static` can never report an
unused export. It reports 0 today; with a correct entry set it reports 27 in
`src/` — one fully dead function and 26 `export` keywords on symbols nothing
outside their own module references. The other three are a cross-zone import
edge around the file-watcher lease protocol, a 25-line context builder that
hand-copies its own input, and a four-interface prompt registry serving one
prompt.

When this lands: `knip` catches the next dead export instead of reporting
green, the transport layer stops importing a helper out of a data-layer
registrar, and roughly 150 lines are gone with no behavior change.

Requirements covered: none, this is a cleanup of audit findings.

## Current state

### Finding 1 — knip entry glob voids its own check

[`knip.json`](../../../knip.json) in full, all five lines:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["src/**/*.ts"],
  "project": ["src/**/*.ts"]
}
```

`entry` and `project` are the same glob, so every file is an entry point and
no export is ever unreachable. `knip` runs inside `check:static`
([`package.json:43`](../../../package.json#L43)) and therefore inside every
`node scripts/tasks.mjs`.

Two facts verified against this commit by running both configs:

- Current config: `npx knip` prints nothing (0 findings).
- Entry narrowed to `["__tests__/**/*.test.ts"]`, project left at
  `["src/**/*.ts"]`: 27 findings in `src/`, listed in
  [Step 4](#4-narrow-the-27-over-wide-module-surfaces).

`tsconfig.json` sets `"noUnusedLocals": true`
([`tsconfig.json:30`](../../../tsconfig.json#L30)) and `"noEmitOnError": true`
([`tsconfig.json:37`](../../../tsconfig.json#L37)). This is load-bearing for
Step 4: dropping `export` from a symbol that genuinely has no references turns
it into a `TS6133` build error naming the symbol, so the build tells you which
of the 27 must be deleted rather than un-exported.

The only fully dead symbol is
[`linkToInstructions`](../../../src/instructions.ts#L90), at
[`instructions.ts:90-99`](../../../src/instructions.ts#L90-L99):

```ts
export function linkToInstructions(uri: string = INSTRUCTIONS_URI): PromptMessage {
  const content: ResourceLink = {
    type: 'resource_link',
    uri,
    name: 'filesystem-mcp-instructions',
    mimeType: 'text/markdown',
    annotations: { audience: ['assistant'], priority: 0.5 },
  };
  return { role: 'user', content };
}
```

Its only reference anywhere is this declaration. It is the sole consumer of the
`PromptMessage` and `ResourceLink` type imports at
[`instructions.ts:1`](../../../src/instructions.ts#L1).

Two shapes in the 27 are not plain `export function` / `export const` and need
their own handling:

[`path.ts:20`](../../../src/core/path.ts#L20) and
[`path.ts:29-31`](../../../src/core/path.ts#L29-L31) — a re-export barrel where
5 of the 7 names have no consumer:

```ts
import { isSafeGlobSyntax } from './glob.js';
...
export { getReservedDeviceNameForPath, isSafeGlobSyntax, isWindowsDriveRelativePath };

export { IS_WINDOWS, isSlash, toPosixPath, findProjectRoot };
```

`isSlash` and `toPosixPath` are the two live ones — consumed via `./path.js` by
[`path-completer.ts:7-14`](../../../src/core/path-completer.ts#L7-L14).
`isSafeGlobSyntax` is imported at
[`path.ts:20`](../../../src/core/path.ts#L20) **only** to be re-exported, so
deleting it from the `export {}` list without also deleting the import produces
`src/core/path.ts(20,1): error TS6133`.

[`read.ts:127`](../../../src/tools/read.ts#L127) — a standalone re-export
statement, not an `export` modifier:

```ts
export { ReadFileInputSchema };
```

### Finding 2 — the watcher-lease ladder lives in a registrar

The one correct sequencing of the watcher state machine is
[`attachFileWatcherForUri`](../../../src/resources.ts#L215) at
[`resources.ts:215-280`](../../../src/resources.ts#L215-L280), together with
[`warnWatcherCap`](../../../src/resources.ts#L173) at
[`resources.ts:173-175`](../../../src/resources.ts#L173-L175) and the
[`WatcherAttachResult`](../../../src/resources.ts#L183) type at
[`resources.ts:177-186`](../../../src/resources.ts#L177-L186). Every line of it
manipulates the registry created in
[`watcher-registry.ts`](../../../src/core/watcher-registry.ts):

```ts
export async function attachFileWatcherForUri(
  registry: WatcherRegistry,
  pathGuard: PathGuard,
  uri: string,
  notify: (uri: string) => void,
  { markSubscribe = false }: { markSubscribe?: boolean } = {},
): Promise<WatcherAttachResult> {
```

It has two consumers in two different layers. The data-layer one is
[`resources.ts:358-360`](../../../src/resources.ts#L358-L360):

```ts
      const result = await attachFileWatcherForUri(registry, options.pathGuard, uri, notify, {
        markSubscribe: true,
      });
```

The transport-layer one imports it back out of the registrar, at
[`transport/shared.ts:10`](../../../src/transport/shared.ts#L10):

```ts
import { attachFileWatcherForUri } from '../resources.js';
```

and, having no name for the ladder's result type, derives it structurally at
[`shared.ts:59-68`](../../../src/transport/shared.ts#L59-L68):

```ts
function watcherFailureMessage(
  uri: string,
  result: Exclude<Awaited<ReturnType<typeof attachFileWatcherForUri>>, { ok: true }>,
): string {
```

The MCP architecture spec places this concern in the data layer — "the client
opens a long-lived `subscriptions/listen` stream naming the notification types
it wants" — and states that "conceptually the data layer is the inner layer,
while the transport layer is the outer layer"
([architecture.md, rev 2026-07-28](https://modelcontextprotocol.io/docs/2026-07-28/learn/architecture.md)).
Outer-imports-inner is the right direction; what is wrong is that the inner
module holding the ladder is a *registrar* whose declared job is
[`registerResources`](../../../src/resources.ts#L654), not a shared core module.

**A constraint the executor has not read.** Commit `50c02de8`
("refactor(watcher): give the attach ladder one owner") deliberately chose
`resources.ts` as the ladder's owner. Its message:

> `attachFileWatcherForUri` and `createFilesystemResource.subscribe` ran the
> same hasWatcher -> isAtCap -> extractPath -> validate -> re-check -> attach
> sequence in two copies that had already drifted. Keep one ladder, returning
> an outcome instead of a leg-specific value, and let `subscribe` map that
> outcome onto its own throw/reject/undefined contract.

That decision is preserved by this plan — one ladder, one owner. Only the
owner changes, from the registrar to the module holding the state it sequences.

**What must NOT change.** The registry's raw primitives stay public.
[`__tests__/resources.test.ts:282-426`](../../../__tests__/resources.test.ts#L282-L426)
drives nine of them directly — `addCallback`, `attach`, `retain`, `isStale`,
`startSubscribe`, `isAtCap` — to test the state machine in isolation, at a
level `acquire` cannot reach. Example, at
[`resources.test.ts:287-296`](../../../__tests__/resources.test.ts#L287-L296):

```ts
      registry.addCallback(testUri, (uri) => {
        notifications.push(uri);
      });

      const attached = registry.attach(testUri, testFile);
      assert.strictEqual(attached, true);
      assert.strictEqual(registry.hasWatcher(testUri), true);
      assert.strictEqual(registry.isStale(testUri), false);
```

Making them private is a separate change that needs those tests rewritten
first. It is out of scope here — see [Notes](#notes).

### Finding 3 — `buildExecutionCtx` hand-copies its input

[`define.ts:192-216`](../../../src/tools/define.ts#L192-L216) takes a `ToolCtx`
and returns a `ToolCtx`, re-listing all thirteen fields:

```ts
function buildExecutionCtx(
  ctx: ToolCtx,
  signal: AbortSignal,
  onProgress: (p: { current: number; total?: number }) => void,
): ToolCtx {
  return {
    signal,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.authInfo ? { authInfo: ctx.authInfo } : {}),
    ...(ctx._meta ? { _meta: ctx._meta } : {}),
    fs: ctx.fs,
    resourceStore: ctx.resourceStore,
    ...(ctx.server ? { server: ctx.server } : {}),
    log: (level: LoggingLevel, data: unknown, logger?: string) => {
      const msg = typeof data === 'string' ? data : String(data);
      const prefix = logger ? `[${logger}] ` : '';
      Logger.emit(level, `${prefix}${msg}`);
    },
    ...(ctx.sendNotification ? { sendNotification: ctx.sendNotification } : {}),
    onProgress,
    inputResponses: ctx.inputResponses,
    requestState: ctx.requestState,
    ...(ctx.clientCapabilities ? { clientCapabilities: ctx.clientCapabilities } : {}),
  };
}
```

It adds exactly three things — `log`, `onProgress`, and a replacement `signal`.
The nine conditional spreads exist to satisfy `exactOptionalPropertyTypes`
([`tsconfig.json:28`](../../../tsconfig.json#L28)); an object spread of `ctx`
preserves the same absent-vs-`undefined` distinction without them.

One call site, at
[`define.ts:287-289`](../../../src/tools/define.ts#L287-L289):

```ts
    this.toolCtx = buildExecutionCtx(ctx, this.signal, (p) => {
      this.#tick(p);
    });
```

`ctx` there is the constructor parameter of
[`ToolExecutor`](../../../src/tools/define.ts#L260), typed `ToolCtx` and
produced by [`toToolCtx`](../../../src/tools/define.ts#L146) at
[`define.ts:444`](../../../src/tools/define.ts#L444). `toToolCtx` never sets
`log` or `onProgress`, so the spread cannot shadow a caller's value.

### Finding 4 — a four-interface registry for one prompt

[`prompts.ts`](../../../src/prompts.ts) declares
[`PromptContract`](../../../src/prompts.ts#L23),
[`PromptRegistrationOptions`](../../../src/prompts.ts#L34) and
[`PromptEntry`](../../../src/prompts.ts#L40), then iterates a one-element array
at [`prompts.ts:144-158`](../../../src/prompts.ts#L144-L158):

```ts
const PROMPT_ENTRIES: PromptEntry[] = [GET_HELP];

export function registerPrompts(deps: PromptRegistrarDeps): void {
  const sections = buildSectionsRecord(deps.readOnly ?? false);
  const options = {
    sections,
    instructions: renderSections(sections),
    instructionsUri: INSTRUCTIONS_URI,
  };
  for (const { register } of PROMPT_ENTRIES) {
    register(deps.server, options);
  }
}

export { PROMPT_ENTRIES };
```

`options.instructionsUri` is declared at
[`prompts.ts:37`](../../../src/prompts.ts#L37), written at
[`prompts.ts:151`](../../../src/prompts.ts#L151), and read nowhere — the only
`register` implementation,
[`GET_HELP.register`](../../../src/prompts.ts#L106), uses `options.sections` and
`options.instructions` only. `INSTRUCTIONS_URI` is imported at
[`prompts.ts:17`](../../../src/prompts.ts#L17) solely to fill it, so deleting
the field without also deleting that import name produces a `TS6133`.

`PROMPT_ENTRIES` is exported for exactly one consumer,
[`prompts.test.ts:39`](../../../__tests__/prompts.test.ts#L39):

```ts
    it('TC-FUNC-067: PROMPT_ENTRIES and client.listPrompts() return the get-help prompt', async () => {
      assert.equal(PROMPT_ENTRIES.length, 1);

      const promptsList = await harness.client.listPrompts();
      const promptNames = promptsList.prompts.map((p) => p.name);
      assert.deepEqual(promptNames, ['get-help']);
```

The `deepEqual` on the next lines already asserts what the `length` check
asserts, over the live wire rather than the module.

### Conventions to match

- **Comment style.** Non-obvious decisions carry a prose comment explaining the
  *why*, not the *what* — imitate
  [`watcher-registry.ts:53-57`](../../../src/core/watcher-registry.ts#L53-L57)
  and [`shared.ts:43-45`](../../../src/transport/shared.ts#L43-L45). Moved code
  keeps its existing comments verbatim.
- **Imports.** Sorted by `@trivago/prettier-plugin-sort-imports`; run
  `npm run format` rather than hand-ordering. Node built-ins must use the
  `node:` protocol
  ([`eslint.config.mjs:92-98`](../../../eslint.config.mjs#L92-L98)).
- **Type imports** are separate statements (`import type { X } from ...`), per
  `@typescript-eslint/consistent-type-imports` with
  `fixStyle: 'separate-type-imports'`
  ([`eslint.config.mjs:124-130`](../../../eslint.config.mjs#L124-L130)).
- **Registrar boundary.** `src/prompts.ts`, `src/resources.ts` and
  `src/tools/**` must not import `src/server.ts` — enforced by the
  `project/registrar-boundaries` block at
  [`eslint.config.mjs:160-177`](../../../eslint.config.mjs#L160-L177). Nothing
  in this plan adds such an import.

## Commands

Verified against `2fb2de7c` before this plan was written. Run from the repo
root.

| Purpose         | Command                      | Expected on success                         |
| --------------- | ---------------------------- | ------------------------------------------- |
| Static checks   | `node scripts/tasks.mjs --quick` | exit 0; last line `All matched files use Prettier code style!` |
| Tests           | `node scripts/tasks.mjs test`    | exit 0; `pass 222`, `fail 0`                |
| Full check      | `node scripts/tasks.mjs`         | exit 0 (static checks then tests)           |
| Format + lint   | `node scripts/tasks.mjs fix`     | exit 0                                      |
| Build only      | `npm run build`                  | exit 0, no `error TS` lines                 |
| Dead exports    | `npx knip --no-progress`         | no `Unused exports` section                 |

Baseline at `2fb2de7c`: `--quick` passes, `test` reports `tests 222 / pass 222
/ fail 0` in about 9 seconds.

## Scope

**In scope** — the only files to modify:

- [`knip.json`](../../../knip.json)
- [`src/instructions.ts`](../../../src/instructions.ts)
- [`src/prompts.ts`](../../../src/prompts.ts)
- [`src/resources.ts`](../../../src/resources.ts)
- [`src/cli.ts`](../../../src/cli.ts)
- [`src/core/cursor.ts`](../../../src/core/cursor.ts)
- [`src/core/errors.ts`](../../../src/core/errors.ts)
- [`src/core/glob.ts`](../../../src/core/glob.ts)
- [`src/core/input-required.ts`](../../../src/core/input-required.ts)
- [`src/core/mime.ts`](../../../src/core/mime.ts)
- [`src/core/observability.ts`](../../../src/core/observability.ts)
- [`src/core/path.ts`](../../../src/core/path.ts)
- [`src/core/schema.ts`](../../../src/core/schema.ts)
- [`src/core/util.ts`](../../../src/core/util.ts)
- [`src/core/watcher-registry.ts`](../../../src/core/watcher-registry.ts)
- [`src/tools/define.ts`](../../../src/tools/define.ts)
- [`src/tools/read.ts`](../../../src/tools/read.ts)
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts)
- [`src/transport/shared.ts`](../../../src/transport/shared.ts)
- [`__tests__/prompts.test.ts`](../../../__tests__/prompts.test.ts) — Step 2 only

**Files out of scope** — leave alone even though they look related:

- [`src/transport/http.ts`](../../../src/transport/http.ts) — it uses only
  `hasWatcher`, `size`, `release` and `destroy`, all of which keep their
  signatures through Step 3. If this file needs an edit, the Step 3 move went
  wrong.
- [`src/transport/stdio.ts`](../../../src/transport/stdio.ts) — same reason; it
  touches only `createWatcherRegistry` and `destroy`.
- [`src/http-policy.ts`](../../../src/http-policy.ts) — the audit noted it sits
  outside `src/transport/` where the spec puts authorization, but a pure file
  move deletes nothing and is not worth the import churn. Deliberately deferred.
- [`__tests__/resources.test.ts`](../../../__tests__/resources.test.ts) — its
  registry-primitive tests at lines 282-426 are the reason those primitives stay
  public. Changing them turns this plan into the larger refactor it is scoped to
  avoid.
- [`package.json`](../../../package.json) — the `./transport` subpath export and
  the `check:static` script are both correct as they stand.
- [`src/tools/index.ts`](../../../src/tools/index.ts) — the tool inventory is
  well-owned; none of the four findings touch it.
- `dist/`, `node_modules/`, `logs/` — build output and dependencies.

## Steps

Ordered so the build passes between every pair. Steps 1-3 change what modules
export, so the export-surface work in Steps 4-5 must come last or its list goes
stale.

### 1. Replace `buildExecutionCtx` with a spread

In [`src/tools/define.ts`](../../../src/tools/define.ts):

1. Delete the whole of
   [`buildExecutionCtx`](../../../src/tools/define.ts#L192-L216), lines 192-216.
2. Replace the call at
   [`define.ts:287-289`](../../../src/tools/define.ts#L287-L289) with an inline
   object. Target shape:

```ts
    this.toolCtx = {
      ...ctx,
      signal: this.signal,
      log: (level: LoggingLevel, data: unknown, logger?: string) => {
        const msg = typeof data === 'string' ? data : String(data);
        const prefix = logger ? `[${logger}] ` : '';
        Logger.emit(level, `${prefix}${msg}`);
      },
      onProgress: (p) => {
        this.#tick(p);
      },
    };
```

Leave the `LoggingLevel` and `Logger` imports in place — `LoggingLevel` is still
named by [`ToolCtx.log`](../../../src/tools/define.ts#L53) and `Logger` is used
by [`resolveProgressCtx`](../../../src/tools/define.ts#L226).

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, then
`node scripts/tasks.mjs test` → `pass 222`, `fail 0`.

### 2. Inline the single prompt

In [`src/prompts.ts`](../../../src/prompts.ts):

1. Delete the [`PromptRegistrationOptions`](../../../src/prompts.ts#L34) and
   [`PromptEntry`](../../../src/prompts.ts#L40) interfaces. Keep
   [`PromptContract`](../../../src/prompts.ts#L23) — it is the parameter type of
   [`wrapHandler`](../../../src/prompts.ts#L78), which stays.
2. Replace the `GET_HELP` entry object
   ([`prompts.ts:100-142`](../../../src/prompts.ts#L100-L142)), the
   `PROMPT_ENTRIES` array
   ([`prompts.ts:144`](../../../src/prompts.ts#L144)), the loop inside
   `registerPrompts` and the `export { PROMPT_ENTRIES };` line
   ([`prompts.ts:158`](../../../src/prompts.ts#L158)) with a flat
   `registerPrompts`. Keep a bare contract const so `wrapHandler` still has
   something to pass to `getDisplayName`. Target shape:

```ts
const GET_HELP: PromptContract = {
  name: 'get-help',
  title: 'Get Help',
  description: INSTRUCTIONS_SUMMARY,
};

export function registerPrompts(deps: PromptRegistrarDeps): void {
  const sections = buildSectionsRecord(deps.readOnly ?? false);
  const instructions = renderSections(sections);
  const topics = Object.keys(sections);

  deps.server.registerPrompt(
    GET_HELP.name,
    {
      title: GET_HELP.title,
      description: GET_HELP.description,
      argsSchema: z.strictObject({
        topic: topicArg(
          topics,
          `Section key to filter instructions (one of: ${topics.join(', ')}); omit to return all instructions.`,
        ).optional(),
      }),
    },
    ({ topic }: { topic?: string | undefined }): GetPromptResult | Promise<GetPromptResult> =>
      wrapHandler(GET_HELP, () => {
        const lowerTopic = topic?.toLowerCase();
        const section =
          lowerTopic && Object.hasOwn(sections, lowerTopic) ? sections[lowerTopic] : undefined;
        if (topic && !section) {
          Logger.debug('get-help: unknown topic requested', { topic });
        }
        const text =
          section ??
          (topic
            ? `Section '${topic}' not found. Available: ${topics.join(', ')}\n\n${instructions}`
            : instructions);
        return {
          description: GET_HELP.description,
          messages: [userText(text)],
        };
      }),
  );
}
```

The handler body above is
[`prompts.ts:122-138`](../../../src/prompts.ts#L122-L138) with three
substitutions applied, not two — `options.sections` → `sections`,
`options.instructions` → `instructions`, and **`GET_HELP.contract.` →
`GET_HELP.`**. The last one matters:
[`prompts.ts:136`](../../../src/prompts.ts#L136) currently reads
`description: GET_HELP.contract.description,` and the new `GET_HELP` is a flat
`PromptContract` with no `contract` member. Copy the block above verbatim rather
than re-deriving it from the old lines.

3. Drop `INSTRUCTIONS_URI` from the import at
   [`prompts.ts:14-19`](../../../src/prompts.ts#L14-L19). It was there only to
   fill the deleted `instructionsUri` field; leaving it produces a `TS6133`.
   `buildSectionsRecord`, `INSTRUCTIONS_SUMMARY` and `renderSections` all stay.

In [`__tests__/prompts.test.ts`](../../../__tests__/prompts.test.ts):

4. Delete the import at
   [`prompts.test.ts:7`](../../../__tests__/prompts.test.ts#L7) and the
   `assert.equal(PROMPT_ENTRIES.length, 1);` line at
   [`prompts.test.ts:39`](../../../__tests__/prompts.test.ts#L39). Rename the
   case to `'TC-FUNC-067: client.listPrompts() returns the get-help prompt'`.
   Leave the rest of the assertions untouched — the `deepEqual` at
   [`prompts.test.ts:43`](../../../__tests__/prompts.test.ts#L43) is the
   stronger check.

**Verify**: `node scripts/tasks.mjs test` → `pass 222`, `fail 0`. The count must
still be 222: nothing is added or removed, only one assertion inside an existing
case.

### 3. Move the watcher-lease ladder into the registry

Give the attach ladder the same owner as the state it sequences, and cut the
transport-to-registrar import.

In
[`src/core/watcher-registry.ts`](../../../src/core/watcher-registry.ts):

1. Add imports for [`PathGuard`](../../../src/core/path.ts#L297) (type-only,
   from `./path.js`) and
   [`extractPath`](../../../src/core/file-uri.ts#L51) (from `./file-uri.js`).
   Both are acyclic: `file-uri.ts` has no intra-package imports at all, and
   `path.ts` imports neither.
2. Move [`WatcherAttachResult`](../../../src/resources.ts#L183) and its doc
   comment ([`resources.ts:177-186`](../../../src/resources.ts#L177-L186)) here
   verbatim, and export it.
3. Move [`warnWatcherCap`](../../../src/resources.ts#L173) here as a
   module-level function.
4. Move the body of
   [`attachFileWatcherForUri`](../../../src/resources.ts#L215-L280) into the
   `createWatcherRegistry` closure as a new `acquire` method on the returned
   object, dropping the `registry` parameter and calling the closure's own
   helpers directly. Keep every existing comment. Add `acquire` to the returned
   object literal alongside the current members — **do not remove any existing
   member**; see [Scope](#scope). Target signature:

```ts
    /**
     * The one attach ladder both watcher entry points run. (Keep the full
     * doc comment from resources.ts:188-214 here.)
     */
    async acquire(
      pathGuard: PathGuard,
      uri: string,
      notify: (uri: string) => void,
      { markSubscribe = false }: { markSubscribe?: boolean } = {},
    ): Promise<WatcherAttachResult> {
```

Inside the moved body, `registry.hasWatcher(uri)` becomes `watchers.has(uri)`,
`registry.isAtCap()` becomes `watchers.size >= MAX_WATCHERS`, and the rest
resolve to the closure locals already defined above the `return` — except
`addCallback`, `retain`, `attach`, `startSubscribe`, `cancelSubscribe` and
`isStale`, which are currently defined *inside* the returned object literal. Do
not restructure them: reach them through a `self` alias captured before the
return, or hoist each to a `const` above the return and reference it from both
places. Either is fine; hoisting is the smaller diff for `attach` and
`addCallback` and leaves the public surface identical.

In [`src/resources.ts`](../../../src/resources.ts):

5. Delete `warnWatcherCap`, `WatcherAttachResult` and `attachFileWatcherForUri`
   (lines 173-280).
6. Change the call at
   [`resources.ts:358-360`](../../../src/resources.ts#L358-L360) to:

```ts
      const result = await registry.acquire(options.pathGuard, uri, notify, {
        markSubscribe: true,
      });
```

The branch handling below it
([`resources.ts:361-384`](../../../src/resources.ts#L361-L384)) is unchanged —
it still reads `result.ok`, `result.reason` and `result.error`.

7. Fix the imports: `MAX_WATCHERS` is still used at
   [`resources.ts:609`](../../../src/resources.ts#L609); `extractPath` is still
   used at [`resources.ts:321`](../../../src/resources.ts#L321). Drop whatever
   the build reports as newly unused.

In [`src/transport/shared.ts`](../../../src/transport/shared.ts):

8. Replace the `../resources.js` import at
   [`shared.ts:10`](../../../src/transport/shared.ts#L10) with
   `import type { WatcherAttachResult } from '../core/watcher-registry.js';`
   (merge it into the existing `../core/watcher-registry.js` import at
   [`shared.ts:9`](../../../src/transport/shared.ts#L9) if the formatter
   prefers).
9. Simplify the `result` parameter of
   [`watcherFailureMessage`](../../../src/transport/shared.ts#L59) from the
   `Exclude<Awaited<ReturnType<...>>>` form to
   `Exclude<WatcherAttachResult, { ok: true }>`.
10. Change the call at
    [`shared.ts:83`](../../../src/transport/shared.ts#L83) to
    `await registry.acquire(pathGuard, uri, notify)`.

Leave `WATCHER_FAILURE_REASONS`
([`shared.ts:52-57`](../../../src/transport/shared.ts#L52-L57)) and
`prepareListenWatchers` where they are — that phrasing and the all-or-nothing
batch policy are the transport's, and `resources.ts` does not use them.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, then
`node scripts/tasks.mjs test` → `pass 222`, `fail 0`. The subscription suites
are the real gate here: `__tests__/subscriptions-listen.test.ts` (13 cases),
`__tests__/resources-subscribe.test.ts` (3 cases) and
`__tests__/http-shared-guard.test.ts` (2 cases) must all pass.

Then confirm the cross-zone edge is gone:

`git grep -n "from '../resources.js'" -- src/transport` → no output.

### 4. Narrow the 27 over-wide module surfaces

Drop `export` from each symbol below. All 27 were verified against `2fb2de7c`
as having zero references outside their own file. Working rule for each: if the
build then reports `TS6133 'X' is declared but its value is never read`, the
symbol is fully dead — delete it rather than un-export it.

| File                            | Symbols                                                          |
| ------------------------------- | ---------------------------------------------------------------- |
| `src/cli.ts`                    | `normalizeAndValidateDirs`, `ENV_HELP`, `CLI_PARSER_CONFIG`      |
| `src/core/cursor.ts`            | `encodeOffsetCursor`, `decodeOffsetCursor`                       |
| `src/core/errors.ts`            | `PerFileError`, `resolveSuggestion`, `zodErrorToProblem`, `classify`, `isAbortError` |
| `src/core/glob.ts`              | `buildHiddenPatterns`                                            |
| `src/core/input-required.ts`    | `PendingOp`                                                      |
| `src/core/mime.ts`              | `MimeKind`                                                       |
| `src/core/observability.ts`     | `getLogLevel`, `isLevelEnabled`                                  |
| `src/core/path.ts`              | `resolveAllowedDirectoriesState`, plus the barrel edit below     |
| `src/core/schema.ts`            | `FILE_TYPES`, `FILE_KINDS`                                       |
| `src/core/util.ts`              | `parseIntSetting`                                                |
| `src/tools/replace-in-files.ts` | `createRegexReplacementMatcher`                                  |

Three entries need a different edit:

1. **`src/instructions.ts`** — delete
   [`linkToInstructions`](../../../src/instructions.ts#L90-L99) outright (it has
   no internal reference), and delete the now-orphaned type import at
   [`instructions.ts:1`](../../../src/instructions.ts#L1):
   `import type { PromptMessage, ResourceLink } from '@modelcontextprotocol/server';`.
   Edit those lines in place — do not rewrite the file, which would change its
   line endings and produce a whole-file diff.

2. **`src/core/path.ts`** — delete the barrel line at
   [`path.ts:29`](../../../src/core/path.ts#L29) entirely, narrow
   [`path.ts:31`](../../../src/core/path.ts#L31) to
   `export { isSlash, toPosixPath };`, and **also delete the now-unused import**
   at [`path.ts:20`](../../../src/core/path.ts#L20)
   (`import { isSafeGlobSyntax } from './glob.js';`). Skipping that last part
   produces `src/core/path.ts(20,1): error TS6133`. Update the stale sentence in
   the comment at [`path.ts:33-36`](../../../src/core/path.ts#L33-L36), which
   still claims the primitives are "re-exported here so existing call sites stay
   unchanged".

3. **`src/tools/read.ts`** — delete the standalone statement
   `export { ReadFileInputSchema };` at
   [`read.ts:127`](../../../src/tools/read.ts#L127). The local
   `type ReadFileInput` at
   [`read.ts:125`](../../../src/tools/read.ts#L125) still uses the schema, so no
   `TS6133` follows.

Then run `node scripts/tasks.mjs fix` to restore formatting — the barrel
deletions in `path.ts` leave blank-line runs that Prettier will collapse.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, then
`node scripts/tasks.mjs test` → `pass 222`, `fail 0`.

### 5. Fix the knip entry set

Replace [`knip.json`](../../../knip.json) with:

```json
{
  "$schema": "https://unpkg.com/knip@6/schema.json",
  "entry": ["__tests__/**/*.test.ts"],
  "project": ["src/**/*.ts"]
}
```

Two things this does. Naming the test files as entries makes every `src/` export
a test reaches count as used, so a test-only export is not reported. Leaving
`project` at `src/**/*.ts` keeps knip out of `__tests__` internals, where five
helper exports are unused and are not this plan's business. The `src/index.ts`
and `src/transport.ts` entries need no declaration — knip reads them from
`package.json`'s `bin` and `exports` fields, and naming them explicitly makes it
emit a "Remove redundant entry pattern" hint.

If `npx knip` names any symbol Step 4 did not list, apply the same working rule:
references inside its own file means drop the `export`; no references at all
means delete it.

**Verify**: `npx knip --no-progress` → no `Unused exports` section. Then confirm
the check is actually live, rather than passing for the same reason it did
before:

```
printf '\nexport const KNIP_CANARY = 1;\n' >> src/core/util.ts
npx knip --no-progress
git checkout -- src/core/util.ts
```

Expected: knip reports `Unused exports (1)` naming `KNIP_CANARY` in
`src/core/util.ts`. If it reports nothing, the entry set is still wrong — this
is a STOP.

### 6. Full check

**Verify**: `node scripts/tasks.mjs` → exit 0, `pass 222`, `fail 0`, and no
`Unused exports` from the knip stage.

## Done

Machine-checkable. All must hold:

- [ ] `node scripts/tasks.mjs --quick` exits 0
- [ ] `node scripts/tasks.mjs test` exits 0 with `tests 222`, `pass 222`, `fail 0`
- [ ] `npx knip --no-progress` prints no `Unused exports` section
- [ ] The canary in [Step 5](#5-fix-the-knip-entry-set) makes knip report
      exactly one unused export, and `git checkout -- src/core/util.ts` restores
      a clean tree
- [ ] `git grep -n "from '../resources.js'" -- src/transport` returns nothing
- [ ] `git grep -n "buildExecutionCtx\|PROMPT_ENTRIES\|attachFileWatcherForUri\|linkToInstructions"`
      returns nothing
- [ ] `git status --porcelain -- src knip.json __tests__` lists no file outside
      the [in-scope list](#scope). Scoped to the source paths on purpose: an
      unscoped `git status` also reports this plan's own untracked `docs/` tree,
      which is not a source edit. Do not resolve that by committing the plan
      mid-run — the `git grep` check below searches tracked files, and a
      committed plan makes it match the plan's own prose.

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt. The most likely drifted files are
  [`src/resources.ts`](../../../src/resources.ts) and
  [`src/tools/define.ts`](../../../src/tools/define.ts) — both are high-churn
  (109 and 117 commits).
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation.
- The fix appears to require an out-of-scope file. In particular, if Step 3
  seems to need an edit in
  [`src/transport/http.ts`](../../../src/transport/http.ts) or
  [`src/transport/stdio.ts`](../../../src/transport/stdio.ts), the `acquire`
  move changed a signature it was not supposed to touch.
- Step 3 makes any test in
  [`__tests__/resources.test.ts`](../../../__tests__/resources.test.ts) fail.
  Those tests drive the registry primitives directly; a failure there means a
  member was made private or renamed, which this plan forbids.
- The test count moves off 222 at any step. No step adds or removes a test case.
- Step 5's canary does not reproduce — knip's entry resolution differs from what
  was verified here, and the rest of Step 5 rests on it.
- Any file-watcher test becomes intermittent rather than failing outright. The
  lease code is ref-counted and timing-sensitive; a flaky pass is not a pass.

## Notes

**What a reviewer should scrutinize.** Step 3 is the only step with real risk.
Read the moved ladder against
[`resources.ts:215-280`](../../../src/resources.ts#L215-L280) line by line: the
ordering of `startSubscribe` / `cancelSubscribe` around the `await` is
load-bearing, and the `stale` branch at
[`resources.ts:259`](../../../src/resources.ts#L259) is the one failure that
must *not* cancel the declaration. The existing comments explain each; they must
survive the move intact.

Steps 1, 2, 4 and 5 are mechanical and independently revertable.

**Verified before writing.** The Step 4 edit set and the Step 5 config were both
applied against `2fb2de7c` and run through `npm run build`, `npx eslint .` and
`node scripts/tasks.mjs test`: build clean, lint clean, `pass 222 / fail 0`,
knip 0 findings under the new config and 1 finding with the canary. The tree was
then reverted. Step 3 was **not** applied — it is specified from reading, not
from a trial run.

**Deliberately deferred.**

- Making the registry primitives (`addCallback`, `attach`, `retain`, `isStale`,
  `startSubscribe`, `cancelSubscribe`, `isAtCap`) private. That is the larger
  half of the audit's finding 2 — it collapses an 11-method public surface to
  five — but it requires rewriting
  [`__tests__/resources.test.ts:282-426`](../../../__tests__/resources.test.ts#L282-L426)
  against `acquire` first. Worth doing as its own change once Step 3 has settled.
- Moving [`src/http-policy.ts`](../../../src/http-policy.ts) under
  `src/transport/`, where the MCP spec puts authorization. A pure move deletes
  nothing.
- The five unused exports inside `__tests__` helper files
  (`helpers.ts:66`, `inspector-harness.ts:12,44,65`,
  `inspector-fixtures.ts:23`). Step 5's `project` scope excludes them by design.

**Rollback.** No migrations, no deletions of persisted data, no production
state. `git checkout -- .` at any point before commit; after commit,
`git revert` the step's commit. Committing each step separately is what makes
that useful.
