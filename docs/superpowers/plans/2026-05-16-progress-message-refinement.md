# Progress Message Refinement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refine tool progress messages to be subject-first, remove done-summary augmentation everywhere, and enforce the new format contract (`Find/Search` pattern-only, `Replace` as `A → B` without quotes/path, and `Read` line-ranges as `file · start-end`).

**Architecture:** Keep the existing progress notification lifecycle (start/tick/done/fail) and monotonic cursor behavior in `defineTool`. Remove done-message augmentation from runtime/tool configs, and shape message text at tool `progress(args)` level only. Add focused regression tests that lock message contracts and prevent reintroduction.

**Tech Stack:** TypeScript (ESM), Zod v4, Node test runner, tsx/esm, MCP server tool registration.

---

## Scope Check

This is a single subsystem change (progress message text shaping) and is suitable for one implementation plan.

## File Structure

### Modify

- `src/tools/define.ts`
  - Stop applying `progressDone` augmentation to terminal success message text.
- `src/tools/search-files.ts`
  - Remove scope/path from progress context.
- `src/tools/search-content.ts`
  - Keep pattern-only progress context (no path scope).
- `src/tools/replace-in-files.ts`
  - Change progress subject to unquoted `searchPattern → replacement`; remove scope/path.
- `src/tools/read.ts`
  - For line-range reads, render progress as `Read: <basename> · <start>-<end|…>` instead of `Read: <basename>:<start>-<end|…>`.
- `src/tools/create.ts`
- `src/tools/move.ts`
- `src/tools/delete-file.ts`
- `src/tools/edit.ts`
- `src/tools/list.ts`
- `src/tools/stat.ts`
- `src/tools/calculate-hash.ts`
  - Remove `progressDone` declarations so no tool contributes done-summary details.
- `__tests__/unit/define-tool.test.ts`
  - Add runtime regression asserting `progressDone` does not affect done notification message.

### Create

- `__tests__/unit/progress-message-contract.test.ts`
  - Add source-level contract checks for:
    - no `progressDone:` usage in tool definitions
    - `find_files` progress has no scope
    - `search_text` progress has no scope
    - `replace_text` progress subject format is `A → B` without quotes/scope
    - `read` line-range progress uses `subject=<basename>` and `scope=<start>-<end|…>`

### Verify (read-only)

- `__tests__/unit/fmt.test.ts`
- `__tests__/unit/stderr-progress-sink.test.ts`
  - Confirm formatter/sink behavior remains valid (no code changes expected).

---

### Task 1: Lock Runtime Behavior in `defineTool`

**Files:**

- Modify: `__tests__/unit/define-tool.test.ts`
- Modify: `src/tools/define.ts`
- Test: `__tests__/unit/define-tool.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test case to `__tests__/unit/define-tool.test.ts` near other progress tests:

```ts
test('defineTool: ignores progressDone augmentation for done message text', async (): Promise<void> => {
  const tool = defineTool({
    ...BASE_DEF,
    progress: (_args) => ({ label: 'Test', subject: 'item' }),
    progressDone: (_args, _result) => ({ detail: 'SHOULD_NOT_APPEAR' }),
    run: async (_args, ctx) => {
      ctx.onProgress?.({ current: 1, total: 1 });
      return { structured: { ok: true as const, result: 'success' }, text: 'test' };
    },
  });

  const capture: HandlerCapture = { handler: undefined };
  tool.register(makeTestDeps(makeMockServer(capture)));

  const request = fakeMcpReqWithProgressToken('token-ignore-progressdone');
  await runCapturedHandler(capture, { message: 'hello' }, {
    mcpReq: request,
  } as unknown as ServerContext);

  const progressPayloads = getProgressPayloads(request.notifications);
  const doneMsg = String(progressPayloads[progressPayloads.length - 1]?.message ?? '');
  assert.equal(doneMsg, 'Test: item');
  assert.ok(!doneMsg.includes('SHOULD_NOT_APPEAR'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --import tsx/esm "__tests__/unit/define-tool.test.ts" --test-name-pattern "ignores progressDone augmentation"
```

Expected: FAIL because done message currently includes `detail` from `progressDone`.

- [ ] **Step 3: Write minimal implementation**

In `src/tools/define.ts`, remove `progressDone` augmentation from the success path and always use `progressCtx` for `doneMessage`:

```ts
const result = await def.run(parsedArgs, toolCtx);
const doneMessage = plainMessage('done', progressCtx);
progressClosed = true;
progressSession.complete(doneMessage);
```

Delete the existing block:

```ts
let doneCtx = progressCtx;
if (def.progressDone) {
  try {
    const extra = def.progressDone(parsedArgs, result.structured);
    doneCtx = { ...progressCtx, ...extra };
    stderrSink.updateCtx(extra);
  } catch {
    // ignore progressDone failures — best effort
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test --import tsx/esm "__tests__/unit/define-tool.test.ts" --test-name-pattern "ignores progressDone augmentation"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add __tests__/unit/define-tool.test.ts src/tools/define.ts
git commit -m "test(progress): lock done message to subject-only runtime contract"
```

---

### Task 2: Apply Tool Message Shaping for Find/Search/Replace/Read

**Files:**

- Modify: `src/tools/search-files.ts`
- Modify: `src/tools/search-content.ts`
- Modify: `src/tools/replace-in-files.ts`
- Modify: `src/tools/read.ts`
- Test: `__tests__/unit/progress-message-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Create `__tests__/unit/progress-message-contract.test.ts` with contract checks against source text:

```ts
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { describe, it } from 'node:test';

describe('progress message contract (tool shaping)', () => {
  it('find_files progress does not include scope/path', async () => {
    const src = await readFile('src/tools/search-files.ts', 'utf8');
    assert.match(
      src,
      /progress:\s*\(args\)\s*=>\s*\(\{[\s\S]*label:\s*'Find'[\s\S]*subject:\s*truncateProgressPattern\(args\.pattern\)/u,
    );
    assert.doesNotMatch(src, /progress:[\s\S]*scope:/u);
  });

  it('search_text progress does not include scope/path', async () => {
    const src = await readFile('src/tools/search-content.ts', 'utf8');
    assert.match(
      src,
      /progress:\s*\(args\)\s*=>\s*\(\{[\s\S]*label:\s*'Search'[\s\S]*subject:\s*truncateProgressPattern\(args\.searchPattern\)/u,
    );
    assert.doesNotMatch(src, /progress:[\s\S]*scope:/u);
  });

  it('replace_text progress format is unquoted A → B with no scope/path', async () => {
    const src = await readFile('src/tools/replace-in-files.ts', 'utf8');
    assert.match(
      src,
      /subject:\s*`\$\{truncateProgressPattern\(args\.searchPattern\)\}\s*→\s*\$\{truncateProgressPattern\(args\.replacement\)\}`/u,
    );
    assert.doesNotMatch(src, /subject:\s*`"\$\{/u);
    assert.doesNotMatch(src, /progress:[\s\S]*scope:/u);
  });

  it('read line-range progress uses separate scope segment (no filename:range subject)', async () => {
    const src = await readFile('src/tools/read.ts', 'utf8');
    assert.match(
      src,
      /else if \(args\.startLine !== undefined\)[\s\S]*scope = `\$\{args\.startLine\}-\$\{String\(end\)\}`/u,
    );
    assert.doesNotMatch(
      src,
      /const subject = `\$\{name\}:\$\{args\.startLine\}-\$\{String\(end\)\}`/u,
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --import tsx/esm "__tests__/unit/progress-message-contract.test.ts"
```

Expected: FAIL because current code still uses scope/path in `find_files` and `replace_text`, quoted replacement subject format, and `read` currently uses `name:start-end` in subject.

- [ ] **Step 3: Write minimal implementation**

Apply these edits:

In `src/tools/search-files.ts`:

```ts
progress: (args) => ({
  label: 'Find',
  subject: truncateProgressPattern(args.pattern),
}),
```

In `src/tools/search-content.ts` keep as pattern-only (no scope):

```ts
progress: (args) => ({
  label: 'Search',
  subject: truncateProgressPattern(args.searchPattern),
}),
```

In `src/tools/replace-in-files.ts`:

```ts
progress: (args) => {
  const dryLabel = args.dryRun ? ' [dry run]' : '';
  return {
    label: `Replace${dryLabel}`,
    subject: `${truncateProgressPattern(args.searchPattern)} → ${truncateProgressPattern(args.replacement)}`,
  };
},
```

In `src/tools/read.ts` change the `startLine` branch inside `progress: (args) => { ... }` to use `scope` instead of embedding range into `subject`:

```ts
} else if (args.startLine !== undefined) {
  const end = args.endLine ?? '…';
  scope = `${args.startLine}-${String(end)}`;
}
return { label: READ_TOOL_LABEL, subject: name, ...(scope ? { scope } : {}) };
```

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test --import tsx/esm "__tests__/unit/progress-message-contract.test.ts"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/search-files.ts src/tools/search-content.ts src/tools/replace-in-files.ts src/tools/read.ts __tests__/unit/progress-message-contract.test.ts
git commit -m "feat(progress): simplify find/search/replace/read progress subjects"
```

---

### Task 3: Remove Done-Summary Hooks from All Tools

**Files:**

- Modify: `src/tools/read.ts`
- Modify: `src/tools/create.ts`
- Modify: `src/tools/move.ts`
- Modify: `src/tools/delete-file.ts`
- Modify: `src/tools/edit.ts`
- Modify: `src/tools/list.ts`
- Modify: `src/tools/stat.ts`
- Modify: `src/tools/calculate-hash.ts`
- Modify: `src/tools/replace-in-files.ts`
- Modify: `src/tools/search-content.ts`
- Modify: `src/tools/search-files.ts`
- Test: `__tests__/unit/progress-message-contract.test.ts`

- [ ] **Step 1: Write the failing test**

Extend `__tests__/unit/progress-message-contract.test.ts` with a no-`progressDone` assertion:

```ts
it('tool definitions do not use progressDone augmentation', async () => {
  const files = [
    'src/tools/read.ts',
    'src/tools/create.ts',
    'src/tools/move.ts',
    'src/tools/delete-file.ts',
    'src/tools/edit.ts',
    'src/tools/list.ts',
    'src/tools/stat.ts',
    'src/tools/calculate-hash.ts',
    'src/tools/replace-in-files.ts',
    'src/tools/search-content.ts',
    'src/tools/search-files.ts',
  ];

  for (const file of files) {
    const src = await readFile(file, 'utf8');
    assert.doesNotMatch(src, /\bprogressDone\s*:/u, `${file} still defines progressDone`);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```bash
node --test --import tsx/esm "__tests__/unit/progress-message-contract.test.ts" --test-name-pattern "do not use progressDone"
```

Expected: FAIL (multiple files still contain `progressDone:`).

- [ ] **Step 3: Write minimal implementation**

Remove `progressDone: ...` blocks from all listed tool definitions. Keep `progress` blocks and `run` behavior unchanged.

Example removal pattern:

```ts
-  progressDone: (_, result) => ({
-    detail: `${result.totalMatches ?? 0} matches · ${result.filesMatched ?? 0} files`,
-  }),
```

Do this for all remaining tools with `progressDone`.

- [ ] **Step 4: Run test to verify it passes**

Run:

```bash
node --test --import tsx/esm "__tests__/unit/progress-message-contract.test.ts" --test-name-pattern "do not use progressDone"
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/tools/read.ts src/tools/create.ts src/tools/move.ts src/tools/delete-file.ts src/tools/edit.ts src/tools/list.ts src/tools/stat.ts src/tools/calculate-hash.ts src/tools/replace-in-files.ts src/tools/search-content.ts src/tools/search-files.ts __tests__/unit/progress-message-contract.test.ts
git commit -m "refactor(progress): remove done-summary hooks from tool definitions"
```

---

### Task 4: Regression and Safety Verification

**Files:**

- Verify: `__tests__/unit/define-tool.test.ts`
- Verify: `__tests__/unit/progress-message-contract.test.ts`
- Verify: `__tests__/unit/fmt.test.ts`
- Verify: `__tests__/unit/stderr-progress-sink.test.ts`
- Verify: `__tests__/tools/search.test.ts`

- [ ] **Step 1: Run focused unit tests**

Run:

```bash
node --test --import tsx/esm "__tests__/unit/define-tool.test.ts"
node --test --import tsx/esm "__tests__/unit/progress-message-contract.test.ts"
node --test --import tsx/esm "__tests__/unit/fmt.test.ts"
node --test --import tsx/esm "__tests__/unit/stderr-progress-sink.test.ts"
```

Expected: PASS for all four files.

- [ ] **Step 2: Run representative integration test for search tools**

Run:

```bash
node --test --import tsx/esm "__tests__/tools/search.test.ts"
```

Expected: PASS.

- [ ] **Step 3: Run full project check**

Run:

```bash
node scripts/tasks.mjs check
```

Expected: all stages pass (format, lint, type-check, tests, rebuild).

- [ ] **Step 4: Commit verification-linked fixes (if any)**

If any test-driven fixes were needed during verification:

```bash
git add -A
git commit -m "test(progress): stabilize progress message contract and regressions"
```

If no fixes were needed, skip this commit.

---

## Final Acceptance Checklist

- [ ] Done notifications still emit, but message text no longer contains done-summary augmentation.
- [ ] `find_files` progress text is pattern-only (`Find: <pattern>`).
- [ ] `search_text` progress text is pattern-only (`Search: <pattern>`).
- [ ] `replace_text` progress text is exactly `Replace: <search> → <replacement>` style (no quotes/path).
- [ ] `read` line-range progress text is `Read: <file> · <start>-<end|…>`.
- [ ] No tool definition includes `progressDone:`.
- [ ] Full `node scripts/tasks.mjs check` succeeds.
