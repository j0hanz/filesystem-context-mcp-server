# Progress Message Refinement Design

Date: 2026-05-16
Status: Approved in brainstorming; ready for implementation planning
Scope: Progress message text shaping for filesystem-mcp tools

## Context

The server already emits MCP progress notifications correctly (including `message`), and tools are configured with `taskSupport: 'forbidden'` to avoid immutable MCP task names like `Ran <Tool>`.

Current behavior mixes concise subject messages with done-summary suffixes (for some tools), producing inconsistent UX.

Goal: Make progress messages clean, subject-focused, and consistent with no done-summary text.

## Goals

1. Prioritize subject clarity in status messages.
2. Remove done-summary messaging across all tools.
3. Keep lifecycle semantics intact (start/tick/done/fail notifications still emitted).
4. Keep message style simple and predictable.

## Non-Goals

1. No change to tool input/output schemas.
2. No change to progress notification transport shape.
3. No change to task support configuration.
4. No redesign of numeric tick format (`current/total`).

## Final UX Decisions

1. Subject-first message style is primary.
2. No done summary text for any tool.
3. Multi-target tool subjects keep explicit joined basenames (no count collapse).
4. `replace_text` format becomes exactly:
   - `Replace: TODO → DONE`
   - No path/scope suffix
   - No wrapping quotes
5. `find_files` and `search_text` messages remove path/scope context:
   - `Find: <pattern>`
   - `Search: <pattern>`

## Message Contract

Message text is derived from tool `progress(args)` only. The same subject-focused phrasing is used throughout lifecycle events unless tick naturally includes numeric progress.

### Lifecycle Behavior

1. Start notification: emitted immediately with start message.
2. Tick notifications: emitted during progress with monotonic `current`.
3. Done notification: still emitted, but without done-only summary augmentation.
4. Fail notification: still emitted with error text.

## Architecture and Component Changes

### 1) Tool definition behavior

In `src/tools/define.ts`:

1. Keep lifecycle notification pipeline unchanged.
2. Keep monotonic cursor behavior unchanged.
3. Keep fail/error behavior unchanged.
4. Remove/disable use of `progressDone` for user-visible done text augmentation.

Interpretation: terminal success message should remain the same subject-oriented expression as start/tick style, not a separate result summary.

### 2) Tool-specific progress shaping

Update tool progress formatters as follows:

1. `src/tools/search-files.ts`
   - Remove scope/path from `progress(...)`.
   - Message should be pattern-only subject.
2. `src/tools/search-content.ts`
   - Keep pattern subject only (no scope/path).
3. `src/tools/replace-in-files.ts`
   - Build subject as unquoted `searchPattern → replacement`.
   - Do not include scope/path in message.
4. All tools currently defining `progressDone`
   - Remove done-detail messaging so done text does not append result summary.

### 3) Formatter behavior

In `src/core/fmt.ts`:

No structural changes required. Existing formatter remains responsible for phase rendering; this design changes what tools provide, not formatter transport semantics.

## Data Flow

1. Tool run starts.
2. `progress(args)` builds subject message context.
3. `defineTool` emits start and tick notifications.
4. On success, done notification is still emitted, but message remains subject-only (no result-detail append).
5. On failure, fail message includes error text.

## Error Handling

1. Notification send failures remain non-fatal (best effort).
2. Fail notifications remain explicit and include error detail.
3. No new fallback formatter logic needed.

## Testing Plan

Update and/or add tests to lock behavior:

1. Done message does not include done-summary details for all tools.
2. `find_files` progress text excludes scope/path (`.` and explicit directory should not appear).
3. `search_text` progress text excludes scope/path.
4. `replace_text` message renders as `Replace: <search> → <replacement>`:
   - no quotes
   - no path/scope
5. Existing lifecycle semantics remain true:
   - start emitted
   - tick monotonic
   - done/fail emitted

Likely impacted tests include:

1. `__tests__/unit/define-tool.test.ts`
2. Tool-specific unit tests in:
   - `__tests__/tools/search.test.ts`
   - `__tests__/tools/read-write.test.ts`
   - `__tests__/tools/stat.test.ts`
   - `__tests__/tools/hash.test.ts`
   - other expectations asserting progress message strings

## Acceptance Criteria

1. User-visible progress text is consistently subject-first.
2. No tool appends done-summary details in success messages.
3. `replace_text` displays clean transform text (`A → B`) without quotes/scope.
4. `find_files` and `search_text` are pattern-only.
5. Full check pipeline passes after implementation.

## Risks and Mitigations

1. Risk: Existing tests assume done summaries.
   - Mitigation: update assertions to new contract and keep lifecycle assertions.
2. Risk: Reduced informational density in done messages.
   - Mitigation: keep subject specificity and rely on final tool output for result details.
3. Risk: Very long multi-target subjects for delete/move.
   - Mitigation: accepted explicitly in this design; revisit only if user feedback changes.

## Implementation Boundary

This design is intentionally narrow: progress message text refinement only. No schema, protocol, or task-system redesign is included.
