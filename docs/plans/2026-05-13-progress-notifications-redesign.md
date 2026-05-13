# Progress & Notifications Redesign

**Date:** 2026-05-13
**Status:** Awaiting approval

## Context & Motivation

Tool progress messages today are cluttered, inconsistent, and carry no useful information:

- `"read: starting"` — the client already shows the tool name and that it started
- `"search_content: grep: async.*await [45 files]"` — double-prefix (`search_content:` prepended by orchestrator on top of `grep:` inline in the tool)
- `"read: completed"` — redundant; the task terminal state already signals this
- `ProgressSession` is constructed with `sinks: []` everywhere — it tracks state but emits nothing to stderr
- Most tools pass only `{ current, total }` with no message — the status message never updates past "starting"
- Server stderr is flat, colorless, and unreadable during dev

## Decision

Introduce a single `fmt.ts` module as the source of truth for all progress formatting. Two output surfaces:

- **MCP client** — plain-text `statusMessage` strings embedded in `notifications/tasks/status`, rich with argument data, no ANSI
- **Server stderr** — ANSI-colored lines emitted by `StderrProgressSink` when `process.stderr.isTTY` is true

## Message Format

**Rule:** phase is communicated by the symbol, not words in the text. Text is pure data.

```
→  Tool: subject  scope          (start)
·  Tool: subject  45/500         (tick)
✓  Tool: subject  scope  detail  (done)
✗  Tool: subject  error message  (fail)
```

Symbols: `→` dim-cyan (start), `·` gray (tick), `✓` green (done), `✗` red (fail).
Timing (dim gray) appended on stderr only. Two spaces between subject, scope, stats.
`+N` green, `-N` red — applied to subject/detail strings matching that pattern.

### Tool-by-tool reference

```
→  Read: tasks.ts
✓  Read: tasks.ts  2.3 KB

→  Read: 10 files
✓  Read: 10 files  143 KB

→  Edit: tasks.ts
✓  Edit: tasks.ts+2-2 · index.ts+50-25
✗  Edit: tasks.ts  EACCES: permission denied

→  Search: async.*await  src/
·  Search: async.*await  45/500
✓  Search: async.*await  src/  23 matches · 8 files
✗  Search: async.*(await  invalid regex

→  Find: **/*.ts  src/
✓  Find: **/*.ts  12 files

→  Replace: "oldFn" → "newFn"  src/
·  Replace: "oldFn" → "newFn"  45/200
✓  Replace: "oldFn" → "newFn"  12 files · 47 matches

→  List: src/tools/
✓  List: src/tools/  23 entries

→  Move: tasks.ts → core/tasks.ts
✓  Move: 3 files

→  Delete: tasks.ts · index.ts
✓  Delete: 2 files

→  Hash: large-file.bin
·  Hash: large-file.bin  45/500 MB
✓  Hash: large-file.bin  sha256:a1b2c3d4

→  Stat: src/core/  47 entries
```

Stderr adds timing on the right:

```
✓  Edit: tasks.ts+2-2 · index.ts+50-25          120ms
✗  Edit: tasks.ts  EACCES: permission denied      5ms
```

## Components

### `src/core/fmt.ts` (new)

```typescript
export interface ProgressCtx {
  label: string; // "Edit", "Search", "Read" — capitalised tool verb
  subject?: string; // primary arg: file path, pattern
  scope?: string; // secondary arg: directory scope
  current?: number; // tick phase: files processed so far
  total?: number; // tick phase: total files to process
  detail?: string; // done phase: result stats ("23 matches · 8 files", "2.3 KB")
  error?: string; // fail phase: error message
  durationMs?: number; // stderr only: elapsed ms
}

export type Phase = 'start' | 'tick' | 'done' | 'fail';

// Plain text for MCP notifications/tasks/status
export function plainMessage(phase: Phase, ctx: ProgressCtx): string;

// ANSI-colored line for server stderr
export function ansiLine(phase: Phase, ctx: ProgressCtx): string;
```

**`plainMessage` rules:**

- start: `{label}: {subject?}  {scope?}`
- tick: `{label}: {subject?}  {current}/{total}` (or `{current}` if no total)
- done: `{label}: {subject?}  {scope?}  {detail?}` (scope omitted if undefined)
- fail: `{label}: {subject?}  {error?}`

**`ansiLine` rules:** same structure, symbols and colors prepended, duration appended.
`+N` / `-N` patterns in subject and detail are colored green / red via regex substitution.
No external dependencies — raw escape codes only.

### `src/tools/define.ts` — `ToolDef` changes

```typescript
// Before
progressLabel?: (args: z.infer<I>) => string;

// After
progress?: (args: z.infer<I>) => ProgressCtx;
progressDone?: (args: z.infer<I>, result: z.infer<O>) => Partial<ProgressCtx>;
```

`progress` replaces `progressLabel`. Returns the full ctx so subject and scope are available
to both the start message and all tick messages without repetition.

`progressDone` supplies result-derived stats for the done message. Examples:

- edit: `(args, result) => ({ subject: result.files.map(f => \`\${basename(f.path)}+\${f.added}-\${f.removed}\`).join(' · ') })`
- search: `(_, result) => ({ detail: \`\${result.matchCount} matches · \${result.fileCount} files\` })`
- read: `(_, result) => ({ detail: formatBytes(result.totalSize) })`

When `progressDone` returns a partial ctx, it is merged over the base `ProgressCtx` before
the done message is formatted.

### `src/core/observability.ts` — `StderrProgressSink`

```typescript
export class StderrProgressSink implements ProgressSink {
  readonly name = 'stderr';
  private readonly startMs = Date.now();

  constructor(private readonly ctx: ProgressCtx) {}

  emit(event: ProgressEvent): void {
    // ProgressEvent has no 'start' kind — detect it from the synthetic tick
    // that ProgressSession fires at construction (current === 0).
    const phase: Phase =
      event.kind === 'complete'
        ? 'done'
        : event.kind === 'fail'
          ? 'fail'
          : event.kind === 'tick' && event.current === 0
            ? 'start'
            : 'tick';

    // Merge event fields into base ctx:
    //   tick/start → spread current, total from event
    //   complete   → no extra fields (detail comes from progressDone via ProgressSession.complete message)
    //   fail       → spread error string extracted from event.error
    const merged: ProgressCtx = {
      ...this.ctx,
      ...(event.kind === 'tick' || event.kind === 'complete'
        ? { current: event.current, total: event.total }
        : {}),
      ...(event.kind === 'complete' && event.message !== this.ctx.label
        ? { detail: event.message }
        : {}),
      ...(event.kind === 'fail'
        ? { error: event.error instanceof Error ? event.error.message : String(event.error) }
        : {}),
    };

    process.stderr.write(
      ansiLine(phase, { ...merged, durationMs: Date.now() - this.startMs }) + '\n',
    );
  }
}
```

Created per-invocation in `define.ts:coreHandler`. Only instantiated when
`process.stderr.isTTY` is true — no output when server is piped or stdio transport.

### `src/tasks.ts` — remove double-prefix

Line 209 (initial status): **delete the call entirely.** The task enters `working` state
with no `statusMessage`; `define.ts` fires the proper rich start notification within
microseconds. Keeping it would require translating raw tool names like `search_content`
into display labels (`Search`) — that knowledge belongs in `define.ts`, not the orchestrator.

Line 221 (progress intercept): strip the `${toolName}:` concatenation — forward
`statusMessage` as-is. It arrives already formatted by `define.ts`.

```typescript
// Before
await task.store.updateTaskStatus(taskId, status, `${toolName}: ${statusMessage}`);

// After
await task.store.updateTaskStatus(taskId, status, statusMessage);
```

### Individual tool changes (light touch)

Tools that currently build inline message strings are updated to pass structured data instead:

All 11 tools with `progressLabel` are migrated. The `message` field in `ctx.onProgress`
calls is removed — subject and scope come from the `ProgressCtx` returned by `progress`,
so tools pass only `{ current, total }` going forward.

| Tool               | progress label / subject / scope               | progressDone detail                      |
| ------------------ | ---------------------------------------------- | ---------------------------------------- |
| `read`             | Read · path or "N files"                       | formatBytes(totalSize) or "N files X KB" |
| `edit`             | Edit · first filename                          | per-file "name+A-R" joined by " · "      |
| `search-content`   | Search · truncated pattern · path scope        | "N matches · M files"                    |
| `search-files`     | Find · pattern · path scope                    | "N files"                                |
| `replace-in-files` | Replace · "pattern → replacement" · path scope | "N files · M matches"                    |
| `list`             | List · path                                    | "N entries"                              |
| `create`           | Create · "N files" or single filename          | filenames joined by " · "                |
| `move`             | Move · "src → dst" (single) or "N files"       | —                                        |
| `delete-file`      | Delete · filenames joined by " · "             | "N files"                                |
| `calculate-hash`   | Hash · basename(path)                          | "sha256:hex[:8]…"                        |
| `stat`             | Stat · path                                    | "N entries"                              |

`truncateProgressPattern` continues to be applied to pattern subjects (search, replace,
find) before placing them in `ProgressCtx.subject` — the truncation limit stays 40 chars.

## Data Flow

```
args parsed
  └─ progress(args) → ProgressCtx           subject, scope set once for this invocation

  └─ StderrProgressSink(ctx) created         only if process.stderr.isTTY
  └─ ProgressSession({ sinks: [stderrSink] })

  └─ plainMessage('start', ctx)
     └─ sendNotification → MCP client sees:  "Search: async.*await  src/"
  └─ stderrSink synthetic tick              stderr: "→  Search: async.*await  src/"

tool calls ctx.onProgress({ current: 45, total: 500 })
  └─ ProgressSession.set() → stderrSink.emit(tick)
     └─ ansiLine('tick', merged)            stderr: "·  Search: async.*await  45/500  1.2s"
  └─ plainMessage('tick', merged)
     └─ sendNotification → MCP client sees:  "Search: async.*await  45/500"

tool returns result
  └─ progressDone(args, result) → Partial<ProgressCtx>  e.g. { detail: "23 matches · 8 files" }
  └─ merged ctx
  └─ ProgressSession.complete()  → stderrSink.emit(complete)
     └─ ansiLine('done', merged)            stderr: "✓  Search: async.*await  src/  23 matches · 8 files  2.1s"
  └─ task store transitions to 'completed'  MCP client sees terminal state
```

For **non-task tools** (most tools are `taskSupport: 'forbidden'`): `sendNotification` is
still called for start and tick messages — these reach the client as progress notifications.
`StderrProgressSink` operates identically regardless of task mode.

## Error Handling

- `StderrProgressSink.emit` wraps `process.stderr.write` in try/catch — observability
  failures never propagate to the tool
- `plainMessage` / `ansiLine` never throw — all fields are optional, graceful empty string fallback
- `progressDone` exceptions are caught in `define.ts:coreHandler`; the done message
  falls back to `plainMessage('done', baseCtx)` without detail

## Testing

- `fmt.ts`: unit tests for `plainMessage` and `ansiLine` covering all phases, all optional
  fields present/absent, the `+N`/`-N` colorisation regex, and the edge case where subject
  and detail are both undefined (graceful empty output)
- `StderrProgressSink`: unit test with a mocked `process.stderr` write, verifying
  ANSI output is suppressed when `isTTY` is false
- `tasks.ts`: existing `task-orchestrator.test.ts` updated — assert `statusMessage` no
  longer contains the double `toolName: toolName:` prefix
- `define.ts`: existing tool registration tests verify `progress` (renamed from
  `progressLabel`) is called and produces valid `ProgressCtx`
- Integration: one end-to-end test for `search-content` asserting the tick message format
  `"Search: pattern  N/M"` appears in captured notifications
