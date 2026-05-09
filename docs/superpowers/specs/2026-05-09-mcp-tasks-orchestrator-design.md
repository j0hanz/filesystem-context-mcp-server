# Task Orchestrator Refactoring Design Spec

## Goal

Simplify and robustify MCP task execution in `filesystem-mcp` by centralizing background execution and cancellation logic into a `TaskOrchestrator` class and using an event-driven task store. This eliminates polling for cancellation and decouples tool handler implementations from task-specific execution contexts.

## Approach: The TaskOrchestrator Pattern

### 1. `EventedTaskStore` (replaces `ResultAwareInMemoryTaskStore`)

- Replace the current `ResultAwareInMemoryTaskStore` (in `src/server/task-store.ts`) with a new `EventedTaskStore` that extends the MCP SDK's `InMemoryTaskStore` and `EventEmitter`.
- **Event Emitting**: Override `updateTaskStatus`. When a task's status changes to `'cancelled'`, emit a `'cancelled'` event with the `taskId`.
- This provides an immediate, push-based cancellation signal, eliminating the need for `setInterval` polling in task execution.

### 2. `TaskOrchestrator`

- Introduce a new class `TaskOrchestrator` (e.g., in `src/server/task-orchestrator.ts`).
- **Responsibility**: It centralizes the lifecycle of background task execution and provides the handlers for `createTask`, `getTask`, and `getTaskResult` methods required by `ToolTaskHandler`.
- **State**: Maintains a `Map<string, AbortController>` mapping `taskId` to its corresponding `AbortController`.
- **Event Listener**: Upon instantiation (or initialization), it listens to the `EventedTaskStore`'s `'cancelled'` event. When triggered, it looks up the corresponding `AbortController` in the `Map` and calls `abort()`, passing a `Task cancelled by client` error.
- **Execution Flow (`createTask`)**:
  - Creates the task in the store.
  - Generates an `AbortController` and stores it in the `Map`.
  - Fires the background async execution of the actual tool logic.
  - When the background execution completes or fails, it calls `storeTaskResult` directly on the store and deletes the `AbortController` from the `Map`.
- **Task Retrieval (`getTask`, `getTaskResult`)**: Merely delegates to the `taskStore`.

### 3. Clean Tool Signature & Context

- The tool handler functions (e.g., in `src/tools/*.ts`) will no longer receive `TaskToolContext` or know whether they are executing as a task or a direct tool call.
- The execution context (`ToolContext`) will contain:
  - `signal: AbortSignal` (tied to the task's `AbortController` or the server request's `AbortSignal`).
  - `progress: ProgressSink` (using the progress callbacks from `progressSinks`).
- The tools remain purely focused on business logic.

### 4. Refactoring `tool-execution.ts` & `shared.ts`

- **`tool-execution.ts`**: Strip out all the background processing, polling loops (`runTaskInBackground`, `cancelPoller`), and state management. It acts purely as a routing layer (`registerStandardTool`). It determines whether to call `server.registerTool` or use the `TaskOrchestrator` to call `server.experimental.tasks.registerToolTask`, wrapping the tool handler as needed.
- **`shared.ts`**: Simplify `ToolContext` to include `signal` and `progress`. Remove `TaskToolContext` completely, as tools no longer need `taskStore` or `taskId`.

## Testing Strategy

- **Unit Tests**: Test `EventedTaskStore` events. Test `TaskOrchestrator` cancellation via events and execution completion.
- **Integration Tests**: Verify tools still work correctly both directly and via task mode (`tools/call` vs. `tasks/create`).
