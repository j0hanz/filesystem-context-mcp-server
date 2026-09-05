# Plan: Delete the unreachable and single-implementation surface

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `0223af11`, 2026-09-05.
> **Hunted** 2026-09-05 — see [`trim-dead-surface.plan-hunt.md`](trim-dead-surface.plan-hunt.md).
> One confirmed defect (the scoped-test command) is fixed here; two candidates were killed.
> **Drift check (run first)**: `git diff --stat 0223af11..HEAD -- src/ __tests__/ scripts/ README.md package.json`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

An over-engineering audit found six pieces of this repo that cost maintenance
and buy nothing: a second test harness no CI job runs, a multi-instance "fleet"
deployment mode no CLI flag can reach, an interface with exactly one
implementation, a dead enum branch, an argument validator guarding a lookup that
already bounds itself, and 30 lines that rebuild an error message Node already
wrote.

Removing them deletes ~1,000 lines of source and script plus 37 KB of fixtures
with **no user-visible behavior change**: no tool signature, no wire format, no
CLI flag, and no environment variable is altered. The one public API that
narrows is the `./transport` export's `RuntimeConfig`, which loses two fields
that only a hypothetical multi-instance embedder could have set.

Requirements covered: none, this is a cleanup.

## Current state

### Facts common to every step

- Build, lint, format, and knip all pass at `0223af11`. Knip's entry points are
  `__tests__/**/*.test.ts` ([`knip.json`](../../../knip.json)), so **an export
  whose last consumer this plan deletes becomes a knip failure**. Step 6 depends
  on that; watch for it everywhere.
- Test baseline: `275 pass, 0 fail, 65 suites`.
- Prettier runs in the check. Do not hand-format; if `prettier --check` fails,
  run `npm run format`.

### 1. The QA harness

[`scripts/qa.mjs`](../../../scripts/qa.mjs) (665 lines) spawns the MCP Inspector
CLI against `dist/index.js` and writes a timestamped report;
[`scripts/qa-report.mjs`](../../../scripts/qa-report.mjs) (205 lines) renders it
as HTML; [`scripts/qa-cases/`](../../../scripts/qa-cases) holds six JSON case
files totalling 37 KB.

It duplicates [`__tests__/inspector-harness.ts`](../../../__tests__/inspector-harness.ts),
and says so at [`qa.mjs:34-36`](../../../scripts/qa.mjs#L34-L36):

```js
 * Absolute path to the Inspector CLI entry, resolved through its own bin field.
 * `__tests__/inspector-harness.ts` duplicates this deliberately — this script
 * imports nothing from the test suite.
```

Nothing runs it. [`.github/workflows/ci.yml`](../../../.github/workflows/ci.yml)
ends with `- run: node scripts/tasks.mjs`, and
[`tasks.mjs`](../../../scripts/tasks.mjs) has exactly three commands —
`check`, `fix`, `test` — none of which reaches `qa`.

Its only two references in the repo:

- [`package.json:44`](../../../package.json#L44) — `"qa": "npm run build && node scripts/qa.mjs"`
- [`.gitignore:75`](../../../.gitignore#L75) — `reports/`, the output directory

### 2. Fleet mode

Two `RuntimeConfig` fields at [`transport/shared.ts:22-31`](../../../src/transport/shared.ts#L22-L31):

```ts
export interface RuntimeConfig {
  /** `--http-host` or `HTTP_HOST`. The HTTP bind defaults to loopback without it. */
  httpHost?: string;
  /** `--api-key` or `API_KEY`. Unset means open access (loopback dev mode). */
  apiKey?: string;
  /** Shared change-event bus for multi-instance HTTP deployments. Caller-owned. */
  eventBus?: ServerEventBus;
  /** Explicit topology; fleet mode requires shared state and event delivery. */
  deploymentMode?: 'single' | 'fleet';
}
```

Their consumers, [`transport/http.ts:286-297`](../../../src/transport/http.ts#L286-L297):

```ts
  const { apiKey, eventBus } = config;
  const fleet = config.deploymentMode === 'fleet';
  assertHttpBindingPolicy(httpHost, apiKey);
  if (fleet && !apiKey) {
    throw new Error('Fleet deployment mode requires an API key.');
  }
  if (fleet && !eventBus) {
    throw new Error('Fleet deployment mode requires a shared event bus.');
  }
  assertFleetRequestStateKey(fleet);
```

and [`transport/http.ts:340`](../../../src/transport/http.ts#L340), which passes
the bus to the SDK handler:

```ts
      ...(eventBus ? { bus: eventBus } : {}),
```

**Nothing sets either field.** [`index.ts:139-142`](../../../src/index.ts#L139-L142)
builds the only `RuntimeConfig` the shipped binary ever constructs:

```ts
  const runtimeConfig = {
    ...(httpHost !== undefined ? { httpHost } : {}),
    ...(cliApiKey !== undefined ? { apiKey: cliApiKey } : {}),
  };
```

The boot guard [`assertFleetRequestStateKey`](../../../src/core/input-required.ts#L113-L119):

```ts
export function assertFleetRequestStateKey(fleet: boolean): void {
  if (!fleet) return;
  if (!configuredRequestStateKey()) {
    throw new Error('FS_REQUEST_STATE_KEY must be >=32 bytes in fleet deployment mode.');
  }
  getRequestStateCodec();
}
```

> **`FS_REQUEST_STATE_KEY` itself stays.** It has a non-fleet purpose, stated at
> [`input-required.ts:68-80`](../../../src/core/input-required.ts#L68-L80): with
> it set, in-flight `input_required` rounds survive a restart. Only the fleet
> gate goes. Leave `configuredRequestStateKey`, `getRequestStateCodec`, and
> `requestStateCodec` untouched.

Test coverage to remove, all three blocks whole:

- [`http-server.test.ts:251-339`](../../../__tests__/http-server.test.ts#L251-L339) — `describe('explicit HTTP deployment mode')`, 5 tests
- [`input-required.test.ts:295-329`](../../../__tests__/input-required.test.ts#L295-L329) — `describe('assertFleetRequestStateKey (boot-time HTTP guard)')`, 4 tests
- [`subscriptions-listen.test.ts:354-384`](../../../__tests__/subscriptions-listen.test.ts#L354-L384) — `describe('HTTP resourcesListChanged injected bus')`, 1 test

That last block is the **only** caller of `bootHttpTest`'s third parameter
([`helpers.ts:293-308`](../../../__tests__/helpers.ts#L293-L308)):

```ts
export async function bootHttpTest(
  ...
  runtimeConfig: Omit<RuntimeConfig, 'apiKey'> = {},
```

> `InMemoryServerEventBus` at [`helpers.ts:223`](../../../__tests__/helpers.ts#L223)
> is **not** in scope. It lives inside `createTestHttpHarness`, is passed
> straight to `createMcpHandler`, and has nothing to do with `RuntimeConfig`.

Docs: [`README.md:411-469`](../../../README.md#L411-L469) is the
`#### Multi-instance HTTP deployments` section, ending at the blank line before
`### Examples` on line 470. [`README.md:409`](../../../README.md#L409) is the
`FS_REQUEST_STATE_KEY` table row, whose trailing clause names fleet mode.

### 3. `ProgressSink`

[`progress.ts:22-25`](../../../src/tools/progress.ts#L22-L25) declares it:

```ts
export interface ProgressSink {
  readonly name: string;
  readonly emit: (event: ProgressEvent) => Promise<void> | void;
}
```

[`McpProgressSink`](../../../src/tools/progress.ts#L155) is the only
implementation, in `src/` and in `__tests__/`. `ProgressSession` carries an
array of them ([`:30`](../../../src/tools/progress.ts#L30),
[`:40`](../../../src/tools/progress.ts#L40),
[`:51`](../../../src/tools/progress.ts#L51)), loops over it at
[`:111-115`](../../../src/tools/progress.ts#L111-L115), and wraps each call in
[`#emitGuarded:133-152`](../../../src/tools/progress.ts#L133-L152) — a try/catch
plus a promise-rejection handler, for an array that never holds more than one
element.

The single construction site, [`define.ts:285-296`](../../../src/tools/define.ts#L285-L296):

```ts
    const sinks: ProgressSink[] = [];
    if (ctx._meta?.progressToken !== undefined && ctx.sendNotification !== undefined) {
      this.#mcpSink = new McpProgressSink(toolName, ctx._meta.progressToken, ctx.sendNotification);
      sinks.push(this.#mcpSink);
    }
    const isTest = process.env['NODE_ENV'] === 'test' || process.execArgv.includes('--test');
    this.#progressSession = new ProgressSession({
      label: this.#progressCtx.label,
      sinks,
      ...(isTest ? { rateLimitMs: 0 } : {}),
    });
```

The one test construction, [`progress.test.ts:31-33`](../../../__tests__/progress.test.ts#L31-L33):

```ts
function session(sink: McpProgressSink): ProgressSession {
  return new ProgressSession({ label: 'label', sinks: [sink], rateLimitMs: 0 });
}
```

### 4. The dead `'start'` phase

[`fmt.ts:14`](../../../src/core/fmt.ts#L14) declares four phases:

```ts
export type Phase = 'start' | 'tick' | 'done' | 'fail';
```

`plainMessage` has exactly three call sites, all in `define.ts` — `'tick'`
([`:317`](../../../src/tools/define.ts#L317)), `'done'`
([`:340`](../../../src/tools/define.ts#L340)), `'fail'`
([`:345`](../../../src/tools/define.ts#L345)). Nothing emits `'start'`, so
[`fmt.ts:23-27`](../../../src/core/fmt.ts#L23-L27) is unreachable:

```ts
    case 'start':
      if (ctx.scope) {
        items.push(ctx.scope);
      }
      break;
```

> `ctx.scope` stays used — the `'done'` branch at
> [`fmt.ts:35-38`](../../../src/core/fmt.ts#L35-L38) reads it.

### 5. Prompt topic validation

[`prompts.ts:31-50`](../../../src/prompts.ts#L31-L50):

```ts
  return completable(
    z
      .string()
      .min(1, { message: 'Topic required' })
      .refine((val) => !isBlank(val), {
        message: 'Topic cannot be empty or whitespace-only',
      })
      .refine((val) => !SHELL_METACHAR_RE.test(val), {
        message: 'Topic contains prohibited characters (newlines or shell metacharacters)',
      })
      .describe(description),
```

The value is only ever a key lookup against a frozen record,
[`prompts.ts:116-118`](../../../src/prompts.ts#L116-L118):

```ts
        const lowerTopic = topic?.toLowerCase();
        const section =
          lowerTopic && Object.hasOwn(sections, lowerTopic) ? sections[lowerTopic] : undefined;
```

`Object.hasOwn` against a fixed key set is the real bound; a shell metacharacter
in a topic name reaches nothing that could interpret it. No test asserts either
rejection message.

> `isBlank` and `SHELL_METACHAR_RE` stay exported — [`schema.ts`](../../../src/core/schema.ts#L46-L48)
> and three tools still use them. Only the `prompts.ts` import goes.

### 6. The errno message rebuilder

[`cli.ts:54-85`](../../../src/cli.ts#L54-L85), two helpers ending in four
hand-built strings:

```ts
function getSystemErrorDetails(error: unknown): {
  code: string | undefined;
  errno: number | undefined;
} {
  if (!isRecord(error)) return { code: undefined, errno: undefined };
  ...
}

function normalizeDirectoryError(error: unknown, inputPath: string): Error {
  const { code, errno } = getSystemErrorDetails(error);
  ...
      return new Error(`Cannot access directory ${inputPath} (${name}: ${message})`);
```

Node's own error already carries all of it — `ENOENT: no such file or directory,
stat 'C:\x'`. One call site, [`cli.ts:107`](../../../src/cli.ts#L107):

```ts
    throw normalizeDirectoryError(error, inputPath);
```

`formatUnknownErrorMessage` is **already imported** at
[`cli.ts:8`](../../../src/cli.ts#L8).

Two knip consequences of the deletion:

- [`cli.ts:3`](../../../src/cli.ts#L3) — `getSystemErrorMessage` and `getSystemErrorName` become unused.
- [`primitives.ts:8-10`](../../../src/core/primitives.ts#L8-L10) — `isRecord`'s **only** repo-wide consumer is [`cli.ts:58`](../../../src/cli.ts#L58). The export must go with it or knip fails.

No test asserts on the string `Cannot access directory` from `cli.ts`; the only
other occurrence is an unrelated message in
[`path.ts:650`](../../../src/core/path.ts#L650).

## Commands

Run from the repo root.

| Purpose      | Command                                                     | Expected on success                                              |
| ------------ | ----------------------------------------------------------- | ---------------------------------------------------------------- |
| Static check | `node scripts/tasks.mjs --quick`                            | exit 0; last line `All matched files use Prettier code style!`   |
| Tests        | `node scripts/tasks.mjs test`                               | exit 0; `pass 265`, `fail 0` once step 2 lands (`275` before it) |
| Narrowed run | `node scripts/tasks.mjs test --test-name-pattern="<suite>"` | exit 0, `fail 0`; ~2.5s                                          |
| Auto-fix     | `node scripts/tasks.mjs fix`                                | exit 0 — use only if `prettier --check` fails                    |

> **Do not pass a file path to `test`.** The runner appends its own glob after
> your arguments ([`tasks.mjs:70-77`](../../../scripts/tasks.mjs#L70-L77)), so
> `node scripts/tasks.mjs test __tests__/progress.test.ts` runs all 275 tests,
> not that one file. `--test-name-pattern` is the supported narrowing, per the
> runner's own help at [`tasks.mjs:20`](../../../scripts/tasks.mjs#L20).

## Scope

**In scope** — the only files to modify or delete:

- [`scripts/qa.mjs`](../../../scripts/qa.mjs) — delete
- [`scripts/qa-report.mjs`](../../../scripts/qa-report.mjs) — delete
- [`scripts/qa-cases/`](../../../scripts/qa-cases) — delete, all six files
- [`package.json`](../../../package.json)
- [`src/transport/shared.ts`](../../../src/transport/shared.ts)
- [`src/transport/http.ts`](../../../src/transport/http.ts)
- [`src/core/input-required.ts`](../../../src/core/input-required.ts)
- [`src/tools/progress.ts`](../../../src/tools/progress.ts)
- [`src/tools/define.ts`](../../../src/tools/define.ts)
- [`src/core/fmt.ts`](../../../src/core/fmt.ts)
- [`src/prompts.ts`](../../../src/prompts.ts)
- [`src/cli.ts`](../../../src/cli.ts)
- [`src/core/primitives.ts`](../../../src/core/primitives.ts)
- [`README.md`](../../../README.md)
- [`__tests__/http-server.test.ts`](../../../__tests__/http-server.test.ts)
- [`__tests__/input-required.test.ts`](../../../__tests__/input-required.test.ts)
- [`__tests__/subscriptions-listen.test.ts`](../../../__tests__/subscriptions-listen.test.ts)
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts)
- [`__tests__/progress.test.ts`](../../../__tests__/progress.test.ts)

**Files out of scope** — leave alone even though they look related:

- [`.gitignore`](../../../.gitignore) — its `reports/` entry costs nothing and still catches stray local output.
- [`scripts/tasks.mjs`](../../../scripts/tasks.mjs) — never referenced `qa`; [`AGENTS.md`](../../../AGENTS.md) mandates it as the entry point.
- [`__tests__/inspector-*.test.ts`](../../../__tests__) and [`inspector-harness.ts`](../../../__tests__/inspector-harness.ts) — the harness that **survives** step 1. Deleting Inspector coverage is the opposite of the intent.
- [`src/core/schema.ts`](../../../src/core/schema.ts) — `isBlank` and `SHELL_METACHAR_RE` have three other consumers.
- [`src/tools/replace-in-files.ts`](../../../src/tools/replace-in-files.ts) — the audit flagged it, but removing a published tool is a wire-contract change and belongs in its own plan.
- [`src/core/config.ts`](../../../src/core/config.ts) and [`src/cli-help.ts`](../../../src/cli-help.ts) — the flag/env consolidation is a separate, user-visible change.
- [`src/core/path-completer.ts`](../../../src/core/path-completer.ts) — removing completion changes what a client sees.
- [`CHANGELOG.md`](../../../CHANGELOG.md) and [`server.json`](../../../server.json) — the Release workflow owns versions; see [`AGENTS.md`](../../../AGENTS.md).

## Steps

### 1. Delete the QA harness

Remove [`scripts/qa.mjs`](../../../scripts/qa.mjs),
[`scripts/qa-report.mjs`](../../../scripts/qa-report.mjs), and the whole
[`scripts/qa-cases/`](../../../scripts/qa-cases) directory:

```bash
git rm -r scripts/qa.mjs scripts/qa-report.mjs scripts/qa-cases
```

Then delete the `qa` entry from the `scripts` block of
[`package.json:44`](../../../package.json#L44). It is the last line of the
block, so also drop the trailing comma from the `tasks` line above it.

Touch no other script. `build`, `check`, `test`, `inspector`, and `tasks` all
stay.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0, ending `All matched files use Prettier code style!`
**Verify**: `git status --porcelain scripts/` → lists only deletions (`D` entries), no modifications.

### 2. Delete fleet mode

Five files plus the README.

**a.** [`transport/shared.ts`](../../../src/transport/shared.ts) — delete the
`eventBus` and `deploymentMode` fields from `RuntimeConfig`
([`:26-30`](../../../src/transport/shared.ts#L26-L30)) and the now-unused
`ServerEventBus` type import at
[`:5`](../../../src/transport/shared.ts#L5). `httpHost` and `apiKey` stay.

**b.** [`transport/http.ts`](../../../src/transport/http.ts) — at
[`:286-297`](../../../src/transport/http.ts#L286-L297), drop `eventBus` from the
destructure, drop the `fleet` constant, both `if (fleet && ...)` throws, and the
`assertFleetRequestStateKey(fleet)` call. `assertHttpBindingPolicy(httpHost, apiKey)`
stays. Target shape:

```ts
  const { apiKey } = config;
  assertHttpBindingPolicy(httpHost, apiKey);
```

At [`:340`](../../../src/transport/http.ts#L340), delete the
`...(eventBus ? { bus: eventBus } : {}),` spread. Delete the
`assertFleetRequestStateKey` import at
[`:22`](../../../src/transport/http.ts#L22).

**c.** [`core/input-required.ts`](../../../src/core/input-required.ts) — delete
`assertFleetRequestStateKey` and its doc comment
([`:104-119`](../../../src/core/input-required.ts#L104-L119)). In the surviving
`configuredRequestStateKey` doc comment
([`:68-80`](../../../src/core/input-required.ts#L68-L80)), remove the two
sentences describing the fleet failure mode and its guard; keep the sentences
about the per-process key and restart invalidation. Also retarget the comment at
[`:94-95`](../../../src/core/input-required.ts#L94-L95) — it currently explains
lazy construction as letting `startHttpServer` enforce the fleet key first,
which will no longer be true; state that the codec is built on first use so an
unset env var costs nothing at import.

**d.** Tests — delete all three blocks named in
[Current state](#2-fleet-mode), whole, with their `describe` wrappers. Then
clean up what they leave behind:

- [`http-server.test.ts:1`](../../../__tests__/http-server.test.ts#L1) — drop `InMemoryServerEventBus` from the import, keep `ProtocolErrorCode`.
- [`input-required.test.ts:8`](../../../__tests__/input-required.test.ts#L8) — drop `assertFleetRequestStateKey` from the import list.
- [`subscriptions-listen.test.ts:3`](../../../__tests__/subscriptions-listen.test.ts#L3) — drop `InMemoryServerEventBus` — its only use is at [`:359`](../../../__tests__/subscriptions-listen.test.ts#L359), inside the deleted block.
- [`helpers.ts:293-308`](../../../__tests__/helpers.ts#L293-L308) — delete `bootHttpTest`'s third parameter and spread it no longer needs; the call becomes `{ apiKey: TEST_API_KEY }`. Drop the `RuntimeConfig` type import at [`:25`](../../../__tests__/helpers.ts#L25) if nothing else in the file uses it. Leave `createTestHttpHarness` and its `InMemoryServerEventBus` alone.

**e.** [`README.md`](../../../README.md) — delete the
`#### Multi-instance HTTP deployments` section,
[`:411-469`](../../../README.md#L411-L469), including the Redis example. On
[`:409`](../../../README.md#L409), trim the `FS_REQUEST_STATE_KEY` row's
description to end after `(random per boot if unset)` — drop the clause about
fleet instances.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0
**Verify**: `node scripts/tasks.mjs test` → exit 0, `pass 265`, `fail 0`
**Verify**: `grep -rn "deploymentMode\|assertFleetRequestStateKey" src/ __tests__/ README.md` → no matches
**Verify**: `grep -rn "eventBus" src/` → no matches (a comment mentioning `ServerEventBus` at [`resources.ts:67`](../../../src/resources.ts#L67) is prose about the SDK's own bus and may stay)

### 3. Collapse `ProgressSink` into one optional sink

In [`progress.ts`](../../../src/tools/progress.ts):

- Delete the `ProgressSink` interface ([`:22-25`](../../../src/tools/progress.ts#L22-L25)).
- In `ProgressSessionOptions`, replace `sinks: ProgressSink[]` with `sink?: McpProgressSink`.
- Replace the `#sinks` field and its assignment with `readonly #sink: McpProgressSink | undefined`.
- In `#dispatch` ([`:106-118`](../../../src/tools/progress.ts#L106-L118)), replace the `for` loop with a single guarded call.
- Fold `#emitGuarded` ([`:133-152`](../../../src/tools/progress.ts#L133-L152)) into that call, or keep it as a one-argument private method — but drop the `sink.name` field from the log payload, since `McpProgressSink.name` is the constant `'mcp'`. Keep the try/catch and the promise-rejection handler: `emit` is fire-and-forget and a throw there must not fail the tool call.
- Delete `readonly name = 'mcp';` from `McpProgressSink` ([`:156`](../../../src/tools/progress.ts#L156)) and the `implements ProgressSink` clause ([`:155`](../../../src/tools/progress.ts#L155)).

In [`define.ts:285-296`](../../../src/tools/define.ts#L285-L296), drop the array. Target shape:

```ts
    const token = ctx._meta?.progressToken;
    if (token !== undefined && ctx.sendNotification !== undefined) {
      this.#mcpSink = new McpProgressSink(toolName, token, ctx.sendNotification);
    }
    const isTest = process.env['NODE_ENV'] === 'test' || process.execArgv.includes('--test');
    this.#progressSession = new ProgressSession({
      label: this.#progressCtx.label,
      ...(this.#mcpSink ? { sink: this.#mcpSink } : {}),
      ...(isTest ? { rateLimitMs: 0 } : {}),
    });
```

Drop the `ProgressSink` type import at [`define.ts:43`](../../../src/tools/define.ts#L43).

In [`progress.test.ts:32`](../../../__tests__/progress.test.ts#L32), change
`sinks: [sink]` to `sink`. Change nothing else in that file — the four
monotonicity tests must still pass unmodified, which is what proves the wire
behavior did not move.

**Verify**: `node scripts/tasks.mjs test --test-name-pattern="McpProgressSink"` → exit 0, `tests 27`, `pass 27`, `fail 0` (the count is unchanged by this step — it only renames a constructor option)
**Verify**: `node scripts/tasks.mjs --quick` → exit 0
**Verify**: `grep -rn "ProgressSink" src/` → matches only `McpProgressSink`

### 4. Delete the unreachable `'start'` phase

In [`fmt.ts`](../../../src/core/fmt.ts), narrow the type at
[`:14`](../../../src/core/fmt.ts#L14) to `'tick' | 'done' | 'fail'` and delete
the `case 'start':` branch at
[`:23-27`](../../../src/core/fmt.ts#L23-L27). Leave the `'done'` branch's
`ctx.scope` read intact.

If the compiler now reports the `switch` as exhaustive without a `default`, that
is expected — leave it exhaustive rather than adding one.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0
**Verify**: `node scripts/tasks.mjs test` → exit 0, `fail 0`

### 5. Delete the prompt topic refinements

In [`prompts.ts:31-50`](../../../src/prompts.ts#L31-L50), delete both `.refine`
calls. Keep `.min(1, { message: 'Topic required' })` and `.describe(description)`.
Delete the now-unused import at [`:13`](../../../src/prompts.ts#L13).
Change nothing in the handler at
[`:116-118`](../../../src/prompts.ts#L116-L118) — `Object.hasOwn` is the bound
this step relies on.

**Verify**: `node scripts/tasks.mjs test --test-name-pattern="get-help"` → exit 0, `tests 26`, `pass 26`, `fail 0`
**Verify**: `node scripts/tasks.mjs --quick` → exit 0

### 6. Let Node write the directory error

In [`cli.ts`](../../../src/cli.ts):

- Delete `getSystemErrorDetails` ([`:54-62`](../../../src/cli.ts#L54-L62)) and `normalizeDirectoryError` ([`:64-85`](../../../src/cli.ts#L64-L85)).
- At [`:107`](../../../src/cli.ts#L107), replace the throw:

  ```ts
      throw new Error(`Cannot access directory ${inputPath}: ${formatUnknownErrorMessage(error)}`);
  ```

  `formatUnknownErrorMessage` is already imported at [`:8`](../../../src/cli.ts#L8).
- At [`:3`](../../../src/cli.ts#L3), drop `getSystemErrorMessage` and `getSystemErrorName`; keep `parseArgs as utilParseArgs`.
- At [`:16`](../../../src/cli.ts#L16), drop `isRecord`; keep `IS_WINDOWS` and `parseTrueEnvFlag`.

Then delete `isRecord` itself from
[`primitives.ts:8-10`](../../../src/core/primitives.ts#L8-L10) — `cli.ts:58` was
its only consumer, and knip fails on the orphaned export otherwise.

Leave `assertDirectory` and its `is not a directory` message alone:
[`validateDirectoryPath:100-105`](../../../src/cli.ts#L100-L105) matches on that
substring in its `allowMissing` branch.

**Verify**: `node scripts/tasks.mjs --quick` → exit 0 (this is the knip gate for `isRecord`)
**Verify**: `node scripts/tasks.mjs test` → exit 0, `fail 0`

## Done

Machine-checkable. All must hold:

- [ ] `node scripts/tasks.mjs --quick` exits 0
- [ ] `node scripts/tasks.mjs test` exits 0 with `pass 265`, `fail 0`, `suites 62`
- [ ] `grep -rn "deploymentMode\|assertFleetRequestStateKey\|ProgressSink\b" src/ __tests__/` returns nothing but `McpProgressSink`
- [ ] `ls scripts/` shows only `tasks.mjs`
- [ ] `git status --porcelain` lists no file outside the [Scope](#scope) list
- [ ] `git diff --stat 0223af11..HEAD` shows a net deletion of at least 900 lines

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its excerpt.
- A step's verification fails twice after one fix attempt — a second failure means the step's assumption is wrong, not its implementation.
- The fix appears to require a file in the out-of-scope list.
- **A caller of `RuntimeConfig.eventBus` or `deploymentMode` turns out to exist** outside `__tests__/` and the README example. This plan rests on those two fields being unreachable from the shipped binary; a real embedder using them makes step 2 a breaking change that needs a major version, not a cleanup.
- Deleting the QA harness would remove coverage `__tests__/inspector-*.test.ts` does not have. Read [`scripts/qa-cases/sec.json`](../../../scripts/qa-cases/sec.json) before step 1 if unsure; port the case rather than keeping the harness.
- The test count after step 2 is anything other than 265. A different number means a block was cut wrong, or a test outside the three named blocks depended on fleet config.

## Notes

- **Review focus**: step 2c, the comment rewrites in `input-required.ts`. Comments that describe a guard which no longer exists are worse than no comment, and the compiler cannot catch them.
- **Deliberately deferred**: `define.ts` still builds a `ProgressSession` and formats a `plainMessage` on every tool call even when no `progressToken` was sent, so that work is discarded. Threading `#progressSession?.` through five call sites to save two string concatenations is not worth the diff. Revisit only if a profile says so.
- **Deliberately deferred**: `isTotalBatchFailure` ([`define.ts:220-244`](../../../src/tools/define.ts#L220-L244)) special-cases two result shapes because `create` and `move` publish `{files|moves, failures, skipped}` while every other batch tool publishes `summary`. Unifying the schemas is the real fix, but it touches the published wire contract.
- **Rollback**: nothing here migrates data or touches production state. `git revert` of the step's commit is sufficient; commit each step separately so that stays true.
