---
title: 'Refactor Tool Schema Contract'
status: 'draft'
---

# Implementation Plan: Refactor Tool Schema Contract

## 1. Purpose

Refactor tool schemas and improve error handling for `diff_files`, `grep`, `search_and_replace`, and `rm` to address LLM integration friction points, improve pagination, and support bulk operations.

## 2. Rationale

- `diff_files` uses a tuple array `[string, string]` which causes issues for strict function-calling parsers.
- `grep` and `search_and_replace` lack pagination, making large searches impossible to navigate.
- `rm` lacks bulk deletion capability, requiring inefficient sequential calls.
- RE2 compilation errors with lookarounds currently crash or return unhelpful errors instead of gracefully guiding the LLM.

## 3. Current Context

### Files

- [src/schemas/inputs.ts](src/schemas/inputs.ts)
- [src/schemas/outputs.ts](src/schemas/outputs.ts)
- [src/tools/diff-files.ts](src/tools/diff-files.ts)
- [src/tools/search-content.ts](src/tools/search-content.ts)
- [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts)
- [src/tools/delete-file.ts](src/tools/delete-file.ts)

## 4. Execution Phases

### PHASE-1: `diff_files` Schema Refactor

Refactor `diff_files` input schema from a tuple array to explicit `original` and `modified` string properties.

#### TASK-1.1

**Files:**

- [src/schemas/inputs.ts](src/schemas/inputs.ts)
- [src/tools/diff-files.ts](src/tools/diff-files.ts)

**Change:**

1. In `src/schemas/inputs.ts`, update the `diff_files` input schema to replace `paths: z.tuple([z.string(), z.string()])` with `original: z.string()` and `modified: z.string()`.
2. In `src/tools/diff-files.ts`, update the tool implementation to read `original` and `modified` directly from the arguments instead of destructing `paths`.

**Validate:** `npm run type-check && npm run test`
**Expected result:** Type checking passes and existing tests for `diff_files` pass after updating the test inputs.

### PHASE-2: Bulk Deletion for `rm`

Update `rm` to support bulk deletion.

#### TASK-2.1

**Files:**

- [src/schemas/inputs.ts](src/schemas/inputs.ts)
- [src/tools/delete-file.ts](src/tools/delete-file.ts)
- [src/schemas/outputs.ts](src/schemas/outputs.ts)

**Change:**

1. In `src/schemas/inputs.ts`, change `path: z.string()` to `paths: z.array(z.string()).min(1)` for the `rm` tool.
2. In `src/schemas/outputs.ts`, update the `rm` tool's output schema to include `failures` and a `summary` object to reflect bulk operation statuses.
3. In `src/tools/delete-file.ts`, loop through `paths` and attempt deletion for each, returning a summary of successes and failures, similar to `mv`.

**Validate:** `npm run type-check && node scripts/tasks.mjs`
**Expected result:** The `rm` tool accepts an array of paths and returns partial success/failure statistics.

### PHASE-3: Graceful RE2 Error Handling

Catch invalid RE2 regex patterns (like lookarounds) and return a graceful error.

#### TASK-3.1

**Files:**

- [src/tools/search-content.ts](src/tools/search-content.ts)
- [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts)

**Change:**

1. In both tools, wrap the `new RegExp` or RE2 initialization in a `try...catch` block.
2. If a `SyntaxError` is caught, return `{ content: [{ type: 'text', text: 'Regex Error: RE2 does not support lookarounds or backreferences. Rewrite your pattern.' }], isError: true }`.

**Validate:** `npm run test`
**Expected result:** Passing an invalid RE2 regex returns a clear instructional error rather than a crash.

### PHASE-4: Pagination for `grep` and `search_and_replace`

Add offset/cursor support.

#### TASK-4.1

**Files:**

- [src/schemas/inputs.ts](src/schemas/inputs.ts)
- [src/tools/search-content.ts](src/tools/search-content.ts)
- [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts)

**Change:**

1. In `src/schemas/inputs.ts`, add `cursor: z.string().optional()` to both `grep` and `search_and_replace` schemas.
2. In both tools, implement offset logic using the cursor (decoding the cursor, skipping files/lines up to the offset, and returning a `nextCursor` if truncated).

**Validate:** `npm run type-check && node scripts/tasks.mjs`
**Expected result:** `grep` and `search_and_replace` successfully paginate over large result sets.

## 5. Acceptance Criteria

- [ ] `diff_files` uses named properties for files.
- [ ] `rm` accepts a list of `paths` and reports per-file failures.
- [ ] Invalid regex patterns in `grep` and `search_and_replace` return a helpful `isError: true` message instead of failing ungracefully.
- [ ] `grep` and `search_and_replace` can be paginated.
