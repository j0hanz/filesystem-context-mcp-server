# extract-search-engine

## 1. Goal

- Extract the search engine logic into a dedicated core search module and refactor calling tools to delegate to it, ensuring that all existing and new search-related tests pass successfully.
- Completion signal: All tests in `__tests__/tools/search.test.ts` pass successfully after the refactor.

## 2. Requirements

- `REQ-001`: The search engine MUST reside in a dedicated directory `src/core/search/`.
- `REQ-002`: The search engine MUST export the `executeSearch` function in `src/core/search/engine.ts`.
- `REQ-003`: The `search_text` tool MUST delegate search execution to `executeSearch`.
- `REQ-004`: The `find_files` tool MUST delegate search execution to `executeSearch`.
- `REQ-005`: The `replace_text` tool MUST delegate file search to `executeSearch`.
- `SEC-001`: The search engine MUST use the RE2 regular expression library for all regex-based searches to prevent ReDoS.
- `PERF-001`: The search engine MUST complete in-memory matches in less than 50 milliseconds for files under 10 megabytes.
- `COMP-001`: The implementation MUST run in Node.js version 24 or higher using ES Modules.

## 3. Constraints

- `CON-001`: The search engine MUST NOT bypass `GuardedFileSystem` path validation.
- `CON-002`: The search engine MUST NOT block the main Node.js event loop during disk walking and pattern matching.

## 4. Interfaces

The system exposes the following interfaces:

### Search Options (`SearchOptions`)

**Input:**

- `pattern` (string, required): The search term or regular expression pattern.
- `path` (string, optional): The directory or file path to search.
- `filePattern` (string, optional): Glob pattern to filter target files.
- `excludePatterns` (array of strings, optional): Glob patterns to exclude.
- `caseSensitive` (boolean, optional): Whether the match should be case-sensitive.
- `wholeWord` (boolean, optional): Whether to match only whole words.
- `isLiteral` (boolean, optional): Whether to treat pattern as a literal string.
- `maxResults` (number, optional): Maximum number of matches to return.
- `maxFileSize` (number, optional): Maximum file size in bytes to scan.
- `maxFilesScanned` (number, optional): Maximum number of files to scan.
- `timeoutMs` (number, optional): Execution timeout in milliseconds.
- `skipBinary` (boolean, optional): Whether to skip binary files.
- `contextBefore` (number, optional): Number of context lines before each match.
- `contextAfter` (number, optional): Number of context lines after each match.

### Search Result (`SearchResult`)

**Output:**

- `filesMatched` (array of FileMatch objects): Files containing matches.
  - `filePath` (string): Absolute or relative path to matching file.
  - `matches` (array of ContentMatch objects): Individual line matches.
    - `line` (number): 1-indexed line number of the match.
    - `content` (string): The content of the matching line.
    - `before` (array of strings): Context lines before the match.
    - `after` (array of strings): Context lines after the match.
- `summary` (object): Statistics of the search.
  - `filesScanned` (number): Total count of files scanned.
  - `filesMatched` (number): Total count of files with at least one match.
  - `matchesCount` (number): Total count of matches found.
  - `truncated` (boolean): Whether results were truncated because of limits.

**Errors:**

- `400`: Invalid glob pattern or invalid regex pattern.
- `403`: Permission denied or path validation failure (if user requests a path restricted by PathGuard).
- `404`: File or directory not found.
- `500`: Search execution timed out or worker pool crashed.

## 5. Context

- Files: [src/tools/search-content.ts](file:///C:/filesystem-mcp/src/tools/search-content.ts), [src/tools/search-files.ts](file:///C:/filesystem-mcp/src/tools/search-files.ts), [src/tools/replace-in-files.ts](file:///C:/filesystem-mcp/src/tools/replace-in-files.ts)
- Current behavior: Worker pools and matchers are inlined directly within `search-content.ts` and `search-files.ts`.
- Conventions: ESM imports with `.js` extensions, Zod schemas for validation, and standard MCP error mapping via `Problem`.

## 6. Acceptance Criteria & Validation

- `AC-001`: The `search_text` tool returns matching lines with context identical to the current implementation.
- `VAL-001`: `node --test --import tsx __tests__/tools/search.test.ts`
- `AC-002`: The `find_files` tool returns matching file names identical to the current implementation.
- `VAL-002`: `node --test --import tsx __tests__/tools/search.test.ts`
- `AC-003`: All project static analysis and lint checks pass cleanly.
- `VAL-003`: `npm run check:static`

## 7. Examples & Edge Cases

**Positive example:**

```
Input: executeSearch(fs, { pattern: "GuardedFileSystem", filePattern: "src/**/*.ts" })
Output: SearchResult containing paths, lines, and match summary.
```

**Edge cases:**

- Empty pattern or query: The search engine MUST return early with an empty SearchResult.
- Binary file encountered: The search engine MUST skip binary files when `skipBinary` is true.
- Restricted path: The search engine MUST throw a path validation error matching a `403` status.
