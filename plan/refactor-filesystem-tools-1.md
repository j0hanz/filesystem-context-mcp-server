---
goal: Fix high-value filesystem tool correctness and scalability issues discovered in review by making delete decline semantics accurate, list truncation resources truthful, list collection memory-bounded, and read batch output unambiguous.
version: 1
date_created: 2026-05-12
status: Completed
plan_type: refactor
component: filesystem-tools
---

# Implementation Plan: Fix Filesystem Tool Findings

## 1. Goal

This plan addresses four review findings in the filesystem tool layer: false-positive delete success reporting, incorrect list truncation resource content, list collection scalability, and ambiguous read batch top-level path output. Completion is observed by targeted tool tests plus full project verification passing with behavior assertions aligned to the intended contract. The result must preserve existing security boundaries and MCP response schema compatibility except where behavior is explicitly corrected.

## 2. Requirements & Constraints

|                   ID                    | Type        | Statement                                                                                                                                             |
| :-------------------------------------: | :---------- | :---------------------------------------------------------------------------------------------------------------------------------------------------- |
| [REQ-001](#2-requirements--constraints) | Requirement | Declining recursive delete confirmation must not be reported as a deleted path.                                                                       |
| [REQ-002](#2-requirements--constraints) | Requirement | When list output is truncated and resourceUri is returned, the stored resource must contain the full discovered entry set, not the truncated subset.  |
| [REQ-003](#2-requirements--constraints) | Requirement | list collection must avoid storing and sorting all entries when only a bounded page is needed for inline response.                                    |
| [REQ-004](#2-requirements--constraints) | Requirement | read batch response must not set top-level path to args.paths[0] because this field is single-file semantics.                                         |
| [CON-001](#2-requirements--constraints) | Constraint  | Keep existing path guard and sensitive-file protections unchanged.                                                                                    |
| [CON-002](#2-requirements--constraints) | Constraint  | Keep output schemas backward-compatible unless the change explicitly fixes a documented incorrect behavior.                                           |
| [CON-003](#2-requirements--constraints) | Constraint  | Validation must include targeted tests and full project check via the repository task runner.                                                         |
| [PAT-001](#2-requirements--constraints) | Pattern     | Follow per-path failure reporting style already used in [handleDelete](src/tools/delete-file.ts#L205).                                                |
| [PAT-002](#2-requirements--constraints) | Pattern     | Follow current list collection and rendering boundary in [collect](src/tools/list.ts#L79) and [handleList](src/tools/list.ts#L229).                   |
| [PAT-003](#2-requirements--constraints) | Pattern     | Follow batch response assembly style in [buildReadManyResponsePayload](src/tools/read.ts#L753) and [handleReadMultipleFiles](src/tools/read.ts#L778). |

## 3. Current Context

### Relevant files

| File                                                                       | Why it matters                                                                      |
| :------------------------------------------------------------------------- | :---------------------------------------------------------------------------------- |
| [src/tools/delete-file.ts](src/tools/delete-file.ts)                       | Contains decline flow and success accounting for delete results.                    |
| [src/tools/list.ts](src/tools/list.ts)                                     | Contains collection, truncation, markdown rendering, and resource storage behavior. |
| [src/tools/read.ts](src/tools/read.ts)                                     | Contains batch read structured response assembly where top-level path is set.       |
| [**tests**/tools/elicitation.test.ts](__tests__/tools/elicitation.test.ts) | Covers delete and move elicitation behavior, including decline scenarios.           |
| [**tests**/tools/directory.test.ts](__tests__/tools/directory.test.ts)     | Covers list and delete behavior at integration level.                               |
| [**tests**/tools/read-write.test.ts](__tests__/tools/read-write.test.ts)   | Covers read tool structured output behavior.                                        |
| [scripts/tasks.mjs](scripts/tasks.mjs)                                     | Canonical full verification entrypoint.                                             |
| [package.json](package.json)                                               | Confirms available scripts and task aliases.                                        |

### Relevant symbols

| Symbol                                                 | Why it matters                                                                           |
| :----------------------------------------------------- | :--------------------------------------------------------------------------------------- |
| [tryElicitConfirmation](src/tools/delete-file.ts#L95)  | Defines decline/accept behavior for recursive delete confirmation.                       |
| [deleteSinglePath](src/tools/delete-file.ts#L146)      | Returns per-path delete outcome and currently reports declined deletion as success item. |
| [handleDelete](src/tools/delete-file.ts#L205)          | Aggregates success paths and failures into final tool output.                            |
| [DELETE_FILE](src/tools/delete-file.ts#L257)           | Tool definition and summary response contract for delete.                                |
| [collect](src/tools/list.ts#L79)                       | Current list collection implementation that stores and sorts all entries.                |
| [handleList](src/tools/list.ts#L229)                   | Produces structured list output and truncation resource payload.                         |
| [LIST](src/tools/list.ts#L287)                         | Tool description and behavior contract for list.                                         |
| [buildReadManyResponsePayload](src/tools/read.ts#L753) | Builds structured results for batch read response.                                       |
| [handleReadMultipleFiles](src/tools/read.ts#L778)      | Creates top-level batch structured output including current path assignment.             |
| [READ_FILE](src/tools/read.ts#L818)                    | Tool definition for read behavior and output schema.                                     |

### Existing commands

```bash
# Preferred full verification
node scripts/tasks.mjs check

# Fast static verification
node scripts/tasks.mjs check --quick

# Targeted tests for this plan scope
node --test --import tsx/esm "__tests__/tools/elicitation.test.ts" "__tests__/tools/directory.test.ts" "__tests__/tools/read-write.test.ts"
```

### Current behavior

Delete marks declined recursive deletions as successful paths, list stores truncated inline entries in resourceUri despite claiming full result storage, list always accumulates and globally sorts all discovered entries before slicing, and read batch sets top-level path to the first input path.

## 4. Implementation Phases

### PHASE-001: Correct delete and read behavioral semantics

**Goal:** Ensure delete and read responses represent actual outcomes without ambiguous or misleading success/path fields.

|                                   Task                                   | Action                                                                                                 |                                Depends on                                | Files                                                                                                                                              | Validate                                                                                                 |
| :----------------------------------------------------------------------: | :----------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------- |
| [TASK-001](#task-001-return-non-success-state-for-declined-delete-paths) | Return non-success per-path state when recursive delete is declined and exclude it from deleted paths. |                                   none                                   | [src/tools/delete-file.ts](src/tools/delete-file.ts)                                                                                               | `node --test --import tsx/esm "__tests__/tools/elicitation.test.ts"`                                     |
| [TASK-002](#task-002-update-delete-tests-for-accurate-decline-reporting) | Update elicitation and directory tests to assert decline is not reported as deletion success.          | [TASK-001](#task-001-return-non-success-state-for-declined-delete-paths) | [**tests**/tools/elicitation.test.ts](__tests__/tools/elicitation.test.ts); [**tests**/tools/directory.test.ts](__tests__/tools/directory.test.ts) | `node --test --import tsx/esm "__tests__/tools/elicitation.test.ts" "__tests__/tools/directory.test.ts"` |
|   [TASK-003](#task-003-remove-batch-top-level-path-from-read-response)   | Remove top-level path assignment for batch read responses to avoid single-file field misuse.           |                                   none                                   | [src/tools/read.ts](src/tools/read.ts); [**tests**/tools/read-write.test.ts](__tests__/tools/read-write.test.ts)                                   | `node --test --import tsx/esm "__tests__/tools/read-write.test.ts"`                                      |

#### TASK-001: Return non-success state for declined delete paths

| Field           | Value                                                                                                                                                                                                                                                                             |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                                                                              |
| Files           | [src/tools/delete-file.ts](src/tools/delete-file.ts)                                                                                                                                                                                                                              |
| Symbols         | [tryElicitConfirmation](src/tools/delete-file.ts#L95); [deleteSinglePath](src/tools/delete-file.ts#L146); [handleDelete](src/tools/delete-file.ts#L205); [DELETE_FILE](src/tools/delete-file.ts#L257)                                                                             |
| Action          | Change decline handling so declined recursive deletes are represented as explicit non-success outcomes (for example, per-path failure with code CANCELLED) and are not appended to deleted success path output. Keep successful deletes and ignoreIfNotExists behavior unchanged. |
| Validate        | Run `node --test --import tsx/esm "__tests__/tools/elicitation.test.ts"`                                                                                                                                                                                                          |
| Expected result | Decline scenario preserves filesystem state and final structured output does not include declined path in deleted path/paths success fields.                                                                                                                                      |

#### TASK-002: Update delete tests for accurate decline reporting

| Field           | Value                                                                                                                                                                                                          |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | [TASK-001](#task-001-return-non-success-state-for-declined-delete-paths)                                                                                                                                       |
| Files           | [**tests**/tools/elicitation.test.ts](__tests__/tools/elicitation.test.ts); [**tests**/tools/directory.test.ts](__tests__/tools/directory.test.ts)                                                             |
| Symbols         | none                                                                                                                                                                                                           |
| Action          | Update decline-path assertions so tests validate both data preservation and response semantics: no false deleted path success reporting, and expected per-path cancellation/failure structure when applicable. |
| Validate        | Run `node --test --import tsx/esm "__tests__/tools/elicitation.test.ts" "__tests__/tools/directory.test.ts"`                                                                                                   |
| Expected result | Tests fail before implementation and pass after implementation with assertions that match corrected delete semantics.                                                                                          |

#### TASK-003: Remove batch top-level path from read response

| Field           | Value                                                                                                                                                                                                                        |
| :-------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                                         |
| Files           | [src/tools/read.ts](src/tools/read.ts); [**tests**/tools/read-write.test.ts](__tests__/tools/read-write.test.ts)                                                                                                             |
| Symbols         | [buildReadManyResponsePayload](src/tools/read.ts#L753); [handleReadMultipleFiles](src/tools/read.ts#L778); [READ_FILE](src/tools/read.ts#L818)                                                                               |
| Action          | Remove setting of top-level path in batch-mode structured read output and keep per-file paths under results only. Update assertions to ensure batch responses rely on results and summary, not a synthetic single-file path. |
| Validate        | Run `node --test --import tsx/esm "__tests__/tools/read-write.test.ts"`                                                                                                                                                      |
| Expected result | Batch read output no longer includes misleading top-level path while all existing batch semantics remain intact.                                                                                                             |

### PHASE-002: Fix list contract and memory profile

**Goal:** Ensure list truncation resourceUri is truthful and list inline responses scale without storing all entries in memory.

|                                   Task                                    | Action                                                                                                                    |                               Depends on                               | Files                                                                                                          | Validate                                                           |
| :-----------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------------: | :------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------- |
|  [TASK-004](#task-004-store-true-full-result-in-truncation-resourceuri)   | Make truncation resource payload contain full discovered entries and corresponding full markdown tree.                    |                                  none                                  | [src/tools/list.ts](src/tools/list.ts)                                                                         | `node --test --import tsx/esm "__tests__/tools/directory.test.ts"` |
| [TASK-005](#task-005-introduce-bounded-inline-collection-for-list-output) | Refactor list collection to maintain bounded inline entries while tracking full counts and supporting full-resource mode. | [TASK-004](#task-004-store-true-full-result-in-truncation-resourceuri) | [src/tools/list.ts](src/tools/list.ts); [**tests**/tools/directory.test.ts](__tests__/tools/directory.test.ts) | `node --test --import tsx/esm "__tests__/tools/directory.test.ts"` |

#### TASK-004: Store true full result in truncation resourceUri

| Field           | Value                                                                                                                                                                                                             |
| :-------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Depends on      | none                                                                                                                                                                                                              |
| Files           | [src/tools/list.ts](src/tools/list.ts)                                                                                                                                                                            |
| Symbols         | [collect](src/tools/list.ts#L79); [handleList](src/tools/list.ts#L229); [LIST](src/tools/list.ts#L287)                                                                                                            |
| Action          | Separate inline truncated output from full discovered output and ensure resourceUri stores the full entry set and full markdown when totalEntries exceeds entryCount. Keep inline response bounded by maxEntries. |
| Validate        | Run `node --test --import tsx/esm "__tests__/tools/directory.test.ts"`                                                                                                                                            |
| Expected result | For truncated responses, dereferencing resourceUri yields more entries than inline output and matches totalEntries metadata.                                                                                      |

#### TASK-005: Introduce bounded inline collection for list output

| Field           | Value                                                                                                                                                                                                                                                                                                                     |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | [TASK-004](#task-004-store-true-full-result-in-truncation-resourceuri)                                                                                                                                                                                                                                                    |
| Files           | [src/tools/list.ts](src/tools/list.ts); [**tests**/tools/directory.test.ts](__tests__/tools/directory.test.ts)                                                                                                                                                                                                            |
| Symbols         | [collect](src/tools/list.ts#L79); [handleList](src/tools/list.ts#L229)                                                                                                                                                                                                                                                    |
| Action          | Refactor collection into explicit modes so inline output mode keeps only maxEntries candidates in sorted order plus counters, while full-resource mode can still materialize complete results when needed. Add tests that assert bounded inline entry count with accurate total counts and unchanged ordering guarantees. |
| Validate        | Run `node --test --import tsx/esm "__tests__/tools/directory.test.ts"`                                                                                                                                                                                                                                                    |
| Expected result | list no longer requires storing every entry for inline response path, and ordering plus totals remain correct under truncation.                                                                                                                                                                                           |

### PHASE-003: End-to-end verification

**Goal:** Validate all corrected behaviors and ensure no regressions across checks, tests, typecheck, and rebuild.

|                           Task                           | Action                                                                                      |                                                                                                        Depends on                                                                                                         | Files                                                                | Validate                       |
| :------------------------------------------------------: | :------------------------------------------------------------------------------------------ | :-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------: | :------------------------------------------------------------------- | :----------------------------- |
| [TASK-006](#task-006-run-targeted-and-full-verification) | Run targeted tests and full check pipeline, confirm all corrected behaviors are observable. | [TASK-002](#task-002-update-delete-tests-for-accurate-decline-reporting); [TASK-003](#task-003-remove-batch-top-level-path-from-read-response); [TASK-005](#task-005-introduce-bounded-inline-collection-for-list-output) | [scripts/tasks.mjs](scripts/tasks.mjs); [package.json](package.json) | `node scripts/tasks.mjs check` |

#### TASK-006: Run targeted and full verification

| Field           | Value                                                                                                                                                                                                                     |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Depends on      | [TASK-002](#task-002-update-delete-tests-for-accurate-decline-reporting); [TASK-003](#task-003-remove-batch-top-level-path-from-read-response); [TASK-005](#task-005-introduce-bounded-inline-collection-for-list-output) |
| Files           | [scripts/tasks.mjs](scripts/tasks.mjs); [package.json](package.json)                                                                                                                                                      |
| Symbols         | none                                                                                                                                                                                                                      |
| Action          | Run targeted tests for delete/list/read, then run project check pipeline and verify all commands pass with no new failures. Confirm behavior outcomes for the four findings via test assertions and structured outputs.   |
| Validate        | Run `node --test --import tsx/esm "__tests__/tools/elicitation.test.ts" "__tests__/tools/directory.test.ts" "__tests__/tools/read-write.test.ts" && node scripts/tasks.mjs check`                                         |
| Expected result | Targeted tests and full check pass, and all four findings are closed with observable, test-backed behavior.                                                                                                               |

## 5. Testing & Validation

### [VAL-001](#5-testing--validation) — Delete decline is not reported as deleted success

```bash
node --test --import tsx/esm "__tests__/tools/elicitation.test.ts"
```

### [VAL-002](#5-testing--validation) — list truncation resource and bounded inline behavior are correct

```bash
node --test --import tsx/esm "__tests__/tools/directory.test.ts"
```

### [VAL-003](#5-testing--validation) — read batch output has no misleading top-level path

```bash
node --test --import tsx/esm "__tests__/tools/read-write.test.ts"
```

### [VAL-004](#5-testing--validation) — Full repository verification passes

```bash
node scripts/tasks.mjs check
```

## 6. Acceptance Criteria

|                ID                | Observable Outcome                                                                                                            |
| :------------------------------: | :---------------------------------------------------------------------------------------------------------------------------- |
| [AC-001](#6-acceptance-criteria) | Declined recursive delete request is not represented in deleted path/paths success output.                                    |
| [AC-002](#6-acceptance-criteria) | list truncated response returns inline entryCount less than totalEntries and resourceUri content contains the full entry set. |
| [AC-003](#6-acceptance-criteria) | list inline mode does not require full in-memory accumulation of all entries to produce sorted bounded response.              |
| [AC-004](#6-acceptance-criteria) | read batch response omits top-level path and uses results array for per-file paths.                                           |
| [AC-005](#6-acceptance-criteria) | Targeted tests and node scripts/tasks.mjs check exit successfully.                                                            |

## 7. Risks / Notes

|             ID              | Type | Detail                                                                                                                                                                               |
| :-------------------------: | :--: | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [RISK-001](#7-risks--notes) | Risk | Changing delete decline semantics may affect clients that currently treat decline as success; mitigate by documenting response change and updating tests first.                      |
| [RISK-002](#7-risks--notes) | Risk | list bounded collection refactor can accidentally alter ordering; mitigate by preserving existing comparator behavior and extending ordering assertions.                             |
| [RISK-003](#7-risks--notes) | Risk | Generating full-resource payload on truncated directories can still be expensive for very large trees; mitigate by preserving timeout behavior and validating under configured caps. |
| [NOTE-001](#7-risks--notes) | Note | Scope is limited to findings from review and direct test updates; no unrelated tool schema or transport changes.                                                                     |
