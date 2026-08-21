# Plan: Derive the mutating-tool roster from tool annotations, and stop advertising write tools under `--read-only`

> **Executor rules**: work the steps in order. Run every Verify command and
> confirm its expected result before moving on. On any STOP condition, stop and
> report the condition, the step, and the evidence.
>
> **Written against** commit `606f71c`, 2026-08-21.
> **Drift check (run first)**: `git diff --stat 606f71c..HEAD -- src/tools src/resources.ts src/cli.ts src/prompts.ts __tests__`
> Its file list is what narrows the excerpt match: compare
> [Current state](#current-state) against the live code for every file it flags.
> A mismatch is a [STOP](#stop) condition.

## Goal

The set of tools that mutate the filesystem is written six times across this
repo. One of those copies — `MUTATING_TOOL_NAMES` in
[`src/tools/index.ts:30`](../../../src/tools/index.ts#L30) — is the one that
implements `--read-only`. The other five are hand-maintained restatements that
nothing checks against it.

This already produces a live defect: `internal://instructions` advertises
`create`, `edit`, `move`, `delete`, and `replace_text` even when the server was
started `--read-only` and those tools were never registered. It also leaves a
latent one: a thirteenth mutating tool added to `ALL_TOOLS` but forgotten in
`MUTATING_TOOL_NAMES` is registered under `--read-only`, and every existing test
still passes, because each test restates the same five names by hand rather than
deriving them.

When this lands, each of the twelve tools declares once whether it mutates — in
its own `annotations.readOnlyHint`, which it already sets — the three production
copies derive from that declaration, the test suite keeps exactly one
independent literal list as its oracle and pins the derived set against it, and
the instructions resource reflects the tools actually registered.

Requirements covered: none, this is a fix.

## Current state

### The rule this violates

[`src/tools/index.ts:40-41`](../../../src/tools/index.ts#L40-L41) states the
ownership rule that the other five sites break:

```ts
// Re-exported so documentation surfaces quote `.name` off the definition rather
// than repeating the string. This module is the only owner of the inventory.
```

### The six copies

| Site                                                                                           | Form                  |
| :--------------------------------------------------------------------------------------------- | :-------------------- |
| [`src/tools/index.ts:30`](../../../src/tools/index.ts#L30)                                     | `MUTATING_TOOL_NAMES` |
| [`create.ts:97`](../../../src/tools/create.ts#L97) + 4 siblings                                | `readOnlyHint: false` |
| [`src/resources.ts:120`](../../../src/resources.ts#L120)                                       | `'Write'` row         |
| [`src/cli.ts:142`](../../../src/cli.ts#L142)                                                   | `--help` prose        |
| [`__tests__/contract.test.ts:44`](../../../__tests__/contract.test.ts#L44)                     | `DESTRUCTIVE_TOOLS`   |
| [`__tests__/unit/cli-read-only.test.ts:36`](../../../__tests__/unit/cli-read-only.test.ts#L36) | `MUTATING_TOOLS`      |

### `DefinedTool` drops the field that would make derivation possible

[`src/tools/define.ts:102-108`](../../../src/tools/define.ts#L102-L108) — the
public shape of a registered tool. Note the absence of `annotations`:

```ts
export interface DefinedTool {
  readonly name: string;
  readonly inputSchema: Tool['inputSchema'];
  readonly outputSchema: Record<string, unknown>;

  register(deps: ToolDeps): void;
}
```

[`src/tools/define.ts:414-418`](../../../src/tools/define.ts#L414-L418) — where
that object is built. `def.annotations` is in scope here and is used at line 425
inside `register`, but never surfaced on the returned object:

```ts
  const tool: DefinedTool = {
    name: def.name,
    inputSchema: inputJsonSchema as Tool['inputSchema'],
    outputSchema: outputJsonSchema,
```

`ToolAnnotations` is already imported as a type at
[`define.ts:12`](../../../src/tools/define.ts#L12) from
`@modelcontextprotocol/server`, and is already the declared type of
[`ToolDef.annotations` at `define.ts:82`](../../../src/tools/define.ts#L82). No
new import is needed.

### All twelve tools already declare `readOnlyHint` explicitly

Verified across every file in `src/tools/`. The five mutating tools set
`readOnlyHint: false`; the seven read-only tools set `readOnlyHint: true`. There
is no tool that omits it:

| `readOnlyHint: false` (5)                                                | `readOnlyHint: true` (7)                                             |
| :----------------------------------------------------------------------- | :------------------------------------------------------------------- |
| [`create.ts:97`](../../../src/tools/create.ts#L97)                       | [`calculate-hash.ts:318`](../../../src/tools/calculate-hash.ts#L318) |
| [`delete-file.ts:363`](../../../src/tools/delete-file.ts#L363)           | [`list.ts:310`](../../../src/tools/list.ts#L310)                     |
| [`edit.ts:510`](../../../src/tools/edit.ts#L510)                         | [`read.ts:401`](../../../src/tools/read.ts#L401)                     |
| [`move.ts:420`](../../../src/tools/move.ts#L420)                         | [`roots.ts:21`](../../../src/tools/roots.ts#L21)                     |
| [`replace-in-files.ts:630`](../../../src/tools/replace-in-files.ts#L630) | [`search-content.ts:403`](../../../src/tools/search-content.ts#L403) |
|                                                                          | [`search-files.ts:193`](../../../src/tools/search-files.ts#L193)     |
|                                                                          | [`stat.ts:190`](../../../src/tools/stat.ts#L190)                     |

### The roster, and the `--read-only` gate it drives

[`src/tools/index.ts:15-38`](../../../src/tools/index.ts#L15-L38):

```ts
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
] as const;

export const MUTATING_TOOL_NAMES = new Set([
  CREATE.name,
  DELETE_FILE.name,
  EDIT.name,
  MOVE.name,
  SEARCH_AND_REPLACE.name,
]);

export const ALL_REGISTERED_TOOL_NAMES: readonly string[] = ALL_TOOLS.map((t) => t.name);
```

`ALL_TOOLS` is **not** currently exported. The gate it feeds is
[`src/tools/index.ts:65-68`](../../../src/tools/index.ts#L65-L68):

```ts
for (const tool of ALL_TOOLS) {
  if (deps.readOnly && MUTATING_TOOL_NAMES.has(tool.name)) continue;
  tool.register(toolDeps);
}
```

### The instructions leak

[`src/resources.ts:115-127`](../../../src/resources.ts#L115-L127) — the `'Write'`
row is a hardcoded list of the same five tools, and `buildToolsOverview` takes no
arguments:

```ts
function buildToolsOverview(): string {
  const rows: [string, string[]][] = [
    ['Navigate', [LIST_ALLOWED_DIRECTORIES.name, LIST.name, SEARCH_FILES.name]],
    ['Inspect', [GET_FILE_INFO.name, SEARCH_CONTENT.name, CALCULATE_HASH.name]],
    ['Read', [READ_FILE.name]],
    ['Write', [CREATE.name, EDIT.name, MOVE.name, DELETE_FILE.name, SEARCH_AND_REPLACE.name]],
  ];

  const rowLines = rows.map(([cat, names]) => `${cat}: ${names.join(', ')}`);
  return `\`\`\`\n${rowLines.join('\n')}\n\`\`\``;
}

function buildSectionsRecord(): Record<string, string> {
```

[`src/resources.ts:165-169`](../../../src/resources.ts#L165-L169) — the text is
frozen at module load, so it cannot see `readOnly`:

```ts
export const INSTRUCTION_SECTIONS: Record<string, string> = buildSectionsRecord();

export const SERVER_INSTRUCTIONS_CONTENT = `\n${Object.values(INSTRUCTION_SECTIONS).join('\n\n')}\n`;

export { SERVER_INSTRUCTIONS_CONTENT as serverInstructionsContent };
```

Both registrars already receive `readOnly` and both ignore it.
[`src/core/registrar.ts:20-27`](../../../src/core/registrar.ts#L20-L27):

```ts
export interface ServerDeps {
  server: McpServer;
  pathGuard: PathGuard;
  resourceStore: ResourceStore;
  isInitialized: () => boolean;
  iconInfo?: IconInfo;
  readOnly?: boolean;
}
```

[`src/server.ts:148`](../../../src/server.ts#L148) populates it:
`...(options.readOnly ? { readOnly: true } : {}),`

The two consumers of the frozen text:

- [`src/resources.ts:471`](../../../src/resources.ts#L471) —
  `createInstructionsResource()` inside `getResourceContracts`, which reads
  `SERVER_INSTRUCTIONS_CONTENT` at [`resources.ts:185`](../../../src/resources.ts#L185)
- [`src/prompts.ts:383`](../../../src/prompts.ts#L383) — `promptsRegistrar` passes
  `instructions: serverInstructionsContent` into the `get-help` prompt

### Why the test literals must NOT be derived

[`__tests__/contract.test.ts:87-104`](../../../__tests__/contract.test.ts#L87-L104)
uses its literal sets to **assert** that the wire annotations are correct:

```ts
  it('read-only tools have readOnlyHint:true and destructiveHint:false', async () => {
    const { tools } = await env.client.listTools();
    for (const tool of tools) {
      if (!READ_ONLY_TOOLS.has(tool.name)) continue;
      const ann = tool.annotations as Record<string, unknown>;
      assert.equal(ann['readOnlyHint'], true, `${tool.name}: expected readOnlyHint=true`);
```

Deriving `READ_ONLY_TOOLS` from `readOnlyHint` would make this assertion
tautological — it would select tools _because_ `readOnlyHint === true`, then
assert `readOnlyHint === true`. **The test-side literals are the independent
oracle and must stay literal.** What this plan changes on the test side is that
there is exactly **one** oracle instead of three copies of it, and that the
oracle pins the derived production set.

### The three test-side copies to collapse into one oracle

[`__tests__/contract.test.ts:17-44`](../../../__tests__/contract.test.ts#L17-L44):

```ts
// Names of all 12 tools as registered
const ALL_TOOLS = new Set([
  'create',
  'hash_file',
  'delete',
  'edit',
  'list',
  'move',
  'read',
  'replace_text',
  'list_roots',
  'search_text',
  'find_files',
  'stat',
]);

const READ_ONLY_TOOLS = new Set([
  'hash_file',
  'list',
  'read',
  'list_roots',
  'search_text',
  'find_files',
  'stat',
]);

const DESTRUCTIVE_TOOLS = new Set(['create', 'edit', 'delete', 'move', 'replace_text']);
```

(reformatted here for width; the file has one name per line)

[`__tests__/unit/cli-read-only.test.ts:36`](../../../__tests__/unit/cli-read-only.test.ts#L36):

```ts
const MUTATING_TOOLS = ['create', 'edit', 'delete', 'move', 'replace_text'];
```

[`__tests__/helpers.ts:29-42`](../../../__tests__/helpers.ts#L29-L42) is a
byte-for-byte copy of the `ALL_TOOLS` array in
[`src/tools/index.ts:15-28`](../../../src/tools/index.ts#L15-L28), built from
twelve direct module imports at
[`helpers.ts:14-27`](../../../__tests__/helpers.ts#L14-L27). This one is a copy of
the _registry_, not an oracle — it should import.

### Conventions to match

- **Exemplar for a derived export**: `ALL_REGISTERED_TOOL_NAMES` at
  [`src/tools/index.ts:38`](../../../src/tools/index.ts#L38) — derived with
  `.map()` off `ALL_TOOLS`, typed `readonly string[]`, one line.
- **Exemplar for optional-property handling**: this repo sets
  `exactOptionalPropertyTypes: true` in
  [`tsconfig.json`](../../../tsconfig.json), so an optional field is added by
  conditional spread, never by assigning `undefined`. See
  [`src/server.ts:147-148`](../../../src/server.ts#L147-L148):
  `...(options.readOnly ? { readOnly: true } : {}),`
- **Exemplar for a test file**: [`__tests__/unit/env-documented.test.ts`](../../../__tests__/unit/env-documented.test.ts)
  — `node:test` with `assert/strict`, `assert.deepEqual` on sorted arrays with a
  message naming the file to edit.
- **Import order** is enforced by `@trivago/prettier-plugin-sort-imports` per
  [`.prettierrc`](../../../.prettierrc): `@modelcontextprotocol/*`, then builtins,
  then third-party, then relative — with blank lines between groups.

### Toolchain state at `606f71c` — read this before running anything

`node scripts/tasks.mjs --quick` is **red at clean HEAD**, on failures unrelated
to this change. `format` is its first phase and it gates on it
([`tasks.mjs:2014-2017`](../../../scripts/tasks.mjs#L2014-L2017)), so the run
never reaches lint, type-check, or knip. `--quick` skips only test and rebuild —
never format.

`./node_modules/.bin/prettier --check .` reports **11** files. Ten are under
`src/core/`:

```
concurrency.ts  file-uri.ts  fmt.ts  glob.ts  path-completer.ts
path.ts  registrar.ts  schema.ts  search.ts  store.ts
```

The eleventh is **this plan document**. `.prettierignore` is two lines —
`node_modules` and `dist` — so `prettier --check .` covers `docs/**/*.md`, and
the file is not gitignored either. The differences are real content (markdown
table padding, code-fence indentation), not line endings.

`./node_modules/.bin/prettier --write src/core/ docs/` fixes all eleven and
changes nothing else. Step 0 lands that as its own commit so it cannot
contaminate the review of this change.

> Do **not** diagnose this with `npx prettier`. `npx` resolves a prettier that
> cannot load `@trivago/prettier-plugin-sort-imports`, so it skips import
> sorting and reports the files as clean. Always use
> `./node_modules/.bin/prettier` or an `npm run` script.

## Commands

Run from the repo root. Every command below was run against `606f71c` and
produced the stated result.

| Purpose        | Command                                          | Expected on success                        |
| -------------- | ------------------------------------------------ | ------------------------------------------ |
| Format check   | `npm run format:check`                           | exit 0 (**red before Step 0** — see above) |
| Typecheck      | `npm run type-check`                             | exit 0, no output beyond the script banner |
| Lint           | `npm run lint`                                   | exit 0, no output beyond the script banner |
| Unused exports | `npm run knip`                                   | exit 0, no output beyond the script banner |
| Tests          | `npm test`                                       | exit 0, `pass 801`+, `fail 0`, ~10s        |
| Everything     | `node scripts/tasks.mjs --quick` then `npm test` | both exit 0 (only after Step 0)            |

Baseline at `606f71c`: `tests 802 / pass 801 / fail 0 / skipped 1`. Each step
below that adds tests states its own expected new total.

> `npm test` output is long. Redirect it — `npm test > /tmp/t.log 2>&1; tail -12 /tmp/t.log` —
> rather than piping it, so the summary is not truncated.

## Scope

**In scope** — the only files to modify:

- [`src/tools/define.ts`](../../../src/tools/define.ts)
- [`src/tools/index.ts`](../../../src/tools/index.ts)
- [`src/resources.ts`](../../../src/resources.ts)
- [`src/prompts.ts`](../../../src/prompts.ts)
- [`src/cli.ts`](../../../src/cli.ts)
- [`__tests__/helpers.ts`](../../../__tests__/helpers.ts)
- [`__tests__/contract.test.ts`](../../../__tests__/contract.test.ts)
- [`__tests__/unit/cli-read-only.test.ts`](../../../__tests__/unit/cli-read-only.test.ts)
- `__tests__/unit/tool-roster.test.ts` — new file, created in Step 3
- `src/core/**` — **Step 0 only**, formatting, as its own commit

**Files out of scope** — leave alone even though they look related:

- The twelve tool modules (`src/tools/create.ts`, `read.ts`, …) — their
  `annotations` blocks are the new source of truth and are already correct. Every
  one was verified. Editing them changes the thing this plan derives from.
- [`__tests__/schemas/__snapshots__/tool-schemas.json`](../../../__tests__/schemas/__snapshots__/tool-schemas.json)
  — the snapshot covers only `inputSchema` and `outputSchema`
  ([`snapshot.test.ts:15-18`](../../../__tests__/schemas/snapshot.test.ts#L15-L18)),
  not annotations. If it changes, something unintended happened — that is a STOP.
- [`src/server.ts`](../../../src/server.ts) — already threads `readOnly` into
  `ServerDeps` correctly at line 148. Nothing to do.
- [`src/core/registrar.ts`](../../../src/core/registrar.ts) — `ServerDeps.readOnly`
  already exists at line 26.
- [`README.md`](../../../README.md) — its tool table is operator documentation, not
  a runtime copy. Out of scope for this change.

## Steps

### 0. Land the pre-existing formatting fix as its own commit

The gate is red before you start, on ten files this change never touches. Clear
it first so every later step's Verify is meaningful, and keep it in a separate
commit so it does not obscure the real diff.

```
./node_modules/.bin/prettier --write src/core/ docs/
git add src/core docs
git commit -m "style: apply prettier import ordering to src/core"
```

`git status` must show exactly ten modified files under `src/core/`, plus
whatever is staged under `docs/`. If it shows a modified file outside those two
directories, that is a STOP.

> `docs/` is in the pass because [`.prettierignore`](../../../.prettierignore)
> lists only `node_modules` and `dist` — `prettier --check .` therefore covers
> `docs/**/*.md`, **including this plan file**. Formatting `src/core/` alone
> leaves the gate red on the plan document itself, which would block the
> [Done](#done) checklist for a reason unrelated to any code change.

**Verify**: `npm run format:check` → exit 0, `All matched files use Prettier code style!`

### 1. Expose `annotations` on `DefinedTool`

In [`src/tools/define.ts`](../../../src/tools/define.ts), add the field to the
interface at [line 102](../../../src/tools/define.ts#L102):

```ts
export interface DefinedTool {
  readonly name: string;
  readonly annotations: ToolAnnotations;
  readonly inputSchema: Tool['inputSchema'];
  readonly outputSchema: Record<string, unknown>;

  register(deps: ToolDeps): void;
}
```

and populate it in the object literal at
[line 414](../../../src/tools/define.ts#L414):

```ts
  const tool: DefinedTool = {
    name: def.name,
    annotations: def.annotations,
    inputSchema: inputJsonSchema as Tool['inputSchema'],
    outputSchema: outputJsonSchema,
```

`ToolAnnotations` is already imported at
[`define.ts:12`](../../../src/tools/define.ts#L12) — do not add an import.

This step is purely additive; nothing reads the new field yet.

**Verify**: `npm run type-check` → exit 0

### 2. Derive `MUTATING_TOOL_NAMES` from the annotations

In [`src/tools/index.ts`](../../../src/tools/index.ts), replace the hand-listed
set at [lines 30-36](../../../src/tools/index.ts#L30-L36) with a derivation,
matching the style of `ALL_REGISTERED_TOOL_NAMES` on the line below it:

```ts
// A tool is mutating unless it declares itself read-only. Defaulting an
// unannotated tool to mutating is the safe direction: `--read-only` omits it.
export const MUTATING_TOOL_NAMES = new Set(
  ALL_TOOLS.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name),
);
```

Use `!== true`, not `=== false`. `readOnlyHint` is optional on `ToolAnnotations`;
a tool that forgets it must fall on the restrictive side.

Do not export `ALL_TOOLS` yet — `knip` would flag it as an unused export until
Step 5 consumes it.

**Verify**: `npm test > /tmp/t.log 2>&1; tail -12 /tmp/t.log` → `pass 801`, `fail 0`

### 3. Move the test oracle into `helpers.ts` and pin the derived set against it

The literal names stay literal — they are the independent oracle. This step gives
them one home and makes them load-bearing.

Add to [`__tests__/helpers.ts`](../../../__tests__/helpers.ts), near the top,
after the imports:

```ts
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
```

Write one name per line if prettier reflows it; let the formatter decide.

Then create `__tests__/unit/tool-roster.test.ts`, following the shape of
[`env-documented.test.ts`](../../../__tests__/unit/env-documented.test.ts):

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_REGISTERED_TOOL_NAMES, MUTATING_TOOL_NAMES } from '../../src/tools/index.js';
import {
  ORACLE_ALL_TOOL_NAMES,
  ORACLE_MUTATING_TOOL_NAMES,
  ORACLE_READ_ONLY_TOOL_NAMES,
} from '../helpers.js';

test('MUTATING_TOOL_NAMES matches the declared mutating set', () => {
  assert.deepEqual(
    [...MUTATING_TOOL_NAMES].sort(),
    [...ORACLE_MUTATING_TOOL_NAMES].sort(),
    'A tool changed its readOnlyHint, or a new tool was added. If the new set is ' +
      'correct, update ORACLE_MUTATING_TOOL_NAMES in __tests__/helpers.ts.',
  );
});

test('every registered tool is classified exactly once', () => {
  assert.deepEqual(
    [...ALL_REGISTERED_TOOL_NAMES].sort(),
    [...ORACLE_ALL_TOOL_NAMES].sort(),
    'Add the new tool to ORACLE_ALL_TOOL_NAMES and to one of the two subsets.',
  );
  assert.deepEqual(
    [...ORACLE_MUTATING_TOOL_NAMES, ...ORACLE_READ_ONLY_TOOL_NAMES].sort(),
    [...ORACLE_ALL_TOOL_NAMES].sort(),
    'The mutating and read-only oracles must partition the full roster.',
  );
});
```

This is the test that was missing: it is the only thing in the repo that fails
when a new mutating tool is added and misclassified.

**Verify**: `npm test > /tmp/t.log 2>&1; tail -12 /tmp/t.log` → `pass 803`, `fail 0`
(two new tests)

### 4. Point the two test files at the oracle

In [`__tests__/contract.test.ts`](../../../__tests__/contract.test.ts), delete the
three local sets at [lines 17-44](../../../__tests__/contract.test.ts#L17-L44) and
build them from the oracle instead. Extend the existing import from
`./helpers.js` at [line 15](../../../__tests__/contract.test.ts#L15):

```ts
const ALL_TOOLS = new Set<string>(ORACLE_ALL_TOOL_NAMES);
const READ_ONLY_TOOLS = new Set<string>(ORACLE_READ_ONLY_TOOL_NAMES);
const DESTRUCTIVE_TOOLS = new Set<string>(ORACLE_MUTATING_TOOL_NAMES);
```

Every assertion body stays exactly as it is — including the tautology-free checks
at [lines 87-104](../../../__tests__/contract.test.ts#L87-L104). The message at
[line 59](../../../__tests__/contract.test.ts#L59) still reads `'Expected 12 tools'`;
leave it, `ALL_TOOLS.size` is what is compared.

In [`__tests__/unit/cli-read-only.test.ts`](../../../__tests__/unit/cli-read-only.test.ts),
replace the literal at [line 36](../../../__tests__/unit/cli-read-only.test.ts#L36):

```ts
import { ORACLE_MUTATING_TOOL_NAMES } from '../helpers.js';

const MUTATING_TOOLS = ORACLE_MUTATING_TOOL_NAMES;
```

The same file has a second literal at
[line 69](../../../__tests__/unit/cli-read-only.test.ts#L69):

```ts
const READ_TOOLS = ['read', 'list', 'stat', 'find_files', 'search_text', 'hash_file'];
```

That is **six** names — it omits `list_roots`, with no comment explaining the
omission. It is used at
[line 137](../../../__tests__/unit/cli-read-only.test.ts#L137) to assert those
tools survive `--read-only`. Point it at the seven-name oracle:

```ts
const READ_TOOLS = ORACLE_READ_ONLY_TOOL_NAMES;
```

This strictly strengthens the assertion — `list_roots` is read-only and must
survive `--read-only`, so it belongs in that loop. If adding it makes the test
fail, that is a real bug in the gate and a [STOP](#stop).

**Verify**: `npm test > /tmp/t.log 2>&1; tail -12 /tmp/t.log` → `pass 803`, `fail 0`

### 5. Make `helpers.ts` import the registry instead of copying it

Export the array from [`src/tools/index.ts:15`](../../../src/tools/index.ts#L15):

```ts
export const ALL_TOOLS = [
```

Then in [`__tests__/helpers.ts`](../../../__tests__/helpers.ts), delete the
twelve direct tool imports at [lines 14-27](../../../__tests__/helpers.ts#L14-L27)
and the copied array at [lines 29-42](../../../__tests__/helpers.ts#L29-L42),
replacing both with:

```ts
import { ALL_TOOLS } from '../src/tools/index.js';
```

The two loops at [`helpers.ts:92`](../../../__tests__/helpers.ts#L92) and
[`helpers.ts:153`](../../../__tests__/helpers.ts#L153) iterate `ALL_TOOLS` and
need no change.

`knip` is the gate that confirms the new export is actually consumed — it will
fail if Step 5 is left half-done.

**Verify**: `npm run knip` → exit 0, **and**
`npm test > /tmp/t.log 2>&1; tail -12 /tmp/t.log` → `pass 803`, `fail 0`

### 6. Derive the two remaining production copies

In [`src/resources.ts`](../../../src/resources.ts), rewrite the `'Write'` row at
[line 120](../../../src/resources.ts#L120) so membership comes from the roster
rather than a hand-list.

The file already imports the twelve tool constants from `./tools/index.js` at
[lines 39-52](../../../src/resources.ts#L39-L52) — add two names to that same
import block, so this adds no new module edge:

```ts
  ALL_REGISTERED_TOOL_NAMES,
  MUTATING_TOOL_NAMES,
```

Prettier's `importOrderSortSpecifiers` will place them; keep the block
alphabetical. Then:

```ts
    ['Write', ALL_REGISTERED_TOOL_NAMES.filter((n) => MUTATING_TOOL_NAMES.has(n))],
```

After this edit, `CREATE`, `EDIT`, `MOVE`, `DELETE_FILE`, and
`SEARCH_AND_REPLACE` are no longer referenced in `src/resources.ts`. Delete them
from the import block — `noUnusedLocals` is on in
[`tsconfig.json`](../../../tsconfig.json), so leaving them fails type-check. The
other seven stay; the `Navigate` / `Inspect` / `Read` rows still use them.

Keep the other three rows hand-curated — `Navigate` / `Inspect` / `Read` are an
editorial grouping of read-only tools with no runtime meaning, and nothing
derives them.

In [`src/cli.ts`](../../../src/cli.ts), the `--read-only` help row at
[line 142](../../../src/cli.ts#L142) currently reads:

```ts
  { flags: '--read-only', desc: 'Disable write tools: create, edit, delete, move, replace' },
```

Note it says `replace`; the tool is named `replace_text`. Derive it — `cli.ts`
already imports `MUTATING_TOOL_NAMES` at
[line 17](../../../src/cli.ts#L17):

```ts
  {
    flags: '--read-only',
    desc: `Disable write tools: ${[...MUTATING_TOOL_NAMES].sort().join(', ')}`,
  },
```

`OPTIONS_HELP` is a module-level const evaluated at import time, and
`MUTATING_TOOL_NAMES` is already imported at module scope, so ordering is safe.

**Verify**: `npm test > /tmp/t.log 2>&1; tail -12 /tmp/t.log` → `pass 803`, `fail 0`,
**and** `node dist/index.js --help` after `npm run build` prints
`Disable write tools: create, delete, edit, move, replace_text`

### 7. Stop advertising write tools under `--read-only`

This is the live defect. Add parameterised builders, and be precise about which
of the three existing exports survives:

| Export at `resources.ts`                                                   | Fate       | Why                                                                                                                                                                     |
| :------------------------------------------------------------------------- | :--------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `INSTRUCTION_SECTIONS` ([:165](../../../src/resources.ts#L165))            | **keep**   | read by [`instructions.test.ts:59`](../../../__tests__/resources/instructions.test.ts#L59) and by [`prompts.ts:162`](../../../src/prompts.ts#L162) for topic completion |
| `SERVER_INSTRUCTIONS_CONTENT` ([:167](../../../src/resources.ts#L167))     | **keep**   | read by [`instructions.test.ts:4`](../../../__tests__/resources/instructions.test.ts#L4) — ten assertions                                                               |
| `serverInstructionsContent` alias ([:169](../../../src/resources.ts#L169)) | **delete** | `src/prompts.ts` is its only importer repo-wide, and this step removes that use                                                                                         |

The alias is the trap. `instructions.test.ts:4` imports the **un-aliased**
`SERVER_INSTRUCTIONS_CONTENT`, so no test reads line 169. Once `prompts.ts` stops
importing it, it is an orphaned export and `npm run knip` fails on it.

In [`src/resources.ts`](../../../src/resources.ts):

1. Give `buildToolsOverview` and `buildSectionsRecord` a `readOnly` parameter
   defaulting to `false`. When `readOnly` is true, drop the `'Write'` row
   entirely rather than emitting an empty one.
2. Export a builder next to the consts at
   [lines 165-167](../../../src/resources.ts#L165-L167), leaving those two
   exactly as they are:

   ```ts
   export function buildServerInstructions(readOnly = false): string {
     return `\n${Object.values(buildSectionsRecord(readOnly)).join('\n\n')}\n`;
   }
   ```

   Then **delete the alias re-export** at
   [line 169](../../../src/resources.ts#L169):

   ```ts
   export { SERVER_INSTRUCTIONS_CONTENT as serverInstructionsContent };
   ```

   Its only importer is `src/prompts.ts`, which this step switches off it.
   Leaving it in place fails `npm run knip` — [`knip.json`](../../../knip.json)
   sets `"project": ["src/**/*.ts"]` with no `ignoreExportsUsedInFile`, and the
   `knip` script passes no issue-type filter, so an unimported `src/` export
   lands in the default `exports` report.

3. Add `readOnly?: boolean` to `ResourceRegistrationOptions`, have
   `createInstructionsResource(options)` call `buildServerInstructions(options.readOnly)`
   instead of reading `SERVER_INSTRUCTIONS_CONTENT` at
   [line 185](../../../src/resources.ts#L185), and pass it through
   `getResourceContracts` at [line 471](../../../src/resources.ts#L471).
4. In `resourcesRegistrar.register` at
   [line 613](../../../src/resources.ts#L613), forward it with a conditional
   spread — `exactOptionalPropertyTypes` is on:

   ```ts
         ...(deps.readOnly ? { readOnly: true } : {}),
   ```

The four existing `getResourceContracts({ ... })` call sites in tests
([`contract.test.ts:276`](../../../__tests__/contract.test.ts#L276),
[`completions.test.ts:36`](../../../__tests__/unit/completions.test.ts#L36),
[`resource-watcher-cap.test.ts:30`](../../../__tests__/unit/resource-watcher-cap.test.ts#L30),
[`resource-subscribe-unknown.test.ts:42`](../../../__tests__/unit/resource-subscribe-unknown.test.ts#L42))
keep compiling untouched because the new field is optional.

In [`src/prompts.ts`](../../../src/prompts.ts), two lines change together — the
import and its use. Miss either and the build breaks.

[Line 28](../../../src/prompts.ts#L28) is currently:

```ts
import { INSTRUCTION_SECTIONS, serverInstructionsContent } from './resources.js';
```

Swap the specifier — `INSTRUCTION_SECTIONS` stays, it is still used at
[line 162](../../../src/prompts.ts#L162):

```ts
import { buildServerInstructions, INSTRUCTION_SECTIONS } from './resources.js';
```

Then `promptsRegistrar.register` at
[line 383](../../../src/prompts.ts#L383):

```ts
      instructions: buildServerInstructions(deps.readOnly),
```

`serverInstructionsContent` must not survive at either site.
[`tsconfig.json:31`](../../../tsconfig.json#L31) sets `"noUnusedLocals": true`,
so an import left unread is TS6133 and `npm run type-check` exits non-zero.

`topics` at [`prompts.ts:162`](../../../src/prompts.ts#L162) reads the _keys_ of
`INSTRUCTION_SECTIONS`, and no key is added or removed by `readOnly` — only the
`tools_overview` body changes. Leave that line alone.

Add a test to `__tests__/unit/tool-roster.test.ts`:

```ts
test('read-only instructions omit every mutating tool', async () => {
  const { buildServerInstructions } = await import('../../src/resources.js');
  const text = buildServerInstructions(true);
  for (const name of ORACLE_MUTATING_TOOL_NAMES) {
    assert.ok(!text.includes(name), `read-only instructions must not advertise '${name}'`);
  }
});

test('default instructions still list the mutating tools', async () => {
  const { buildServerInstructions } = await import('../../src/resources.js');
  const text = buildServerInstructions(false);
  for (const name of ORACLE_MUTATING_TOOL_NAMES) {
    assert.ok(text.includes(name), `default instructions must advertise '${name}'`);
  }
});
```

The first test is the regression guard for the defect. Confirm it **fails**
against the code as it stands before this step's edits — if it passes before you
change anything, the defect is not where this plan says it is, and that is a STOP.

**Verify**: all three, in this order — `npm test` alone catches neither of the
two cleanup failures this step can leave behind:

1. `npm run type-check` → exit 0 (fails with TS6133 if the `prompts.ts:28`
   specifier was not swapped)
2. `npm run knip` → exit 0 (fails on an unused export if the
   `resources.ts:169` alias was not deleted)
3. `npm test > /tmp/t.log 2>&1; tail -12 /tmp/t.log` → `pass 805`, `fail 0`

## Done

Machine-checkable. All must hold:

- [ ] `npm run format:check` exits 0
- [ ] `npm run type-check` exits 0
- [ ] `npm run lint` exits 0
- [ ] `npm run knip` exits 0 — proves `ALL_TOOLS` is consumed, not orphaned
- [ ] `npm test` exits 0 with `fail 0` and `pass 805`, including the four new
      tests in `__tests__/unit/tool-roster.test.ts`
- [ ] `node scripts/tasks.mjs --quick` exits 0
- [ ] `git status` shows no files outside the [Scope](#scope) list
- [ ] `git diff --stat` shows
      [`__tests__/schemas/__snapshots__/tool-schemas.json`](../../../__tests__/schemas/__snapshots__/tool-schemas.json)
      unchanged
- [ ] `grep -rn "'replace_text'" src/` returns exactly one line,
      [`src/tools/replace-in-files.ts:620`](../../../src/tools/replace-in-files.ts#L620)
      (`name: 'replace_text',`). At `606f71c` that is already true, and Step 6
      must not add a second. The same holds for `'hash_file'`
      ([`calculate-hash.ts:309`](../../../src/tools/calculate-hash.ts#L309)),
      `'search_text'` ([`search-content.ts:394`](../../../src/tools/search-content.ts#L394)),
      `'list_roots'` ([`roots.ts:14`](../../../src/tools/roots.ts#L14)), and
      `'find_files'` ([`search-files.ts:184`](../../../src/tools/search-files.ts#L184))
- [ ] Step 0 is a separate commit from Steps 1-7

## STOP

Stop and report if:

- The code at a [Current state](#current-state) location does not match its
  excerpt.
- A step's verification fails twice after one fix attempt — a second failure
  means the step's assumption is wrong, not its implementation.
- The fix appears to require an out-of-scope file — in particular, if any of the
  twelve tool modules needs its `annotations` block edited. Every one was
  verified to set `readOnlyHint` explicitly; a tool that does not is a different
  problem than this plan describes.
- `__tests__/schemas/__snapshots__/tool-schemas.json` changes. Annotations are
  outside the snapshot, so a diff there means Step 1 altered the emitted input or
  output schema — which it must not.
- The Step 7 regression test (`read-only instructions omit every mutating tool`)
  **passes** before Step 7's source edits are applied. The plan rests on that
  defect existing.
- `MUTATING_TOOL_NAMES` derived in Step 2 does not contain exactly
  `create, delete, edit, move, replace_text`. That set is what `--read-only`
  enforces; a mismatch means the annotations are not the oracle this plan assumes
  they are, and shipping it would change a security control's behavior.
- Step 0's `prettier --write` touches any file outside `src/core/` and `docs/`,
  or more than ten files under `src/core/`.
- Widening `READ_TOOLS` to the seven-name oracle in Step 4 makes
  `keeps non-mutating tools when readOnly:true`
  ([`cli-read-only.test.ts:118`](../../../__tests__/unit/cli-read-only.test.ts#L118))
  fail. That would mean `list_roots` is dropped under `--read-only` — a real
  defect in the gate, outside this plan's scope, and worth its own report.

## Notes

- **What a reviewer should scrutinise**: the `!== true` in Step 2. It is the
  security-relevant line. `=== false` would let a tool that omits `readOnlyHint`
  register under `--read-only`; `!== true` defaults it to mutating. All twelve
  tools currently set the field explicitly, so the two spellings are equivalent
  _today_ — the difference only appears for a thirteenth tool, which is exactly
  the case this plan exists to protect.
- **Deliberately not derived**: the test-side oracle in `helpers.ts`. See
  [the rationale in Current state](#why-the-test-literals-must-not-be-derived) —
  deriving it would silently convert three real assertions into tautologies. The
  new test in Step 3 is what makes the literal list load-bearing rather than
  decorative.
- **Deliberately deferred**: the `Navigate` / `Inspect` / `Read` rows in
  [`buildToolsOverview`](../../../src/resources.ts#L115) stay hand-curated. They
  are editorial and have no runtime consumer, so a seventh derivation would add
  code to remove nothing.
- **Also deferred**: [`README.md`](../../../README.md) documents the tool roster
  for operators. It is not a runtime copy and nothing reads it, but it is a
  seventh place the names appear. If it drifts, that is a docs bug, not this one.
- **Rollback**: no migration, no deletion of data, no production state. Every
  step is reversible with `git revert` of its commit. Step 0 is independent and
  can be kept even if Steps 1-7 are reverted.
