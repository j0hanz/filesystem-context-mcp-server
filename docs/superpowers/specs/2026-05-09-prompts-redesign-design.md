# Prompts Subsystem Redesign

**Date:** 2026-05-09
**Status:** Approved (design)
**Scope:** `src/prompts.ts`, `src/resources/instructions.ts`, `src/server/bootstrap.ts`, prompt-related tests
**Breaking change:** Yes (public surface of `prompts.ts` collapses to a single registry export; prompt set changes from 3 → 5; test assertions move from prose to structure).

---

## 1. Motivation

The current `src/prompts.ts` (210 LOC) is the only first-class MCP concept in this codebase that does **not** follow the established contract+registry pattern used by tools (`src/tools.ts` + `src/tools/contract.ts`) and resources (`src/resources/*` + `ResourceContract`). It has three named register functions wired explicitly into `bootstrap.ts`, duplicated `completable()` boilerplate for path arguments, and a fragile `SECTION_HEADER_RE` regex that re-parses the rendered server instructions string to find `get-help` topics.

Prompt content is also a single inline `text` block per prompt — leaving the MCP SDK's richer `PromptMessage` content blocks (`resource_link`, embedded `resource`, multi-message) entirely unused. As a result, workflow prompts duplicate guidance that already lives in `internal://instructions`.

This redesign aligns prompts with the rest of the codebase, eliminates duplication, replaces prose-coupled tests with structural ones, and expands the prompt set from 3 to 5 to cover the most common filesystem workflows.

## 2. Goals & non-goals

### Goals

- Single-file `src/prompts.ts` that fully owns the prompt subsystem.
- Contract-driven internal layout (parallel to `ToolContract` / `ResourceContract`) without separate per-prompt files.
- One `registerAllPrompts(server, options)` export consumed by `bootstrap.ts`.
- Eliminate the duplicated path-`completable` boilerplate via a single helper.
- Replace the regex topic parser with a typed `INSTRUCTION_SECTIONS` map exported from `src/resources/instructions.ts`.
- Use `resource_link` content blocks where they remove prose duplication.
- Path-guard every path argument before it appears in any returned message.
- Strict argument validation via `z.strictObject` for every prompt.
- Five prompts in the shipped set: `get-help`, `analyze-path`, `compare-files`, `find-in-tree`, `summarize-directory`.

### Non-goals

- No `prompts/list_changed` notifications (set is static).
- No prompt category taxonomy / `_meta.category`.
- No multi-turn assistant pre-fills.
- No icon system rework.
- No new prompts beyond the five listed above.

## 3. Architecture

### 3.1 Module shape

Everything lives in `src/prompts.ts`. No `src/prompts/` directory.

Internal organization (top to bottom):

1. Imports.
2. File-local types: `PromptContract`, `PromptRegistrationOptions`, `PromptEntry`.
3. Helpers: `pathArg`, `topicArg`, `userText`, `linkToInstructions`, `linkToPath`, `wrapHandler`.
4. Five `PromptEntry` consts (contract metadata + inline `register` arrow).
5. Registry: `PROMPT_ENTRIES`, `ALL_PROMPTS`, `registerAllPrompts`.

Public exports: `registerAllPrompts`, `ALL_PROMPTS`, `PromptContract` (type only).
Removed exports: `registerGetHelpPrompt`, `registerCompareFilesPrompt`, `registerAnalyzePathPrompt`.

### 3.2 Types

```ts
interface PromptContract {
  name: string;
  title: string;
  description: string;
  argsSchema?: z.ZodObject;
  requiresPathGuard?: boolean;
  icons?: Icon[];
}

interface PromptRegistrationOptions {
  pathGuard: PathGuard;
  instructions: string; // SERVER_INSTRUCTIONS_CONTENT
  isInitialized: () => boolean;
  iconInfo?: IconInfo;
}

interface PromptEntry {
  contract: PromptContract;
  register: (server: McpServer, options: PromptRegistrationOptions) => void;
}
```

### 3.3 Helpers (inline in `prompts.ts`)

- `pathArg(server, guard, name, description)` — wraps `z.string()` with `completable()` and `completePathCached`. Replaces the 7-line block currently duplicated 3× (will be 5+× without it).
- `topicArg(topics, description)` — `completable` over a static topic list.
- `userText(text)` — builds `{ role: 'user', content: { type: 'text', text, annotations: { audience: ['assistant'], priority: 1 } } }`.
- `linkToInstructions()` — returns a `resource_link` user message with `uri: 'internal://instructions'`.
- `linkToPath(absPath)` — returns a `resource_link` user message with `uri: file://<absPath>` (assumes path already resolved through `pathGuard`).
- `wrapHandler(name, fn)` — emits `Logger.debug('prompt resolved', { name, durationMs })`; checks `isInitialized()` for prompts marked `requiresPathGuard`.

### 3.4 Instruction sections refactor (`src/resources/instructions.ts`)

Export both:

```ts
export const INSTRUCTION_SECTIONS: Record<string, string> = {
  guidelines: '...',
  tools_overview: '...',
  constraints: '...',
  error_recovery: '...',
};
export const SERVER_INSTRUCTIONS_CONTENT = renderSections(INSTRUCTION_SECTIONS);
```

The `internal://instructions` resource keeps using `SERVER_INSTRUCTIONS_CONTENT`; `get-help` consumes `INSTRUCTION_SECTIONS` directly. The `SECTION_HEADER_RE`, `findSectionStarts`, `filterInstructionsByTopic`, `extractTopics` helpers are deleted from `prompts.ts`.

### 3.5 Bootstrap integration

`src/server/bootstrap.ts`:

```diff
- registerGetHelpPrompt(server, serverInstructionsContent, localIcon);
- registerCompareFilesPrompt(server, rootsManager.pathGuard, localIcon);
- registerAnalyzePathPrompt(server, rootsManager.pathGuard, localIcon);
+ registerAllPrompts(server, {
+   pathGuard: rootsManager.pathGuard,
+   instructions: serverInstructionsContent,
+   isInitialized: () => rootsManager.isInitialized(),
+   ...(localIcon ? { iconInfo: localIcon } : {}),
+ });
```

## 4. Prompt specifications

Common conventions for every prompt:

- `argsSchema` is `z.strictObject(...)`.
- All path arguments are resolved via `pathGuard.resolveSecurePath(raw)` inside the handler **before** any message is constructed.
- A failed path resolution throws — the SDK surfaces it as a `prompts/get` error.
- Workflow prompts include a trailing `resource_link` to `internal://instructions` so the LLM can pull guidance on demand instead of receiving duplicated prose.

### 4.1 `get-help`

|              |                                                                                                                          |
| ------------ | ------------------------------------------------------------------------------------------------------------------------ |
| Title        | Get Help                                                                                                                 |
| Description  | Return filesystem-mcp usage instructions, optionally filtered to a section.                                              |
| Args         | `topic?: string` — `completable` over `Object.keys(INSTRUCTION_SECTIONS)`.                                               |
| Path-guarded | No                                                                                                                       |
| Messages     | `[ userText(section ?? full) ]`                                                                                          |
| Notes        | Topic resolution is a strict key lookup; on miss, returns the full instructions plus a one-line note listing valid keys. |

### 4.2 `analyze-path`

|              |                                                                                                      |
| ------------ | ---------------------------------------------------------------------------------------------------- |
| Title        | Analyze Path                                                                                         |
| Description  | Workflow for analyzing a file or directory using stat / read / tree.                                 |
| Args         | `path: string` — `pathArg`.                                                                          |
| Path-guarded | Yes                                                                                                  |
| Behavior     | Resolves `path`; runs one `fs.stat` to detect kind.                                                  |
| Messages     | `[ userText(taskTailoredToKind), linkToPath(resolved), linkToInstructions() ]`                       |
| Notes        | Branches the task statement on `isFile` vs `isDirectory` instead of dumping a generic numbered list. |

### 4.3 `compare-files`

|              |                                                                                                                                                                                                                 |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title        | Compare Files                                                                                                                                                                                                   |
| Description  | Workflow for comparing two files using diff_files.                                                                                                                                                              |
| Args         | `original: string`, `modified: string` — both `pathArg`.                                                                                                                                                        |
| Path-guarded | Yes                                                                                                                                                                                                             |
| Messages     | `[ userText("Call diff_files with - original: $1\n- modified: $2 …"), linkToPath(original), linkToPath(modified) ]`                                                                                             |
| Notes        | Text retains the `- original:` / `- modified:` substrings for backward-recognizable intent; tests assert the structure (3 messages, 2 `resource_link`s with the expected `file://` URIs) rather than the prose. |

### 4.4 `find-in-tree` (NEW)

|              |                                                                                                                               |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| Title        | Find in Tree                                                                                                                  |
| Description  | Locate files and matches by name and content under a directory.                                                               |
| Args         | `query: string`; `root?: string` (defaults to first allowed root); `mode?: 'name' \| 'content' \| 'both'` (default `'both'`). |
| Path-guarded | Yes (`root`)                                                                                                                  |
| Messages     | `[ userText(modeBranchedTask), linkToInstructions() ]`                                                                        |
| Notes        | Collapses the common LLM dance of stitching `find` + `grep` into one prompt.                                                  |

### 4.5 `summarize-directory` (NEW)

|              |                                                                                                                                                                                                                                              |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Title        | Summarize Directory                                                                                                                                                                                                                          |
| Description  | Onboarding summary: tech stack, entry points, structure.                                                                                                                                                                                     |
| Args         | `path: string` (`pathArg`), `depth?: number` — `z.number().int().min(1).max(6).default(3)`.                                                                                                                                                  |
| Path-guarded | Yes                                                                                                                                                                                                                                          |
| Behavior     | Resolves `path`; rejects non-directories with a structured error.                                                                                                                                                                            |
| Messages     | `[ userText("Summarize this project at $path. Call tree (maxDepth=$depth), then read_many for README/package.json/Cargo.toml/pyproject.toml/etc. Produce: purpose, tech stack, entry points, notable directories."), linkToPath(resolved) ]` |

## 5. Security & validation

- Path arguments never reach a returned message without going through `pathGuard.resolveSecurePath`. This gives prompts the same denylist/symlink/sensitive-file guarantees as tools.
- `z.strictObject` rejects unknown keys (parity with the tool schemas migrated in commit `86f6fe8`).
- Filesystem-touching prompts (`analyze-path`, `summarize-directory`, `compare-files`, `find-in-tree`) check `isInitialized()` and fail early if roots aren't settled.

## 6. Observability

- One `Logger.debug('prompt resolved', { name, durationMs })` call per invocation, emitted from `wrapHandler` so no individual prompt has logging boilerplate.
- No new metrics or progress events (prompts are synchronous and cheap).

## 7. Test plan

`__tests__/prompts.test.ts`:

- Listing test asserts the new 5-name set: `analyze-path`, `compare-files`, `find-in-tree`, `get-help`, `summarize-directory`.
- For each prompt: assert `messages.length`, each message's `content.type`, and for `resource_link` messages, the exact `uri`.
- Drop prose-matching `assert.match(/Call diff_files/)` style assertions.
- Add path-guard rejection cases (`analyze-path` with a path outside allowed roots).

`__tests__/contract.test.ts`:

- Add a `prompts contract` block parallel to the tools contract block, asserting `ALL_PROMPTS` shape: name, title, description present and non-empty; `requiresPathGuard` set correctly per prompt.

`__tests__/unit/completions.test.ts`:

- Replace the direct `registerGetHelpPrompt` import with `registerAllPrompts` and assert completion behavior end-to-end via the registry.

`__tests__/prompts-stdio.test.ts`:

- Update prompt count assertion from 3 → 5; otherwise unchanged.

## 8. Migration

This is a breaking change inside the package; only `bootstrap.ts` and tests consume the prompt registration symbols. Consumers external to this repo do not import `prompts.ts`. Version bump: minor (per `package.json` semver discipline; the MCP wire surface only adds two prompts, which is additive for clients but the prose of existing prompts changes).

## 9. Rollout

1. Refactor `src/resources/instructions.ts` to export `INSTRUCTION_SECTIONS`.
2. Rewrite `src/prompts.ts` end-to-end.
3. Update `src/server/bootstrap.ts` call site.
4. Update tests.
5. `node scripts/tasks.mjs --fix` until clean.

## 10. Open questions

None — answered during brainstorming:

- Single-file layout: confirmed.
- Prompt set: 5 prompts confirmed.
- Content shape: text + `resource_link`, no multi-turn pre-fill.
