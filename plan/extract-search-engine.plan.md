# extract-search-engine

Spec: [extract-search-engine.specs.md](extract-search-engine.specs.md)

## Goal

Extract the search engine logic into a dedicated core search module and refactor calling tools to delegate to it, ensuring that all existing and new search-related tests pass successfully.

## PHASE-001: Implementation

### TASK-001: Implement COMP-001

Depends on: none
Files: [UNVERIFIED](src/core/search/types.ts)
Symbols: none
Satisfies: COMP-001
Action: Create `src/core/search/types.ts` to define types for `SearchOptions`, `ContentMatch`, `FileMatch`, and `SearchResult` compatible with Node.js >= 24 ESM.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: TypeScript compilation succeeds with no type errors in types.ts.

### TASK-002: Implement PERF-001 and SEC-001

Depends on: TASK-001
Files: [UNVERIFIED](src/core/search/engine.ts)
Symbols: [executeSearch](src/core/search/engine.ts)
Satisfies: PERF-001, SEC-001
Action: Implement core chunked buffer-based matching logic in `src/core/search/engine.ts` using the RE2 regex engine to prevent ReDoS.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: Matcher compiling and matching logic compiles cleanly without type errors.

### TASK-003: Implement REQ-001 and CON-001

Depends on: TASK-002
Files: [UNVERIFIED](src/core/search/engine.ts)
Symbols: [executeSearch](src/core/search/engine.ts)
Satisfies: REQ-001, CON-001
Action: Implement file system walking and parsing in `src/core/search/engine.ts` using only the provided `GuardedFileSystem` instance for all path and read operations.
Validate: `npx tsc -p tsconfig.json --noEmit`
Expected result: The core search engine walk and read logic compiles cleanly.

### TASK-004: Implement REQ-002 and CON-002

Depends on: TASK-003
Files: [UNVERIFIED](src/core/search/engine.ts)
Symbols: [executeSearch](src/core/search/engine.ts)
Satisfies: REQ-002, CON-002
Action: Implement worker thread offloading for directory walking and pattern matching in `executeSearch`, and update `__tests__/tools/search-worker-pool.test.ts` to import the worker pool from the new search module.
Validate: `node --test --import tsx "__tests__/tools/search-worker-pool.test.ts"`
Expected result: The search worker pool operates in worker threads without blocking, and tests pass.

### TASK-005: Implement REQ-003

Depends on: TASK-004
Files: [src/tools/search-content.ts](src/tools/search-content.ts)
Symbols: [searchContent](src/tools/search-content.ts#L1242)
Satisfies: REQ-003
Action: Refactor the `searchContent` tool in `search-content.ts` to call the new `executeSearch` function, removing duplicated inline worker pool and matcher code.
Validate: `node --test --import tsx "__tests__/tools/search.test.ts"`
Expected result: Grep integration tests for `search_text` pass successfully.

### TASK-006: Implement REQ-004

Depends on: TASK-005
Files: [src/tools/search-files.ts](src/tools/search-files.ts)
Symbols: [searchFiles](src/tools/search-files.ts#L435)
Satisfies: REQ-004
Action: Refactor the `searchFiles` tool in `search-files.ts` to delegate to `executeSearch`.
Validate: `node --test --import tsx "__tests__/tools/search.test.ts"`
Expected result: Glob-based file name search integration tests for `find_files` pass successfully.

### TASK-007: Implement REQ-005

Depends on: TASK-006
Files: [src/tools/replace-in-files.ts](src/tools/replace-in-files.ts)
Symbols: none
Satisfies: REQ-005
Action: Refactor the file search logic in `replace-in-files.ts` to delegate to `executeSearch`.
Validate: `node --test --import tsx "__tests__/tools/search.test.ts"`
Expected result: `replace_text` integration tests pass successfully.

### TASK-008: Verify SEC-001 Integrity

Depends on: TASK-007
Files: [UNVERIFIED](src/core/search/engine.ts)
Symbols: [executeSearch](src/core/search/engine.ts)
Satisfies: SEC-001
Action: Run static analysis checks to confirm that the RE2 regex engine is used exclusively for all user-supplied patterns.
Validate: `npm run check:static`
Expected result: The project static analysis and linting checks pass without error.

## PHASE-END: Acceptance

### TASK-009: Final acceptance verification

Depends on: TASK-008
Files: none
Symbols: none
Satisfies: AC-001, AC-002, AC-003
Action: Run full test suite and build verification tasks to confirm the system's overall functionality.
Validate: `npm run check`
Expected result: All tests pass, linting succeeds, and compilation is successful.
