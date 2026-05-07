---
goal: Align filesystem MCP tool schemas, runtime behavior, prompts, README documentation, and schema drift tests with the current MCP v2 public contract.
version: 1
date_created: 2026-05-07
status: Planned
plan_type: refactor
component: tool-schema-contract
---

# Implementation Plan: Tool Schema Contract Refinement

## 1. Goal

Make every inspector-visible tool field either perform the documented behavior or disappear from public guidance. The implementation must wire currently ignored search controls, remove parameter-name drift between schemas, prompts, and docs, clarify ephemeral resource and cursor semantics, and add tests that catch future schema drift before release.

## 2. Requirements & Constraints

|                    ID                     | Type        | Statement                                                                                                                                                                           |
| :---------------------------------------: | :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`REQ-001`](#2-requirements--constraints) | Requirement | Public tool input fields in [GrepInputSchema](src/schemas/inputs.ts#L156) and [SearchAndReplaceInputSchema](src/schemas/inputs.ts#L194) must affect runtime behavior when supplied. |
| [`REQ-002`](#2-requirements--constraints) | Requirement | Public examples in [README.md](README.md) and prompt text in [registerCompareFilesPrompt](src/prompts.ts#L109) must use current tool argument shapes.                               |
| [`REQ-003`](#2-requirements--constraints) | Requirement | Generated `tools/list` schema tests must serialize meaningful JSON schema data instead of empty wrapper objects.                                                                    |
| [`CON-001`](#2-requirements--constraints) | Constraint  | Keep MCP v2 patterns: split package imports, `z.strictObject` schemas, `registerTool` registration through existing helpers, and no `@modelcontextprotocol/sdk` imports.            |
| [`CON-002`](#2-requirements--constraints) | Constraint  | Preserve existing tool names and accepted field names; do not introduce aliases unless a task explicitly adds and tests deprecation behavior.                                       |
| [`SEC-001`](#2-requirements--constraints) | Security    | Search and replace changes must continue to use existing path validation, sensitive-file denylist, ignored-file behavior, and RE2 matching.                                         |
| [`PAT-001`](#2-requirements--constraints) | Pattern     | Follow [defineTool](src/tools/define-tool.ts) through existing tool contracts because it centralizes validation, structured output checks, diagnostics, and task support.           |
| [`PAT-002`](#2-requirements--constraints) | Pattern     | Follow [buildListFingerprint](src/tools/list-directory.ts#L64) as the documented contrast for snapshot-backed cursor behavior.                                                      |

## 3. Current Context

### Relevant files

| File                                                                                                 | Why it matters                                                                    |
| :--------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------------- |
| [src/schemas/inputs.ts](src/schemas/inputs.ts)                                                       | Defines inspector-visible tool inputs and defaults.                               |
| [src/schemas/outputs.ts](src/schemas/outputs.ts)                                                     | Defines structured outputs and `stoppedReason` enums.                             |
| [src/lib/file-operations/search.ts](src/lib/file-operations/search.ts)                               | Implements content search traversal and option validation.                        |
| [src/tools/search-content.ts](src/tools/search-content.ts)                                           | Maps `grep` tool inputs into content-search options and tool docs.                |
| [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts)                                       | Implements `search_and_replace` traversal, replacement, diff, and output shaping. |
| [src/prompts.ts](src/prompts.ts)                                                                     | Generates user-facing prompt workflows that reference tool argument shapes.       |
| [src/resources/instructions-content.ts](src/resources/instructions-content.ts)                       | Generates `internal://instructions` recovery and resource guidance.               |
| [src/lib/resource-store.ts](src/lib/resource-store.ts)                                               | Defines cached result TTL, size limits, and eviction behavior.                    |
| [src/schemas/pagination.ts](src/schemas/pagination.ts)                                               | Defines cursor schema descriptions used by paginated tools.                       |
| [src/tools/list-directory.ts](src/tools/list-directory.ts)                                           | Implements snapshot-backed `ls` cursor behavior.                                  |
| [src/tools/search-files.ts](src/tools/search-files.ts)                                               | Implements offset-backed `find` cursor behavior.                                  |
| [src/schemas/json-schema.ts](src/schemas/json-schema.ts)                                             | Converts Zod schemas to MCP Standard Schema registrations.                        |
| [README.md](README.md)                                                                               | Documents the public MCP surface for users and agents.                            |
| [**tests**/tools/search.test.ts](__tests__/tools/search.test.ts)                                     | Covers `grep`, `find`, and `search_and_replace` behavior.                         |
| [**tests**/prompts.test.ts](__tests__/prompts.test.ts)                                               | Covers registered prompt behavior.                                                |
| [**tests**/resources/instructions-content.test.ts](__tests__/resources/instructions-content.test.ts) | Covers generated server instructions.                                             |
| [**tests**/schemas/snapshot.test.ts](__tests__/schemas/snapshot.test.ts)                             | Owns schema snapshot coverage.                                                    |
| [**tests**/contract.test.ts](__tests__/contract.test.ts)                                             | Covers `tools/list` contract expectations.                                        |
| [**tests**/tools/directory.test.ts](__tests__/tools/directory.test.ts)                               | Covers directory listing and pagination behavior.                                 |
| [**tests**/tools/refinements.test.ts](__tests__/tools/refinements.test.ts)                           | Covers externalized result behavior and resource links.                           |

### Relevant symbols

| Symbol                                                                      | Why it matters                                                                                    |
| :-------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------ |
| [GrepInputSchema](src/schemas/inputs.ts#L156)                               | Exposes `grep.maxDepth`, `pattern`, and `searchPattern`.                                          |
| [SearchAndReplaceInputSchema](src/schemas/inputs.ts#L194)                   | Exposes `search_and_replace.maxDepth`, `maxResults`, and `pattern`.                               |
| [TreeInputSchema](src/schemas/inputs.ts#L82)                                | Contains the stale `maxDepth` default description.                                                |
| [DEFAULT_TREE_DEPTH](src/lib/constants.ts#L221)                             | Holds the actual tree depth default.                                                              |
| [SearchOptionsSchema](src/lib/file-operations/search.ts#L155)               | Validates content-search options before traversal.                                                |
| [SearchContentOptions](src/lib/file-operations/search.ts#L174)              | Public internal option type passed into [searchContent](src/lib/file-operations/search.ts#L1242). |
| [executeSearch](src/tools/search-content.ts#L295)                           | Maps `grep` args into [searchContent](src/lib/file-operations/search.ts#L1242).                   |
| [handleSearchContent](src/tools/search-content.ts#L358)                     | Builds `grep` response and resource externalization.                                              |
| [SEARCH_CONTENT_TOOL](src/tools/search-content.ts#L141)                     | Holds `grep` tool description, nuances, and gotchas.                                              |
| [SEARCH_AND_REPLACE_TOOL](src/tools/replace-in-files.ts#L43)                | Holds `search_and_replace` tool description and gotchas.                                          |
| [processEntriesConcurrently](src/tools/replace-in-files.ts#L341)            | Dispatches candidate files for replacement.                                                       |
| [handleSearchAndReplace](src/tools/replace-in-files.ts#L449)                | Maps `search_and_replace` args into traversal and replacement.                                    |
| [buildSearchAndReplaceStructuredResult](src/tools/replace-in-files.ts#L586) | Emits replacement counts, failures, diff, and stop reason.                                        |
| [registerCompareFilesPrompt](src/prompts.ts#L109)                           | Emits the stale `diff_files` workflow text.                                                       |
| [buildSlimInstructions](src/resources/instructions-content.ts#L38)          | Emits resource and recovery guidance.                                                             |
| [createInMemoryResourceStore](src/lib/resource-store.ts#L104)               | Implements result cache TTL and eviction.                                                         |
| [CursorSchema](src/schemas/pagination.ts#L5)                                | Describes incoming pagination cursors.                                                            |
| [NextCursorSchema](src/schemas/pagination.ts#L10)                           | Describes outgoing pagination cursors.                                                            |
| [handleSearchFiles](src/tools/search-files.ts#L109)                         | Implements offset cursor paging for `find`.                                                       |
| [encodeOffsetCursor](src/tools/shared.ts#L1020)                             | Encodes offset cursors for `find`.                                                                |
| [decodeOffsetCursor](src/tools/shared.ts#L1024)                             | Decodes offset cursors for `find`.                                                                |
| [toToolJsonSchema](src/schemas/json-schema.ts#L48)                          | Produces Standard Schema objects used by registration.                                            |
| [buildSnapshot](__tests__/schemas/snapshot.test.ts#L13)                     | Currently snapshots wrapper objects that serialize as empty schemas.                              |

### Existing commands

```bash
# Fast static validation
node scripts/tasks.mjs --quick

# Targeted search behavior tests
node --test --import tsx/esm __tests__/tools/search.test.ts

# Targeted prompt tests
node --test --import tsx/esm __tests__/prompts.test.ts

# Targeted schema snapshot tests
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts

# Full repository validation
node scripts/tasks.mjs
```

### Current behavior

`grep.maxDepth`, `search_and_replace.maxDepth`, and `search_and_replace.maxResults` are visible in `tools/list`, but the current handlers do not apply all of them. Several human-facing docs still use older argument names such as `filePattern`, `original`, `modified`, `source`, or a stale tree default. The schema snapshot test does not currently catch these mismatches because it snapshots empty Standard Schema wrapper output.

## 4. Implementation Phases

Each phase contains atomic tasks. Execute tasks in order unless the `Depends on` field says `none`.

### PHASE-001: Runtime Contract Alignment

Goal: Make exposed search controls change runtime behavior and prove the behavior with targeted tests.

|                      Task                      | Action                                                                          |                 Depends on                 | Files                                                                                                                                                                                                | Validate                                                      |
| :--------------------------------------------: | :------------------------------------------------------------------------------ | :----------------------------------------: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------ |
|    [`TASK-001`](#task-001-wire-grep-depth)     | Wire `grep.maxDepth` through content search.                                    |                    none                    | [src/lib/file-operations/search.ts](src/lib/file-operations/search.ts); [src/tools/search-content.ts](src/tools/search-content.ts); [**tests**/tools/search.test.ts](__tests__/tools/search.test.ts) | `node --test --import tsx/esm __tests__/tools/search.test.ts` |
|   [`TASK-002`](#task-002-wire-replace-depth)   | Wire `search_and_replace.maxDepth` into file traversal.                         |                    none                    | [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [**tests**/tools/search.test.ts](__tests__/tools/search.test.ts)                                                                     | `node --test --import tsx/esm __tests__/tools/search.test.ts` |
| [`TASK-003`](#task-003-wire-replace-match-cap) | Enforce `search_and_replace.maxResults` and emit `stoppedReason: "maxResults"`. | [`TASK-002`](#task-002-wire-replace-depth) | [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [src/schemas/outputs.ts](src/schemas/outputs.ts); [**tests**/tools/search.test.ts](__tests__/tools/search.test.ts)                   | `node --test --import tsx/esm __tests__/tools/search.test.ts` |

#### TASK-001: Wire grep depth

| Field           | Value                                                                                                                                                                                                                                                                                     |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                                                                      |
| Files           | [src/lib/file-operations/search.ts](src/lib/file-operations/search.ts); [src/tools/search-content.ts](src/tools/search-content.ts); [**tests**/tools/search.test.ts](__tests__/tools/search.test.ts)                                                                                      |
| Symbols         | [GrepInputSchema](src/schemas/inputs.ts#L156); [SearchOptionsSchema](src/lib/file-operations/search.ts#L155); [SearchContentOptions](src/lib/file-operations/search.ts#L174); [executeSearch](src/tools/search-content.ts#L295); [searchContent](src/lib/file-operations/search.ts#L1242) |
| Action          | Add optional depth support to content-search options, pass `args.maxDepth` from [executeSearch](src/tools/search-content.ts#L295), and add a test proving `maxDepth: 0` excludes nested matches while an omitted depth still finds them.                                                  |
| Validate        | Run `node --test --import tsx/esm __tests__/tools/search.test.ts`                                                                                                                                                                                                                         |
| Expected result | The new `grep.maxDepth` test passes and existing grep tests still pass.                                                                                                                                                                                                                   |

#### TASK-002: Wire replace depth

| Field           | Value                                                                                                                                                                                             |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | none                                                                                                                                                                                              |
| Files           | [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [**tests**/tools/search.test.ts](__tests__/tools/search.test.ts)                                                                  |
| Symbols         | [SearchAndReplaceInputSchema](src/schemas/inputs.ts#L194); [handleSearchAndReplace](src/tools/replace-in-files.ts#L449)                                                                           |
| Action          | Pass `args.maxDepth` into the `globEntries` call inside [handleSearchAndReplace](src/tools/replace-in-files.ts#L449) and add a dry-run test proving nested files are excluded when depth is zero. |
| Validate        | Run `node --test --import tsx/esm __tests__/tools/search.test.ts`                                                                                                                                 |
| Expected result | The new `search_and_replace.maxDepth` test passes and no existing replacement test changes expected output.                                                                                       |

#### TASK-003: Wire replace match cap

| Field           | Value                                                                                                                                                                                                    |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-002`](#task-002-wire-replace-depth)                                                                                                                                                               |
| Files           | [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [src/schemas/outputs.ts](src/schemas/outputs.ts); [**tests**/tools/search.test.ts](__tests__/tools/search.test.ts)                       |
| Symbols         | [SearchAndReplaceInputSchema](src/schemas/inputs.ts#L194); [processEntriesConcurrently](src/tools/replace-in-files.ts#L341); [buildSearchAndReplaceStructuredResult](src/tools/replace-in-files.ts#L586) |
| Action          | Stop dispatching replacement work after the configured match cap is reached, set `stoppedReason` to `maxResults`, and add a dry-run test that observes the cap and stop reason.                          |
| Validate        | Run `node --test --import tsx/esm __tests__/tools/search.test.ts`                                                                                                                                        |
| Expected result | The capped replacement test returns `stoppedReason: "maxResults"` and reports no more matches than the requested cap.                                                                                    |

### PHASE-002: Public Guidance Alignment

Goal: Make tool descriptions, prompts, README tables, resource guidance, and cursor guidance match the actual schema and runtime semantics.

|                         Task                         | Action                                                                |                                                                                                                 Depends on                                                                                                                  | Files                                                                                                                                                                                                                                                                                                                    | Validate                                                                                                            |
| :--------------------------------------------------: | :-------------------------------------------------------------------- | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------ |
| [`TASK-004`](#task-004-fix-tree-default-description) | Derive the tree default description from the actual constant.         |                                                                                                                    none                                                                                                                     | [src/schemas/inputs.ts](src/schemas/inputs.ts); [src/lib/constants.ts](src/lib/constants.ts); [**tests**/contract.test.ts](__tests__/contract.test.ts)                                                                                                                                                                   | `node --test --import tsx/esm __tests__/contract.test.ts`                                                           |
|  [`TASK-005`](#task-005-normalize-pattern-language)  | Replace stale `filePattern` wording with current field names.         |                                                                                                   [`TASK-001`](#task-001-wire-grep-depth)                                                                                                   | [src/tools/search-content.ts](src/tools/search-content.ts); [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [**tests**/contract.test.ts](__tests__/contract.test.ts)                                                                                                                                     | `node --test --import tsx/esm __tests__/contract.test.ts`                                                           |
|   [`TASK-006`](#task-006-fix-compare-files-prompt)   | Update `compare-files` prompt text to call `diff_files` with `paths`. |                                                                                                                    none                                                                                                                     | [src/prompts.ts](src/prompts.ts); [**tests**/prompts.test.ts](__tests__/prompts.test.ts)                                                                                                                                                                                                                                 | `node --test --import tsx/esm __tests__/prompts.test.ts`                                                            |
|  [`TASK-007`](#task-007-refresh-readme-tool-tables)  | Rewrite stale README tool tables to match `tools/list`.               | [`TASK-001`](#task-001-wire-grep-depth); [`TASK-002`](#task-002-wire-replace-depth); [`TASK-003`](#task-003-wire-replace-match-cap); [`TASK-004`](#task-004-fix-tree-default-description); [`TASK-006`](#task-006-fix-compare-files-prompt) | [README.md](README.md)                                                                                                                                                                                                                                                                                                   | `node scripts/tasks.mjs --quick`                                                                                    |
|  [`TASK-008`](#task-008-clarify-resource-lifetime)   | Clarify cached result lifetime in generated instructions.             |                                                                                                                    none                                                                                                                     | [src/resources/instructions-content.ts](src/resources/instructions-content.ts); [src/lib/resource-store.ts](src/lib/resource-store.ts); [**tests**/resources/instructions-content.test.ts](__tests__/resources/instructions-content.test.ts); [**tests**/tools/refinements.test.ts](__tests__/tools/refinements.test.ts) | `node --test --import tsx/esm __tests__/resources/instructions-content.test.ts __tests__/tools/refinements.test.ts` |
|  [`TASK-009`](#task-009-document-cursor-semantics)   | Document cursor reuse rules for snapshot and offset cursors.          |                                                                                                                    none                                                                                                                     | [src/schemas/pagination.ts](src/schemas/pagination.ts); [src/tools/list-directory.ts](src/tools/list-directory.ts); [src/tools/search-files.ts](src/tools/search-files.ts); [README.md](README.md); [**tests**/tools/directory.test.ts](__tests__/tools/directory.test.ts)                                               | `node --test --import tsx/esm __tests__/tools/directory.test.ts`                                                    |

#### TASK-004: Fix tree default description

| Field           | Value                                                                                                                                                                                                                                         |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                          |
| Files           | [src/schemas/inputs.ts](src/schemas/inputs.ts); [src/lib/constants.ts](src/lib/constants.ts); [**tests**/contract.test.ts](__tests__/contract.test.ts)                                                                                        |
| Symbols         | [TreeInputSchema](src/schemas/inputs.ts#L82); [DEFAULT_TREE_DEPTH](src/lib/constants.ts#L221)                                                                                                                                                 |
| Action          | Change [TreeInputSchema](src/schemas/inputs.ts#L82) so the `maxDepth` description uses [DEFAULT_TREE_DEPTH](src/lib/constants.ts#L221) rather than a hard-coded value, then assert `tools/list` exposes the matching default and description. |
| Validate        | Run `node --test --import tsx/esm __tests__/contract.test.ts`                                                                                                                                                                                 |
| Expected result | The contract test observes tree `maxDepth.default === 5` and no description says default 4.                                                                                                                                                   |

#### TASK-005: Normalize pattern language

| Field           | Value                                                                                                                                                                                                       |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-001`](#task-001-wire-grep-depth)                                                                                                                                                                     |
| Files           | [src/tools/search-content.ts](src/tools/search-content.ts); [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [**tests**/contract.test.ts](__tests__/contract.test.ts)                        |
| Symbols         | [SEARCH_CONTENT_TOOL](src/tools/search-content.ts#L141); [SEARCH_AND_REPLACE_TOOL](src/tools/replace-in-files.ts#L43)                                                                                       |
| Action          | Update tool descriptions, nuances, and gotchas to say `pattern` is the file glob and `searchPattern` is the text or regex, then add a contract assertion that no tool description references `filePattern`. |
| Validate        | Run `node --test --import tsx/esm __tests__/contract.test.ts`                                                                                                                                               |
| Expected result | `tools/list` descriptions and contract tests use `pattern` and `searchPattern` consistently.                                                                                                                |

#### TASK-006: Fix compare-files prompt

| Field           | Value                                                                                                                                                                                         |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                          |
| Files           | [src/prompts.ts](src/prompts.ts); [**tests**/prompts.test.ts](__tests__/prompts.test.ts)                                                                                                      |
| Symbols         | [registerCompareFilesPrompt](src/prompts.ts#L109); [DiffFilesInputSchema](src/schemas/inputs.ts#L255)                                                                                         |
| Action          | Rewrite the prompt body so it instructs callers to pass `paths: [original, modified]` to `diff_files`, then add a test that rejects `original:` and `modified:` in the generated prompt text. |
| Validate        | Run `node --test --import tsx/esm __tests__/prompts.test.ts`                                                                                                                                  |
| Expected result | The compare prompt contains `paths: [` and does not contain stale `original:` or `modified:` tool arguments.                                                                                  |

#### TASK-007: Refresh README tool tables

| Field           | Value                                                                                                                                                                                                                                                                                                                          |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-001`](#task-001-wire-grep-depth); [`TASK-002`](#task-002-wire-replace-depth); [`TASK-003`](#task-003-wire-replace-match-cap); [`TASK-004`](#task-004-fix-tree-default-description); [`TASK-006`](#task-006-fix-compare-files-prompt)                                                                                    |
| Files           | [README.md](README.md)                                                                                                                                                                                                                                                                                                         |
| Symbols         | [GrepInputSchema](src/schemas/inputs.ts#L156); [SearchAndReplaceInputSchema](src/schemas/inputs.ts#L194); [DiffFilesInputSchema](src/schemas/inputs.ts#L255); [ApplyPatchInputSchema](src/schemas/inputs.ts#L267); [CreateDirectoryInputSchema](src/schemas/inputs.ts#L313); [MoveFileInputSchema](src/schemas/inputs.ts#L320) |
| Action          | Update the `grep`, `mkdir`, `mv`, `diff_files`, `apply_patch`, and `search_and_replace` README tables to match current schema names, required fields, defaults, and bounds.                                                                                                                                                    |
| Validate        | Run `node scripts/tasks.mjs --quick`                                                                                                                                                                                                                                                                                           |
| Expected result | Static checks pass and README no longer documents `filePattern`, `source`, `original`, `modified`, `fuzzFactor` 20, or `autoConvertLineEndings` default true.                                                                                                                                                                  |

#### TASK-008: Clarify resource lifetime

| Field           | Value                                                                                                                                                                                                                                                                                                                    |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                                                                                                     |
| Files           | [src/resources/instructions-content.ts](src/resources/instructions-content.ts); [src/lib/resource-store.ts](src/lib/resource-store.ts); [**tests**/resources/instructions-content.test.ts](__tests__/resources/instructions-content.test.ts); [**tests**/tools/refinements.test.ts](__tests__/tools/refinements.test.ts) |
| Symbols         | [buildSlimInstructions](src/resources/instructions-content.ts#L38); [createInMemoryResourceStore](src/lib/resource-store.ts#L104); [handleSearchContent](src/tools/search-content.ts#L358)                                                                                                                               |
| Action          | Change generated instructions to say cached `resourceUri` values are ephemeral and may expire by TTL, cache eviction, or server restart; keep the existing `expiresAt` resource-link behavior covered by tests.                                                                                                          |
| Validate        | Run `node --test --import tsx/esm __tests__/resources/instructions-content.test.ts __tests__/tools/refinements.test.ts`                                                                                                                                                                                                  |
| Expected result | Instruction tests assert TTL, eviction, and restart wording, and refinement tests still observe `Expires:` in resource links.                                                                                                                                                                                            |

#### TASK-009: Document cursor semantics

| Field           | Value                                                                                                                                                                                                                                                                                                           |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                                                                                            |
| Files           | [src/schemas/pagination.ts](src/schemas/pagination.ts); [src/tools/list-directory.ts](src/tools/list-directory.ts); [src/tools/search-files.ts](src/tools/search-files.ts); [README.md](README.md); [**tests**/tools/directory.test.ts](__tests__/tools/directory.test.ts)                                      |
| Symbols         | [CursorSchema](src/schemas/pagination.ts#L5); [NextCursorSchema](src/schemas/pagination.ts#L10); [buildListFingerprint](src/tools/list-directory.ts#L64); [handleSearchFiles](src/tools/search-files.ts#L109); [encodeOffsetCursor](src/tools/shared.ts#L1020); [decodeOffsetCursor](src/tools/shared.ts#L1024) |
| Action          | Document that cursors are opaque and must be reused only with the same tool, same filters, and a stable target tree; state that `ls` uses a snapshot-backed cursor and `find` uses an offset cursor over a rerun search.                                                                                        |
| Validate        | Run `node --test --import tsx/esm __tests__/tools/directory.test.ts`                                                                                                                                                                                                                                            |
| Expected result | Directory pagination tests still pass and documentation describes both cursor modes without changing cursor encoding.                                                                                                                                                                                           |

### PHASE-003: Drift Detection

Goal: Add tests that fail when inspector-visible schemas or guidance drift from source behavior.

|                         Task                          | Action                                                   |                                                Depends on                                                | Files                                                                                                                                                                                                                                | Validate                                                                                     |
| :---------------------------------------------------: | :------------------------------------------------------- | :------------------------------------------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------- |
| [`TASK-010`](#task-010-replace-empty-schema-snapshot) | Snapshot actual `tools/list` schema data.                | [`TASK-004`](#task-004-fix-tree-default-description); [`TASK-005`](#task-005-normalize-pattern-language) | [**tests**/schemas/snapshot.test.ts](__tests__/schemas/snapshot.test.ts); [src/schemas/json-schema.ts](src/schemas/json-schema.ts); [**tests**/contract.test.ts](__tests__/contract.test.ts)                                         | `node --test --import tsx/esm __tests__/schemas/snapshot.test.ts __tests__/contract.test.ts` |
|      [`TASK-011`](#task-011-run-full-validation)      | Run the repository task runner after all contract edits. |                          [`TASK-010`](#task-010-replace-empty-schema-snapshot)                           | [README.md](README.md); [src/schemas/inputs.ts](src/schemas/inputs.ts); [src/tools/search-content.ts](src/tools/search-content.ts); [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [src/prompts.ts](src/prompts.ts) | `node scripts/tasks.mjs`                                                                     |

#### TASK-010: Replace empty schema snapshot

| Field           | Value                                                                                                                                                                                                                                                                                                                       |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-004`](#task-004-fix-tree-default-description); [`TASK-005`](#task-005-normalize-pattern-language)                                                                                                                                                                                                                    |
| Files           | [**tests**/schemas/snapshot.test.ts](__tests__/schemas/snapshot.test.ts); [src/schemas/json-schema.ts](src/schemas/json-schema.ts); [**tests**/contract.test.ts](__tests__/contract.test.ts)                                                                                                                                |
| Symbols         | [buildSnapshot](__tests__/schemas/snapshot.test.ts#L13); [toToolJsonSchema](src/schemas/json-schema.ts#L48)                                                                                                                                                                                                                 |
| Action          | Change [buildSnapshot](__tests__/schemas/snapshot.test.ts#L13) to snapshot serializable inspector-visible schema data from `client.listTools()` or the underlying JSON schema object, then assert representative properties such as `grep.searchPattern`, `tree.maxDepth.default`, and `search_and_replace.dryRun.default`. |
| Validate        | Run `node --test --import tsx/esm __tests__/schemas/snapshot.test.ts __tests__/contract.test.ts`                                                                                                                                                                                                                            |
| Expected result | Snapshot tests fail before stale schema changes are accepted and pass with non-empty schema properties.                                                                                                                                                                                                                     |

#### TASK-011: Run full validation

| Field           | Value                                                                                                                                                                                                                                |
| :-------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [`TASK-010`](#task-010-replace-empty-schema-snapshot)                                                                                                                                                                                |
| Files           | [README.md](README.md); [src/schemas/inputs.ts](src/schemas/inputs.ts); [src/tools/search-content.ts](src/tools/search-content.ts); [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts); [src/prompts.ts](src/prompts.ts) |
| Symbols         | [GrepInputSchema](src/schemas/inputs.ts#L156); [SearchAndReplaceInputSchema](src/schemas/inputs.ts#L194); [registerCompareFilesPrompt](src/prompts.ts#L109)                                                                          |
| Action          | Run the repository task runner and resolve only failures caused by this plan's edits.                                                                                                                                                |
| Validate        | Run `node scripts/tasks.mjs`                                                                                                                                                                                                         |
| Expected result | The command exits with code 0.                                                                                                                                                                                                       |

## 5. Testing & Validation

### [`VAL-001`](#5-testing--validation) - Search behavior tests pass

```bash
node --test --import tsx/esm __tests__/tools/search.test.ts
```

### [`VAL-002`](#5-testing--validation) - Prompt tests pass

```bash
node --test --import tsx/esm __tests__/prompts.test.ts
```

### [`VAL-003`](#5-testing--validation) - Instructions and externalization tests pass

```bash
node --test --import tsx/esm __tests__/resources/instructions-content.test.ts __tests__/tools/refinements.test.ts
```

### [`VAL-004`](#5-testing--validation) - Schema and contract tests pass

```bash
node --test --import tsx/esm __tests__/schemas/snapshot.test.ts __tests__/contract.test.ts
```

### [`VAL-005`](#5-testing--validation) - Full repository validation passes

```bash
node scripts/tasks.mjs
```

## 6. Acceptance Criteria

|                 ID                 | Observable Outcome                                                                                                                                  |
| :--------------------------------: | :-------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`AC-001`](#6-acceptance-criteria) | `grep` calls with `maxDepth: 0` do not scan nested files, and calls without `maxDepth` preserve current recursive behavior.                         |
| [`AC-002`](#6-acceptance-criteria) | `search_and_replace` calls with `maxDepth: 0` do not include nested files.                                                                          |
| [`AC-003`](#6-acceptance-criteria) | `search_and_replace` calls with `maxResults` return `stoppedReason: "maxResults"` when the cap stops enumeration.                                   |
| [`AC-004`](#6-acceptance-criteria) | `tools/list` for `tree.maxDepth` exposes default 5 and no generated description says default 4.                                                     |
| [`AC-005`](#6-acceptance-criteria) | Generated tool descriptions and [README.md](README.md) use `pattern` for file globs and `searchPattern` for text or regex inputs.                   |
| [`AC-006`](#6-acceptance-criteria) | The `compare-files` prompt instructs callers to use `diff_files` with `paths: [original, modified]`.                                                |
| [`AC-007`](#6-acceptance-criteria) | [README.md](README.md) no longer documents removed or stale fields for `mkdir`, `mv`, `diff_files`, `apply_patch`, `grep`, or `search_and_replace`. |
| [`AC-008`](#6-acceptance-criteria) | Generated instructions state that `resourceUri` values can expire through TTL, eviction, or restart.                                                |
| [`AC-009`](#6-acceptance-criteria) | Cursor documentation states same-tool, same-filter, stable-target reuse rules and distinguishes snapshot-backed `ls` from offset-backed `find`.     |
| [`AC-010`](#6-acceptance-criteria) | Schema snapshot tests contain non-empty inspector-visible schema properties and fail when representative tool fields drift.                         |
| [`AC-011`](#6-acceptance-criteria) | `node scripts/tasks.mjs` exits with code 0.                                                                                                         |

## 7. Risks / Notes

|              ID               | Type | Detail                                                                                                                                                                                                                                                                                                           |
| :---------------------------: | :--: | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [`RISK-001`](#7-risks--notes) | Risk | Enforcing `search_and_replace.maxResults` during concurrent replacement can over-count if workers update shared summary state without a single decision point; mitigate in [TASK-003](#task-003-wire-replace-match-cap) by making the cap check deterministic before recording or writing each replacement plan. |
| [`RISK-002`](#7-risks--notes) | Risk | Snapshot tests can become noisy if they include volatile icon metadata or ordering; mitigate in [TASK-010](#task-010-replace-empty-schema-snapshot) by normalizing to deterministic schema-relevant fields.                                                                                                      |
| [`NOTE-001`](#7-risks--notes) | Note | This plan intentionally documents `find` cursor semantics rather than changing [handleSearchFiles](src/tools/search-files.ts#L109) to a snapshot implementation.                                                                                                                                                 |
| [`NOTE-002`](#7-risks--notes) | Note | Do not rename existing tools or fields in this pass; the goal is to align behavior and guidance for the current public contract.                                                                                                                                                                                 |
