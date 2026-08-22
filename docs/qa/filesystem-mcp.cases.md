# Test Cases: filesystem-mcp

Manual test cases for the filesystem-mcp server: tools, resources, prompts, transport, CLI, and security surfaces. Drafted 2026-08-22 against the `dev` branch source (`src/tools/`, `src/resources.ts`, `src/prompts.ts`, `src/transport.ts`, `src/cli.ts`, `src/http-policy.ts`, `src/core/`).

- **Spec:** none. Every case carries `Traceability: Not required`. If a spec is added later, link requirement IDs here.
- **Platform:** Windows 11 (win32) primary. Where behavior is POSIX-only (symlink semantics, alternate data streams), the case notes it.
- **Transports under test:** stdio and Streamable HTTP (both legacy sessionful and modern per-request legs).
- **Test data:** a writable workspace root under a temp directory, e.g. `%TEMP%\fsmcp-qa\`, populated per case. Every case cleans up its own fixtures unless it explicitly leaves state for a follow-on case.

## Priority summary

| Priority | Count | Meaning                                           |
| :------- | :---- | :------------------------------------------------ |
| P0       | 9     | Critical path every run; broken = server unusable |
| P1       | 32    | High impact; before release                       |
| P2       | 29    | Moderate; release or next cycle                   |
| P3       | 10    | Low; when possible                                |

## Coverage map

| Surface                    | Risk                                                                                           | Test type               | Cases                                 |
| :------------------------- | :--------------------------------------------------------------------------------------------- | :---------------------- | :------------------------------------ |
| `read`                     | partial reads, batch budget, range validation, sensitive/symlink denial                        | Functional, Security    | TC-FUNC-001, TC-SEC-001, TC-SEC-003   |
| `list`                     | depth, hidden/ignored, overflow cache                                                          | Functional              | TC-FUNC-002, TC-PERF-005              |
| `stat`                     | single/batch, symlink target                                                                   | Functional              | TC-FUNC-003                           |
| `find_files`               | glob, pagination, sort, truncation cache                                                       | Functional              | TC-FUNC-004                           |
| `search_text`              | regex, glob filter, pagination, inline cap, timeout                                            | Functional, Performance | TC-FUNC-005, TC-PERF-002              |
| `hash_file`                | algorithm set, directory mode, dedup                                                           | Functional              | TC-FUNC-006                           |
| `create`                   | batch, overwrite, parent mkdir, grant                                                          | Functional              | TC-FUNC-007, TC-FUNC-017              |
| `edit`                     | modes, dryRun, unmatched, size cap                                                             | Functional              | TC-FUNC-008                           |
| `replace_text`             | literal/regex, flags, diff, cap                                                                | Functional              | TC-FUNC-009                           |
| `move`                     | rename, batch, self, into-subdir, dup-dest, EXDEV, overwrite confirm                           | Functional              | TC-FUNC-010, TC-FUNC-015, TC-FUNC-016 |
| `delete`                   | recursive confirm, root guard, TOCTOU                                                          | Functional              | TC-FUNC-011, TC-FUNC-013, TC-FUNC-014 |
| `list_roots`               | negotiated roots, list_changed                                                                 | Functional              | TC-FUNC-012, TC-INT-033               |
| input_required round-trips | destructive confirm, grant, path mismatch, HMAC                                                | Functional, Security    | TC-FUNC-013–018, TC-SEC-009           |
| sensitive paths            | `.env`/`*.pem`/`*id_rsa*` default + denylist + allow-sensitive                                 | Security                | TC-SEC-001, TC-SEC-002, TC-SEC-011    |
| path safety                | traversal, shell metachars, reserved devices, null bytes, ADS                                  | Security                | TC-SEC-004–007, TC-SEC-010            |
| resources                  | instructions, file template, cached result TTL, subscribe/unsubscribe, watcher cap, completion | Integration             | TC-INT-001–010                        |
| prompts                    | get-help, analyze-path, find-in-tree, summarize-directory, arg validation                      | Functional              | TC-FUNC-019–029                       |
| transport                  | stdio/HTTP init, session eviction, body limit, healthz                                         | Integration             | TC-INT-011–017, TC-INT-031            |
| CLI flags                  | read-only, allow-cwd, walk-cwd, deny, root-boundary, allow-missing-roots, max-file-size        | Integration             | TC-INT-018, TC-INT-026–032            |
| HTTP security              | API_KEY bearer, CORS, rate limit, bind policy, host allowlist, discovery                       | Integration, Security   | TC-INT-019–025                        |
| limits/eviction            | file size, search timeout, batch budget, result LRU                                            | Performance             | TC-PERF-001–005                       |
| init gate                  | calls before roots initialized                                                                 | Integration             | TC-INT-031                            |

Gaps: none. Every tool, resource, prompt, transport, CLI flag, and documented limit maps to at least one case or an explicit edge row inside a case.

## Smoke

### SMOKE-001: Critical discovery path — list_roots → list → stat → read

**Priority:** P0
**Type:** Smoke
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm the server's advertised happy path works end to end on a fresh connection: discover roots, list a root, stat a file, read it.

#### Preconditions

- Server started stdio with one allowed root `%TEMP%\fsmcp-qa\smoke` containing `hello.txt` with content `hello world`.
- Client connected, `initialize` completed (roots negotiated).

#### Steps

1. Call `list_roots` with `{}`.
   - **Expected:** `ok: true`, `roots` contains the absolute `%TEMP%\fsmcp-qa\smoke` path.
2. Call `list` with `path` = the root from step 1, `maxDepth: 1`.
   - **Expected:** `ok: true`, `entries` includes `hello.txt` with `type: "file"`; `markdown` contains an ASCII tree.
3. Call `stat` with `path` = `<root>\hello.txt`.
   - **Expected:** `ok: true`, `value.size > 0`, `value.type: "file"`, `value.tokenEstimate` present (`size / 4`).
4. Call `read` with `path` = `<root>\hello.txt`.
   - **Expected:** `ok: true`, result `value.content` equals `hello world`, `value.mimeType` is `text/plain`.

#### Test data

| Field | Value                   | Notes                                                       |
| :---- | :---------------------- | :---------------------------------------------------------- |
| root  | `%TEMP%\fsmcp-qa\smoke` | single allowed root                                         |
| file  | `hello.txt`             | 11 bytes, no trailing newline variant tested in TC-FUNC-001 |

#### Post-conditions

- No files mutated.
- Workspace root unchanged.

#### Edge cases

| Variation                             | Input                                   | Expected                                                                                                                                                                                                            |
| :------------------------------------ | :-------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| roots not negotiated yet              | call before `notifications/initialized` | tool returns `isError` "Server not initialized. Roots unavailable." (covered TC-INT-031)                                                                                                                            |
| multiple roots, `list` with no `path` | `list {}`                               | `INVALID_INPUT` "Either 'path' or 'paths' must be provided" is not the behavior — `list` `path` is optional; with multiple roots and no path it resolves via `resolvePathOrRoot` → `INVALID_INPUT` "multiple roots" |

#### Related

- TC-INT-031, TC-FUNC-012

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### SMOKE-002: Create → read → edit → read → delete lifecycle

**Priority:** P0
**Type:** Smoke
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 4
**Created:** 2026-08-22

#### Objective

Confirm the mutating tool lifecycle works: create a file, read it back, edit it, read the change, delete it.

#### Preconditions

- Server started with allowed root `%TEMP%\fsmcp-qa\smoke` (writable). Not `--read-only`.

#### Steps

1. Call `create` with `files: [{path: "<root>\lifecycle.txt", content: "alpha\n"}]`.
   - **Expected:** `ok: true`, one result row with `size: 6`, `resourceUri` present, `created`/`modified` ISO timestamps.
2. Call `read` with `path: "<root>\lifecycle.txt"`.
   - **Expected:** `value.content` equals `alpha\n`, `value.lineCount` = 1 or 2 per newline handling.
3. Call `edit` with `path: "<root>\lifecycle.txt", edits: [{oldText: "alpha", newText: "beta"}]`.
   - **Expected:** `ok: true`, `summary.failed: 0`, result `appliedEdits: 1`.
4. Call `read` with `path: "<root>\lifecycle.txt"`.
   - **Expected:** `value.content` equals `beta\n`.
5. Call `delete` with `paths: ["<root>\lifecycle.txt"]`.
   - **Expected:** `ok: true`, `path` present, no `failures`.
6. Call `read` with `path: "<root>\lifecycle.txt"`.
   - **Expected:** `isError`, code `NOT_FOUND`.

#### Test data

| Field | Value                  | Notes                       |
| :---- | :--------------------- | :-------------------------- |
| file  | `<root>\lifecycle.txt` | created and removed per run |

#### Post-conditions

- `lifecycle.txt` does not exist after run.

#### Edge cases

| Variation            | Input         | Expected                                                                           |
| :------------------- | :------------ | :--------------------------------------------------------------------------------- |
| server `--read-only` | steps 1, 3, 5 | tools absent from `tools/list`; call returns method-not-found (covered TC-INT-018) |

#### Related

- TC-FUNC-007, TC-FUNC-008, TC-FUNC-011, TC-INT-018

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

## Tools — read-only

### TC-FUNC-001: read — partial reads, batch, hash, range validation

**Priority:** P0
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 8
**Created:** 2026-08-22

#### Objective

Cover `read` across its parameter surface: single vs batch, line-window params (`head`/`tail`/`startLine`/`endLine`), byte-range (`offset`/`length`), `includeHash`, continuation, and every `validateReadRange` rejection.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\read` containing `lines.txt` (20 lines `line01`…`line20`, trailing newline), `big.txt` (> `MAX_READ_MANY_TOTAL_SIZE` when summed, see TC-PERF-003), and `empty.txt` (0 bytes).
- `MAX_TEXT_FILE_SIZE` at default 10 MiB.

#### Steps

1. `read {path: "<root>\lines.txt"}`.
   - **Expected:** full content, `value.totalLines` = 20, `value.linesRead` = 20, `value.hasMoreLines: false`.
2. `read {path, head: 5}`.
   - **Expected:** `content` = `line01`…`line05`, `value.head: 5`.
3. `read {path, tail: 3}`.
   - **Expected:** `content` = `line18`…`line20`, `value.tail: 3`.
4. `read {path, startLine: 10, endLine: 12}`.
   - **Expected:** `content` = `line10`…`line12`, `value.startLine: 10`, `value.endLine: 12`.
5. `read {path, offset: 0, length: 5}` (single file only).
   - **Expected:** `value.bytesRead: 5`, `value.reachedEOF: false`, `content` = first 5 bytes.
6. `read {path, includeHash: true}`.
   - **Expected:** `value.contentHash` is a 64-char lowercase hex sha256.
7. `read {paths: ["<root>\lines.txt", "<root>\empty.txt"]}`.
   - **Expected:** `summary.total: 2`, `summary.succeeded: 2`; empty file `value.content: ""`, `totalLines: 0`.
8. `read {path, startLine: 20, endLine: 20}`.
   - **Expected:** last line only, `hasMoreLines: false`.

#### Test data

| Field     | Value    | Notes                           |
| :-------- | :------- | :------------------------------ |
| lines.txt | 20 lines | trailing newline                |
| empty.txt | 0 bytes  | boundary                        |
| big.txt   | 512 KiB+ | batch budget case (TC-PERF-003) |

#### Post-conditions

- No files mutated.

#### Edge cases

| Variation                    | Input                                | Expected                                                                    |
| :--------------------------- | :----------------------------------- | :-------------------------------------------------------------------------- |
| head + startLine             | `head: 5, startLine: 1`              | `VALIDATION_FAILED` "Cannot use 'head' with 'startLine'/'endLine'"          |
| tail + head                  | `tail: 3, head: 5`                   | `VALIDATION_FAILED` "Cannot use 'tail' with 'head'/'startLine'/'endLine'"   |
| endLine without startLine    | `endLine: 5`                         | `VALIDATION_FAILED` "'endLine' requires 'startLine' to be set"              |
| endLine < startLine          | `startLine: 10, endLine: 5`          | `VALIDATION_FAILED` "'endLine' must be >= 'startLine'"                      |
| offset + line param          | `offset: 0, head: 5`                 | `VALIDATION_FAILED` byte_range_no_line_params                               |
| offset/length in batch       | `paths: [...], offset: 0, length: 5` | `VALIDATION_FAILED` "'offset' and 'length' are not supported in batch mode" |
| nonexistent file             | `path: "<root>\nope.txt"`            | `NOT_FOUND`                                                                 |
| path is a directory          | `path: "<root>"`                     | `NOT_FILE` (defaultErrorCode)                                               |
| neither path nor paths       | `read {}`                            | `VALIDATION_FAILED` "Either 'path' or 'paths' must be provided"             |
| both path and paths          | `path: x, paths: [x]`                | `VALIDATION_FAILED` "Cannot use both 'path' and 'paths'"                    |
| file over MAX_TEXT_FILE_SIZE | `path` = 11 MiB file                 | `TOO_LARGE` (read path; budget path in TC-PERF-001)                         |
| binary file                  | `path` = png                         | `value.kind` binary; `mimeType` from sniff                                  |

#### Related

- TC-PERF-001, TC-PERF-003, TC-SEC-001, TC-SEC-003

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-002: list — depth, hidden/ignored, entries overflow

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 6
**Created:** 2026-08-22

#### Objective

Cover `list` recursion depth, hidden/ignored inclusion, entries cap with externalized cache, and error paths.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\list` with tree: `a/`, `a/b/`, `a/b/c.txt`, `.hidden`, `node_modules/pkg/index.js`, `.git/config`, top-level `top.txt`.

#### Steps

1. `list {path: "<root>", maxDepth: 1}`.
   - **Expected:** `entries` = `a` (dir), `top.txt` (file); `.hidden`, `node_modules`, `.git` excluded; `totalDirectories: 1`, `totalFiles: 1`.
2. `list {path: "<root>", maxDepth: 3}`.
   - **Expected:** `a/b/c.txt` appears; `totalEntries` reflects depth-3 walk excluding hidden/ignored.
3. `list {path: "<root>", maxDepth: 1, includeHidden: true}`.
   - **Expected:** `.hidden` included; `node_modules`, `.git` still excluded.
4. `list {path: "<root>", maxDepth: 1, includeIgnored: true}`.
   - **Expected:** `node_modules`, `.git` included.
5. `list {path: "<root>", maxEntries: 1}`.
   - **Expected:** inline `entries` truncated to 1; `resourceUri` present (full list cached); `totalEntries > entryCount`.

#### Test data

| Field | Value            | Notes                    |
| :---- | :--------------- | :----------------------- |
| tree  | mixed dirs/files | hidden + ignored present |

#### Post-conditions

- No mutations.

#### Edge cases

| Variation            | Input                     | Expected                                                   |
| :------------------- | :------------------------ | :--------------------------------------------------------- |
| nonexistent dir      | `path: "<root>\missing"`  | `NOT_DIRECTORY` (defaultErrorCode)                         |
| path is a file       | `path: "<root>\top.txt"`  | `NOT_DIRECTORY`                                            |
| empty dir            | `path: "<root>\emptydir"` | `entries: []`, `totalEntries: 0`, `markdown` shows the dir |
| maxDepth: 0          | `maxDepth: 0`             | base dir only (schema min is 0)                            |
| no path, single root | `list {}`                 | lists the single allowed root                              |

#### Related

- TC-FUNC-012, TC-PERF-005

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-003: stat — single, batch, symlink target

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 5
**Created:** 2026-08-22

#### Objective

Cover `stat` single/batch, directory vs file, symlink `symlinkTarget`, and `tokenEstimate`.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\stat` with `file.txt` (12 bytes), `dir/`, and `link.txt` symlink to `file.txt`.

#### Steps

1. `stat {path: "<root>\file.txt"}`.
   - **Expected:** `value.type: "file"`, `value.size: 12`, `value.tokenEstimate: 3`, `value.mimeType`, `value.permissions` string.
2. `stat {path: "<root>\dir"}`.
   - **Expected:** `value.type: "directory"`; batch counts reflect.
3. `stat {paths: ["<root>\file.txt", "<root>\dir", "<root>\link.txt"]}`.
   - **Expected:** `summary.total: 3, succeeded: 3`; link row `value.symlinkTarget` resolves to `file.txt`; `resourceUri` present (batch > 1).
4. `stat {path: "<root>\link.txt"}`.
   - **Expected:** `value.symlinkTarget` present; followed stats shown.

#### Test data

| Field    | Value               | Notes                                  |
| :------- | :------------------ | :------------------------------------- |
| link.txt | symlink to file.txt | Windows needs dev mode/admin to create |

#### Post-conditions

- No mutations.

#### Edge cases

| Variation              | Input                  | Expected                                                                    |
| :--------------------- | :--------------------- | :-------------------------------------------------------------------------- |
| nonexistent            | `path: "<root>\nope"`  | per-path `error.code: "NOT_FOUND"` (defaultErrorCode)                       |
| neither path nor paths | `stat {}`              | `VALIDATION_FAILED` "Either 'path' or 'paths' must be provided"             |
| both path and paths    | both set               | `VALIDATION_FAILED` "Cannot use both 'path' and 'paths'"                    |
| > 1000 paths           | 1001 paths             | `VALIDATION_FAILED` (array max 1000)                                        |
| broken symlink         | link to missing target | `symlinkTarget` present; readlink errors swallowed (warning) unless aborted |

#### Related

- TC-FUNC-001, TC-SEC-003

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-004: find_files — glob, depth, pagination, sort, truncation

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 7
**Created:** 2026-08-22

#### Objective

Cover `find_files` glob matching, depth/hidden flags, cursor pagination, sort modes, and overflow cache.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\find` with `a.ts`, `a.js`, `deep/x/y/z.ts`, `.config.ts`, `node_modules/pkg/index.js`.

#### Steps

1. `find_files {pattern: "**/*.ts"}`.
   - **Expected:** `results` = `a.ts`, `deep/x/y/z.ts`; `.config.ts` excluded (hidden), node_modules excluded (ignored); `root` = the allowed root.
2. `find_files {pattern: "**/*.ts", includeHidden: true}`.
   - **Expected:** `.config.ts` included.
3. `find_files {pattern: "**/*.ts", maxDepth: 1}`.
   - **Expected:** only top-level `a.ts`; `deep/...` excluded by depth.
4. `find_files {pattern: "**/*", maxResults: 2}` then use returned `nextCursor` for the next page.
   - **Expected:** page 1 `results.length <= 2`; second call with `cursor` returns the next page; `resourceUri` present (paginated).
5. `find_files {pattern: "**/*", sortBy: "name"}` vs `sortBy: "path"`.
   - **Expected:** order differs per sort key; `results` are relative paths.

#### Test data

| Field   | Value     | Notes                                   |
| :------ | :-------- | :-------------------------------------- |
| pattern | `**/*.ts` | SafeGlobPattern; no `/` prefix, no `..` |

#### Post-conditions

- No mutations.

#### Edge cases

| Variation                               | Input                       | Expected                                            |
| :-------------------------------------- | :-------------------------- | :-------------------------------------------------- |
| no matches                              | `pattern: "**/*.nomatch"`   | `results: []`, `totalMatches: 0`                    |
| invalid pattern (absolute)              | `pattern: "/etc/*"`         | `INVALID_PATTERN` "Invalid glob or unsafe path"     |
| pattern with `..`                       | `pattern: "../x"`           | `VALIDATION_FAILED` (isSafeGlobSyntax rejects `..`) |
| nonexistent base                        | `path: "<root>\missing"`    | `NOT_DIRECTORY` (validateExistingDirectory)         |
| default path, multiple roots, no `path` | `find_files {pattern: ...}` | uses first allowed root                             |

#### Related

- TC-FUNC-005, TC-PERF-002

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-005: search_text — literal, regex, flags, pagination, inline cap, timeout

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 8
**Created:** 2026-08-22

#### Objective

Cover `search_text` literal vs regex, case sensitivity, glob file filter, pagination cursor, inline-match cap externalizing to `resourceUri`, and regex compile errors.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\search` with `app.ts` (`const Token = 1;` / `const token = 2;`), `notes.md` (`Tokenize the tokens.`), and 60 files each containing one `needle` match (to exceed inline cap 50).

#### Steps

1. `search_text {searchPattern: "token"}`.
   - **Expected:** matches `app.ts` lines 1 and 2 (case-insensitive default) and `notes.md` (`Tokenize`, `tokens`); `matches[].line`, `matches[].content` present.
2. `search_text {searchPattern: "token", caseSensitive: true}`.
   - **Expected:** only lowercase `token` occurrences.
3. `search_text {searchPattern: "const (\\w+)", isRegex: true}`.
   - **Expected:** matches `const Token`, `const token`; `matchCount` per line.
4. `search_text {searchPattern: "token", pattern: "**/*.ts"}`.
   - **Expected:** only `app.ts` matched; `notes.md` excluded by glob.
5. `search_text {searchPattern: "needle", maxResults: 10}` then follow `nextCursor`.
   - **Expected:** page of 10, cursor returns the next 10; `totalMatches` accumulates.
6. `search_text {searchPattern: "needle"}` over the 60-file fixture.
   - **Expected:** inline `matches` capped at `FS_CONTEXT_MAX_INLINE_MATCHES` (50), `truncated: true`, `resourceUri` present for the full set.

#### Test data

| Field         | Value             | Notes                                        |
| :------------ | :---------------- | :------------------------------------------- |
| searchPattern | literal and regex | max 10000 chars                              |
| inline cap    | 50 (default)      | override via `FS_CONTEXT_MAX_INLINE_MATCHES` |

#### Post-conditions

- No mutations.

#### Edge cases

| Variation                        | Input                                       | Expected                                                                             |
| :------------------------------- | :------------------------------------------ | :----------------------------------------------------------------------------------- |
| empty/whitespace pattern         | `searchPattern: "   "`                      | `VALIDATION_FAILED` "searchPattern cannot be empty or whitespace-only"               |
| invalid regex                    | `isRegex: true, searchPattern: "(unclosed"` | `INVALID_PATTERN`                                                                    |
| nonexistent base dir             | `path: "<root>\missing"`                    | `NOT_DIRECTORY`                                                                      |
| timeout (huge tree, low timeout) | large fixture                               | `stoppedReason: "timeout"` (TC-PERF-002)                                             |
| cursor reuse after result expiry | cached `nextCursor` after 60s               | cursor is offset-based and re-runs the query; resource fetch may expire (TC-INT-004) |

#### Related

- TC-FUNC-004, TC-PERF-002, TC-INT-004

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-006: hash_file — algorithm set, directory mode, dedup

**Priority:** P2
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 5
**Created:** 2026-08-22

#### Objective

Cover `hash_file` default and multi-algorithm, directory hashing (sha256 only), duplicate-algorithm rejection, and `resourceUri`.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\hash` with `file.bin` (known content) and `dir/` containing `a.txt`, `b.txt`.

#### Steps

1. `hash_file {path: "<root>\file.bin"}`.
   - **Expected:** `algorithms: ["sha256"]`, `hashes.sha256` matches a precomputed digest; `resourceUri` present; `isDirectory: false`.
2. `hash_file {path: "<root>\file.bin", algorithms: ["sha256","sha1","md5","sha512"]}`.
   - **Expected:** `algorithms` lists all four; `hashes` has four lowercase-hex entries.
3. `hash_file {path: "<root>\dir"}`.
   - **Expected:** `isDirectory: true`, `fileCount: 2`, `hashes.sha256` present; `resourceUri` present.
4. `hash_file {path: "<root>\dir", algorithms: ["sha1"]}`.
   - **Expected:** `INVALID_INPUT` "Directory hashing only supports sha256".

#### Test data

| Field    | Value         | Notes                               |
| :------- | :------------ | :---------------------------------- |
| file.bin | fixed content | precompute expected digests offline |

#### Post-conditions

- No mutations.

#### Edge cases

| Variation             | Input                             | Expected                                                   |
| :-------------------- | :-------------------------------- | :--------------------------------------------------------- |
| duplicate algorithms  | `algorithms: ["sha256","sha256"]` | `VALIDATION_FAILED` "Duplicate algorithms are not allowed" |
| empty algorithm array | `algorithms: []`                  | `VALIDATION_FAILED` (min 1)                                |
| > 4 algorithms        | 5 entries                         | `VALIDATION_FAILED` (max 4)                                |
| nonexistent path      | `path: "<root>\nope"`             | `NOT_FOUND`                                                |
| partial dir failure   | one unreadable file in dir        | `IO_ERROR`/first failure reported with `failedFiles` count |

#### Related

- TC-FUNC-003

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

## Tools — mutating

### TC-FUNC-007: create — single, batch, overwrite, parent mkdir, grant

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 6
**Created:** 2026-08-22

#### Objective

Cover `create` single and batch, automatic parent-directory creation, silent overwrite of existing files, batch cap, and per-file `resourceUri`.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\create` (writable), containing `existing.txt` with content `old`. Not `--read-only`.

#### Steps

1. `create {files: [{path: "<root>\a.txt", content: "hello"}]}`.
   - **Expected:** `ok: true`, one result row `size: 5`, `lineCount`, `kind: "file"`, `resourceUri` present, `created`/`modified` ISO.
2. `create {files: [{path: "<root>\sub\deep\c.txt", content: "x"}]}`.
   - **Expected:** parent dirs `sub\deep` created; result row `ok`.
3. `create {files: [{path: "<root>\existing.txt", content: "new"}]}`.
   - **Expected:** no error; file overwritten; `size: 3`; subsequent `read` returns `new`.
4. `create {files: [50 items]}`.
   - **Expected:** all created; `failures` absent or empty.

#### Test data

| Field        | Value    | Notes            |
| :----------- | :------- | :--------------- |
| existing.txt | `old`    | overwrite target |
| batch        | 50 files | under max 100    |

#### Post-conditions

- Created files remain unless cleaned by a follow-on case.

#### Edge cases

| Variation                       | Input                | Expected                                                 |
| :------------------------------ | :------------------- | :------------------------------------------------------- |
| > 100 files                     | 101 items            | `VALIDATION_FAILED` (array max 100)                      |
| empty files array               | `files: []`          | `VALIDATION_FAILED` (min 1)                              |
| content over MAX_TEXT_FILE_SIZE | 11 MiB content       | `VALIDATION_FAILED` (content `.max(MAX_TEXT_FILE_SIZE)`) |
| path with traversal             | `path: "..\x"`       | `VALIDATION_FAILED` (RequiredPath rejects `..`)          |
| out-of-root path                | `path` outside roots | `input_required` grant flow (TC-FUNC-017)                |
| --read-only server              | any create           | tool not registered; method-not-found (TC-INT-018)       |

#### Related

- TC-FUNC-017, TC-INT-018, TC-PERF-001

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-008: edit — single, multi-file, per-file, dryRun, unmatched, size cap

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 8
**Created:** 2026-08-22

#### Objective

Cover `edit` three input modes (single, shared `paths`, per-file `files`), `dryRun` diff preview, `ignoreWhitespace`, unmatched-oldText handling, batch cap, and the file-size cap.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\edit` with `one.txt` (`alpha\nbeta\ngamma\n`), `two.txt` (`alpha\nbeta\n`), `big.txt` (> 10 MiB).

#### Steps

1. `edit {path: "<root>\one.txt", edits: [{oldText: "beta", newText: "BETA"}]}`.
   - **Expected:** `ok: true`, `summary.failed: 0`, result `appliedEdits: 1`, `linesAdded: 0`; `resourceUri` present.
2. `edit {path: "<root>\one.txt", edits: [{oldText: "alpha", newText: "A"}, {oldText: "gamma", newText: "G"}]}` (sequential).
   - **Expected:** both applied in order; `appliedEdits: 2`.
3. `edit {paths: ["<root>\one.txt", "<root>\two.txt"], edits: [{oldText: "alpha", newText: "ALPHA"}]}`.
   - **Expected:** both files updated; `summary.total: 2, succeeded: 2`.
4. `edit {files: [{path: "<root>\one.txt", edits: [{oldText: "ALPHA", newText: "a"}]}, {path: "<root>\two.txt", edits: [{oldText: "ALPHA", newText: "a"}]}]}`.
   - **Expected:** per-file edits applied; `edits` at top level forbidden with `files`.
5. `edit {path: "<root>\two.txt", edits: [{oldText: "BETA", newText: "b"}], dryRun: true}` (where `BETA` may not exist).
   - **Expected:** no write; result `diff` present, `unmatchedEdits` lists the miss; `appliedEdits` reflects matches.
6. `edit {path: "<root>\two.txt", edits: [{oldText: "alpha", newText: "a"}], ignoreWhitespace: true}` against content with varying whitespace.
   - **Expected:** matches despite whitespace differences.

#### Test data

| Field   | Value                | Notes                  |
| :------ | :------------------- | :--------------------- |
| one.txt | 3 lines              | sequential edit target |
| big.txt | > MAX_TEXT_FILE_SIZE | size cap               |

#### Post-conditions

- Edits persist; restore fixtures between edge-case rows.

#### Edge cases

| Variation                         | Input                       | Expected                                                            |
| :-------------------------------- | :-------------------------- | :------------------------------------------------------------------ |
| oldText not found (non-dryRun)    | `oldText: "nope"`           | `INVALID_INPUT` "N edit(s) failed to match"                         |
| oldText empty/whitespace          | `oldText: "  "`             | `VALIDATION_FAILED` "oldText cannot be empty or whitespace-only"    |
| > 5 files                         | 6 paths                     | `VALIDATION_FAILED` (maxBatch 5)                                    |
| > 100 edits per file              | 101 edits                   | `VALIDATION_FAILED` (max 100)                                       |
| edits missing with path           | `path` set, no `edits`      | `VALIDATION_FAILED` "'edits' required when using 'path' or 'paths'" |
| edits present with files          | top-level `edits` + `files` | `VALIDATION_FAILED` "'edits' not allowed with 'files'"              |
| file too large                    | `path` = big.txt            | `TOO_LARGE` "File too large for edit"                               |
| none of path/paths/files          | `edit {}`                   | `VALIDATION_FAILED` triadic message                                 |
| more than one of path/paths/files | both                        | `VALIDATION_FAILED` triadic message                                 |

#### Related

- TC-FUNC-009, TC-PERF-001

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-009: replace_text — literal/regex, flags, diff, cap, invalid regex

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 7
**Created:** 2026-08-22

#### Objective

Cover `replace_text` literal vs regex (with capture groups), `caseSensitive`, `wholeWord`, `dryRun`+`returnDiff`, `maxResults`/`maxFiles` caps with `stoppedReason`, and `primaryFile.resourceUri`.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\replace` with `a.ts` (`const Foo = 1; const foo = 2;`), `b.ts` (`const Foo = 3;`), plus 120 files each containing one `oldval` to exceed `maxResults`/`maxFiles` caps.

#### Steps

1. `replace_text {searchPattern: "Foo", replacement: "Bar"}` (literal, case-insensitive default).
   - **Expected:** `filesModified` >= 2, `totalMatches` counts all `Foo`/`foo`; `primaryFile.resourceUri` present; `results` lists changed files (capped 100).
2. `replace_text {searchPattern: "Foo", replacement: "Bar", caseSensitive: true}`.
   - **Expected:** only `Foo` replaced, not `foo`.
3. `replace_text {searchPattern: "const (\\w+)", replacement: "let $1", isRegex: true}`.
   - **Expected:** capture-group substitution; `totalMatches` per occurrence.
4. `replace_text {searchPattern: "Foo", replacement: "Bar", wholeWord: true}` where `Foobar` exists.
   - **Expected:** `Foobar` not matched.
5. `replace_text {searchPattern: "oldval", replacement: "new", dryRun: true, returnDiff: true}`.
   - **Expected:** no writes; `diff` present (capped 20 KB); `filesModified` reflects what would change.
6. `replace_text {searchPattern: "oldval", replacement: "new", maxResults: 10}` over the 120-file fixture.
   - **Expected:** `stoppedReason: "maxResults"`; `results`/matches capped.
7. `replace_text {searchPattern: "oldval", replacement: "new", maxFiles: 5}`.
   - **Expected:** `stoppedReason: "maxFiles"`.

#### Test data

| Field         | Value               | Notes               |
| :------------ | :------------------ | :------------------ |
| searchPattern | literal/regex       | max 10000 chars     |
| caps          | maxResults/maxFiles | default 100 / unset |

#### Post-conditions

- Files mutated unless `dryRun`; restore between rows.

#### Edge cases

| Variation                    | Input                                    | Expected                                                               |
| :--------------------------- | :--------------------------------------- | :--------------------------------------------------------------------- |
| invalid regex                | `isRegex: true, searchPattern: "(?P<x>"` | `INVALID_PATTERN`                                                      |
| empty searchPattern          | `searchPattern: "  "`                    | `VALIDATION_FAILED` "searchPattern cannot be empty or whitespace-only" |
| replacement over 10000 chars | long replacement                         | `VALIDATION_FAILED` (max 10000)                                        |
| file too large to read       | one target > MAX_TEXT_FILE_SIZE          | per-file `TOO_LARGE` in `failures`, counted in `failedFiles`           |
| no matches                   | `searchPattern: "zzz"`                   | `filesModified: 0`, `totalMatches: 0`, no `primaryFile`                |
| pattern with `..`            | `pattern: "../x"`                        | `VALIDATION_FAILED`/`INVALID_PATTERN` (SafeGlobPattern)                |

#### Related

- TC-FUNC-008, TC-PERF-002

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-010: move — rename, batch, self, into-subdir, dup-dest, cross-device

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 7
**Created:** 2026-08-22

#### Objective

Cover `move` rename, batch, silent self-move skip, move-into-own-subdir rejection, duplicate-destination-in-batch rejection, and EXDEV cross-device fallback. Overwrite confirmation is a separate case (TC-FUNC-015).

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\move` with `a.txt`, `b.txt`, `dir/`. If a second drive/volume is available, note it for the EXDEV row.

#### Steps

1. `move {moves: [{source: "<root>\a.txt", destination: "<root>\a.renamed.txt"}]}`.
   - **Expected:** `ok: true`, `moves[].ok: true`; `a.renamed.txt` exists, `a.txt` gone.
2. `move {moves: [{source: "<root>\b.txt", destination: "<root>\sub\b.txt"}]}`.
   - **Expected:** parent `sub` auto-created; `b.txt` moved.
3. `move {moves: [{source: "<root>\dir", destination: "<root>\dir"}]}` (self-move).
   - **Expected:** silently skipped; not in `failures`.
4. `move {moves: [{source: "<root>\dir", destination: "<root>\dir\nested"}]}` (into own subdirectory).
   - **Expected:** `INVALID_INPUT` "Cannot move a directory into its own subdirectory".

#### Test data

| Field         | Value     | Notes         |
| :------------ | :-------- | :------------ |
| moves         | up to 100 | min 1         |
| second volume | optional  | for EXDEV row |

#### Post-conditions

- Moved files persist unless cleaned.

#### Edge cases

| Variation                      | Input                                | Expected                                                                                          |
| :----------------------------- | :----------------------------------- | :------------------------------------------------------------------------------------------------ |
| duplicate destination in batch | two moves to same dest               | `INVALID_INPUT` "Move cancelled: another entry ... already targets destination"                   |
| > 100 moves                    | 101 items                            | `VALIDATION_FAILED` (max 100)                                                                     |
| source missing                 | `source: "<root>\nope"`              | per-move `ACCESS_DENIED`/"Move failed for ..."                                                    |
| cross-device (EXDEV)           | source and dest on different volumes | copy-then-remove fallback; if remove fails, `IO_ERROR` "copy succeeded but source removal failed" |
| destination exists             | dest present                         | `input_required` overwrite confirm (TC-FUNC-015)                                                  |
| traversal in source/dest       | `..`                                 | `VALIDATION_FAILED` (RequiredPath)                                                                |

#### Related

- TC-FUNC-015, TC-FUNC-016

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-011: delete — file, batch, recursive, root guard, ignoreIfNotExists

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 6
**Created:** 2026-08-22

#### Objective

Cover `delete` of files and directories, recursive vs non-recursive, workspace-root guard, `ignoreIfNotExists`, and batch `paths`. Confirmation flows are separate cases (TC-FUNC-013, TC-FUNC-014).

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\delete` with `file.txt`, `emptydir/`, `fulldir/` containing `x.txt`. The allowed root itself is `<root>`.

#### Steps

1. `delete {paths: ["<root>\file.txt"]}`.
   - **Expected:** `ok: true`, `path` present, no `failures`; file gone.
2. `delete {paths: ["<root>\emptydir"]}`.
   - **Expected:** `ok: true`; empty dir removed without `recursive`.
3. `delete {paths: ["<root>\file.txt"], ignoreIfNotExists: true}` after removing it in step 1.
   - **Expected:** `ok: true`; no `NOT_FOUND` failure (ignored).
4. `delete {paths: ["<root>\nonexistent"], ignoreIfNotExists: false}`.
   - **Expected:** `ok` false or `failures` entry with code `NOT_FOUND`.

#### Test data

| Field     | Value         | Notes                       |
| :-------- | :------------ | :-------------------------- |
| paths     | up to 1000    | min 1                       |
| recursive | false default | required for non-empty dirs |

#### Post-conditions

- Deleted items gone; restore fixtures between runs.

#### Edge cases

| Variation                       | Input                        | Expected                                                                                                                            |
| :------------------------------ | :--------------------------- | :---------------------------------------------------------------------------------------------------------------------------------- |
| non-empty dir without recursive | `paths: ["<root>\fulldir"]`  | `input_required` confirmation (TC-FUNC-013); if forced without confirm, `INVALID_INPUT` "Directory not empty. Set recursive: true." |
| workspace root                  | `paths: ["<root>"]`          | `ACCESS_DENIED` "Deleting a workspace root directory is not allowed"                                                                |
| > 1000 paths                    | 1001                         | `VALIDATION_FAILED` (max 1000)                                                                                                      |
| traversal in path               | `..`                         | `VALIDATION_FAILED` (RequiredPath)                                                                                                  |
| symlink to outside              | link in root, target outside | delete succeeds (only link checked) (TC-SEC-008)                                                                                    |
| --read-only server              | any delete                   | tool not registered (TC-INT-018)                                                                                                    |

#### Related

- TC-FUNC-013, TC-FUNC-014, TC-SEC-008, TC-INT-018

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-012: list_roots — negotiated roots

**Priority:** P0
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm `list_roots` returns the roots negotiated at startup (CLI positionals, `FS_ALLOWED_DIRS`, `--allow-cwd`, and/or MCP `roots/list`), and that `roots/list_changed` re-negotiates them.

#### Preconditions

- Server started stdio with CLI positionals `%TEMP%\fsmcp-qa\root1` and `%TEMP%\fsmcp-qa\root2`, both existing. Client advertises `roots` capability with two `file://` roots.

#### Steps

1. Call `list_roots` after `initialize` completes.
   - **Expected:** `ok: true`, `roots` lists both absolute paths.
2. Client sends `notifications/roots/list_changed` with an updated root set.
   - **Expected:** server re-negotiates (debounced 100 ms); a subsequent `list_roots` returns the new set.
3. Client without `roots` capability, server started with `--allow-cwd`.
   - **Expected:** `list_roots` returns the CWD as the only root.

#### Test data

| Field | Value    | Notes                    |
| :---- | :------- | :----------------------- |
| roots | two dirs | CLI + MCP roots combined |

#### Post-conditions

- No filesystem changes.

#### Edge cases

| Variation                  | Input                                          | Expected                                        |
| :------------------------- | :--------------------------------------------- | :---------------------------------------------- |
| no roots anywhere          | no CLI, no env, no MCP roots, no `--allow-cwd` | `roots: []`; operator warning logged            |
| `list_changed` before init | notification during `initializing`             | ignored until `isInitialized()`                 |
| `list_roots` before init   | call before `notifications/initialized`        | `isError` "Server not initialized" (TC-INT-031) |

#### Related

- TC-INT-026, TC-INT-027, TC-INT-031, TC-INT-033

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

## Multi-round-trip (input_required)

These cases exercise the SEP-2577 multi-round-trip confirmation: a destructive or grant operation returns `input_required`; the client retries the same `tools/call` with `inputResponses` carrying a HMAC-sealed `requestState` and a `confirm` value.

### TC-FUNC-013: delete — non-empty dir, confirm accepted

**Priority:** P0
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 4
**Created:** 2026-08-22

#### Objective

Confirm `delete` of a non-empty directory prompts `input_required` round 1, and that retrying with `confirm: true` deletes recursively when `recursive: true`.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\delconf` with `fulldir/x.txt`.

#### Steps

1. `delete {paths: ["<root>\fulldir"]}` (no `recursive`).
   - **Expected:** result is `input_required` with one input request, `{confirm: boolean}` schema, and a `requestState` token.
2. Retry: `delete {paths: ["<root>\fulldir"], recursive: true}` with `inputResponses: [{requestState, content: {confirm: true}}]`.
   - **Expected:** `ok: true`; `fulldir` and `x.txt` removed.

#### Test data

| Field        | Value       | Notes        |
| :----------- | :---------- | :----------- |
| requestState | HMAC-sealed | from round 1 |

#### Post-conditions

- `fulldir` removed.

#### Edge cases

| Variation       | Input                       | Expected                                                                                   |
| :-------------- | :-------------------------- | :----------------------------------------------------------------------------------------- |
| confirm: false  | retry with `confirm: false` | `CANCELLED` "Delete cancelled: confirmation was declined or missing" (TC-FUNC-018 pattern) |
| confirm missing | retry with no `confirm`     | `CANCELLED` (readAcceptedConfirm treats missing as false)                                  |

#### Related

- TC-FUNC-014, TC-FUNC-018, TC-SEC-009

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-014: delete — confirm path mismatch

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a `requestState` minted for one set of paths is rejected when retried against a different set (path-mismatch guard, R9).

#### Preconditions

- As TC-FUNC-013, plus a second non-empty dir `otherdir/y.txt`.

#### Steps

1. `delete {paths: ["<root>\fulldir"]}` → receive `input_required` with `requestState`.
2. Retry `delete {paths: ["<root>\otherdir"], recursive: true}` reusing the `requestState` from step 1.
   - **Expected:** `INVALID_INPUT` "delete: confirmation does not match the requested paths".

#### Test data

| Field        | Value        | Notes                   |
| :----------- | :----------- | :---------------------- |
| requestState | from fulldir | reused against otherdir |

#### Post-conditions

- `otherdir` unchanged.

#### Edge cases

| Variation                    | Input                       | Expected                                   |
| :--------------------------- | :-------------------------- | :----------------------------------------- |
| paths reordered but same set | same paths, different order | accepted (`pathsEqual` sorts at mint time) |

#### Related

- TC-FUNC-013, TC-FUNC-016

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-015: move — overwrite, confirm accepted

**Priority:** P0
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 4
**Created:** 2026-08-22

#### Objective

Confirm `move` over an existing destination prompts `input_required` and that accepting overwrites the destination.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\moveconf` with `src.txt` and `dst.txt` (both exist).

#### Steps

1. `move {moves: [{source: "<root>\src.txt", destination: "<root>\dst.txt"}]}`.
   - **Expected:** `input_required` for the overwrite.
2. Retry with `inputResponses: [{requestState, content: {confirm: true}}]`.
   - **Expected:** `ok: true`; `dst.txt` now holds `src.txt`'s content; `src.txt` gone.

#### Test data

| Field   | Value        | Notes            |
| :------ | :----------- | :--------------- |
| dst.txt | pre-existing | overwrite target |

#### Post-conditions

- `dst.txt` overwritten, `src.txt` removed.

#### Edge cases

| Variation                                   | Input                                        | Expected                                                               |
| :------------------------------------------ | :------------------------------------------- | :--------------------------------------------------------------------- |
| destination appears during confirmation gap | create `dst.txt` after round 1, before retry | `CANCELLED` "destination ... was created during confirmation" (TOCTOU) |

#### Related

- TC-FUNC-016, TC-FUNC-010

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-016: move — confirm path mismatch

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a move `requestState` minted for one move set is rejected when retried against a different set.

#### Preconditions

- As TC-FUNC-015, plus a third file `other.txt`.

#### Steps

1. `move {moves: [{source: "<root>\src.txt", destination: "<root>\dst.txt"}]}` → `input_required`.
2. Retry `move {moves: [{source: "<root>\other.txt", destination: "<root>\dst.txt"}]}` reusing that `requestState`.
   - **Expected:** `INVALID_INPUT` "move: confirmation does not match the requested paths".

#### Test data

| Field        | Value        | Notes                |
| :----------- | :----------- | :------------------- |
| requestState | from src→dst | reused for other→dst |

#### Post-conditions

- Files unchanged.

#### Edge cases

| Variation             | Input               | Expected                        |
| :-------------------- | :------------------ | :------------------------------ |
| same moves, reordered | same set, new order | accepted (paths sorted at mint) |

#### Related

- TC-FUNC-014, TC-FUNC-015

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-017: grant — out-of-root access, confirm accepted

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 4
**Created:** 2026-08-22

#### Objective

Confirm any tool accessing a path outside the granted roots returns `input_required` (op `grant`), and that accepting grants the nearest existing ancestor as a new root.

#### Preconditions

- Server allowed root `%TEMP%\fsmcp-qa\grant`. A sibling directory `%TEMP%\fsmcp-qa\outside` exists and is readable but not in the allowed roots. No `ROOT_BOUNDARY` (or one that contains both).

#### Steps

1. `read {path: "%TEMP%\fsmcp-qa\outside\file.txt"}`.
   - **Expected:** `input_required` listing the grant target dir (`%TEMP%\fsmcp-qa\outside`).
2. Retry with `inputResponses: [{requestState, content: {confirm: true}}]`.
   - **Expected:** grant applied; read succeeds and returns content. A follow-up `list_roots` now includes the granted dir.

#### Test data

| Field       | Value           | Notes     |
| :---------- | :-------------- | :-------- |
| outside dir | sibling of root | grantable |

#### Post-conditions

- New root persisted for server lifetime; restart resets.

#### Edge cases

| Variation                          | Input                     | Expected                                                          |
| :--------------------------------- | :------------------------ | :---------------------------------------------------------------- |
| grant target is a filesystem root  | ancestor = drive root     | skipped (no whole-drive grant)                                    |
| grant target outside ROOT_BOUNDARY | boundary set excluding it | skipped; no `input_required` issued (re-check `isWithinBoundary`) |
| confirm: false                     | retry declining           | `CANCELLED`; no grant applied                                     |

#### Related

- TC-FUNC-018, TC-INT-029, TC-SEC-009

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-018: grant — confirm path mismatch

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a grant `requestState` minted for one path set is rejected when retried against a different set.

#### Preconditions

- As TC-FUNC-017, plus a second outside dir `%TEMP%\fsmcp-qa\outside2`.

#### Steps

1. `read {path: "%TEMP%\fsmcp-qa\outside\file.txt"}` → `input_required` with `requestState`.
2. Retry `read {path: "%TEMP%\fsmcp-qa\outside2\file.txt"}` reusing that `requestState`.
   - **Expected:** `INVALID_INPUT` "grant: confirmation does not match the requested paths".

#### Test data

| Field        | Value        | Notes               |
| :----------- | :----------- | :------------------ |
| requestState | from outside | reused for outside2 |

#### Post-conditions

- No grant applied.

#### Edge cases

| Variation                    | Input          | Expected                              |
| :--------------------------- | :------------- | :------------------------------------ |
| HMAC tampered `requestState` | modified token | `-32602` from SDK verify (TC-SEC-009) |

#### Related

- TC-FUNC-017, TC-SEC-009

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

## Security

### TC-SEC-001: read — sensitive file blocked by default

**Priority:** P0
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 4
**Created:** 2026-08-22

#### Objective

Confirm built-in sensitive patterns (`.env`, `*.pem`, `*.key`, `*id_rsa*`, `.npmrc`, `.aws/credentials`) are denied on read, stat, list, search, and resource read, regardless of being inside an allowed root.

#### Control

**OWASP:** A01 (Access Control) / sensitive-data exposure
**Risk:** High

- Attack vector under test: read/inspect a credential file inside an allowed root.
- Expected control: deny with `ACCESS_DENIED` "Sensitive file blocked. Set ALLOW_SENSITIVE=1 to override."; no content leak.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\sec` containing `.env`, `cert.pem`, `id_rsa`, `.npmrc`. `ALLOW_SENSITIVE` unset.

#### Steps

1. `read {path: "<root>\.env"}`.
   - **Expected:** `isError`, code `ACCESS_DENIED`, message names `ALLOW_SENSITIVE`.
2. `stat {path: "<root>\cert.pem"}`.
   - **Expected:** per-path `error.code: "ACCESS_DENIED"`.
3. `list {path: "<root>", includeHidden: true}`.
   - **Expected:** `.env` either excluded or, if listed, a follow-up `read` denied; stat-sensitive check fires on resolved realpath.
4. `resources/read` the filesystem resource URI for `<root>\.env`.
   - **Expected:** `ResourceNotFoundError`/`ProtocolError` (sensitivity re-checked on realpath).

#### Test data

| Field    | Value                                  | Notes         |
| :------- | :------------------------------------- | :------------ |
| fixtures | `.env`, `cert.pem`, `id_rsa`, `.npmrc` | sensitive set |

#### Post-conditions

- No content returned for any sensitive file.

#### Edge cases

| Variation                 | Input                               | Expected                                         |
| :------------------------ | :---------------------------------- | :----------------------------------------------- |
| symlink to sensitive file | link inside root → `..\..\real.env` | denied (realpath re-check)                       |
| `ALLOW_SENSITIVE=1`       | env set                             | built-ins suppressed; read succeeds (TC-SEC-011) |
| `.env.local`              | `.env.*` pattern                    | denied                                           |

#### Related

- TC-SEC-002, TC-SEC-003, TC-SEC-011

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-002: denylist always applies even with --allow-sensitive

**Priority:** P1
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm `DENYLIST` (env `DENYLIST` or `--deny`) patterns are enforced even when `ALLOW_SENSITIVE` suppresses built-ins.

#### Control

**OWASP:** A01
**Risk:** High

- Attack vector under test: operator allows sensitive defaults but adds an explicit deny pattern.
- Expected control: denylisted path still blocked; no override suppresses `DENYLIST`.

#### Preconditions

- Server started with `ALLOW_SENSITIVE=1` and `DENYLIST=secret.config` (or `--deny secret.config`). Allowed root has `secret.config` and `.env`.

#### Steps

1. `read {path: "<root>\.env"}`.
   - **Expected:** succeeds (built-ins suppressed by `ALLOW_SENSITIVE`).
2. `read {path: "<root>\secret.config"}`.
   - **Expected:** `ACCESS_DENIED` (denylist applies).

#### Test data

| Field    | Value           | Notes                   |
| :------- | :-------------- | :---------------------- |
| DENYLIST | `secret.config` | comma/newline separated |

#### Post-conditions

- No content leak for `secret.config`.

#### Edge cases

| Variation         | Input             | Expected                                                         |
| :---------------- | :---------------- | :--------------------------------------------------------------- |
| glob deny pattern | `DENYLIST=*.lock` | matches `x.lock` anywhere (compiled with `**/<pattern>` variant) |
| `--deny` repeated | multiple flags    | additive with env `DENYLIST`, deduped                            |

#### Related

- TC-SEC-001, TC-SEC-011, TC-INT-028

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-003: symlink escaping root denied on read

**Priority:** P1
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a symlink inside an allowed root whose realpath resolves outside the root is rejected (`validateExistingPathDetailed` realpath re-containment).

#### Control

**OWASP:** A01 / A08 (path traversal via symlink)
**Risk:** High

- Attack vector under test: `read` a symlink that points outside the sandbox.
- Expected control: `ACCESS_DENIED`; no content from the outside target.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\sym`. A symlink `<root>\escape.txt` -> `%TEMP%\fsmcp-qa\outside\secret.txt` (outside root). A symlink `<root>\inside.txt` -> `<root>\real.txt` (inside root).

#### Steps

1. `read {path: "<root>\escape.txt"}`.
   - **Expected:** `ACCESS_DENIED` (realpath escapes).
2. `read {path: "<root>\inside.txt"}`.
   - **Expected:** succeeds; returns `real.txt` content.

#### Test data

| Field      | Value           | Notes   |
| :--------- | :-------------- | :------ |
| escape.txt | symlink outside | denied  |
| inside.txt | symlink inside  | allowed |

#### Post-conditions

- No outside content returned.

#### Edge cases

| Variation     | Input                   | Expected                                    |
| :------------ | :---------------------- | :------------------------------------------ |
| symlink chain | escape via nested links | resolved; denied if terminal target outside |
| ELOOP         | cyclic symlinks         | `SYMLINK_NOT_ALLOWED` (ELOOP mapping)       |

#### Related

- TC-FUNC-001, TC-FUNC-003, TC-SEC-008

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-004: path traversal ".." rejected at schema

**Priority:** P1
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `..` segments are rejected by `RequiredPath`/`OptionalPath`/`SafeGlobPattern` schema validation before any filesystem access.

#### Control

**OWASP:** A01 / A08
**Risk:** High

- Attack vector under test: `read {path: "..\\..\\windows\\system32\\config\\SAM"}`.
- Expected control: `VALIDATION_FAILED` "Directory traversal sequences (\"..\") are forbidden".

#### Preconditions

- Any allowed root.

#### Steps

1. `read {path: "..\\..\\..\\etc\\passwd"}` (POSIX: `../../../etc/passwd`).
   - **Expected:** `VALIDATION_FAILED`.
2. `find_files {pattern: "../**"}`.
   - **Expected:** `VALIDATION_FAILED`/`INVALID_PATTERN` (isSafeGlobSyntax rejects `..`).
3. `move {moves: [{source: "..\\x", destination: "<root>\\y"}]}`.
   - **Expected:** `VALIDATION_FAILED`.

#### Test data

| Field   | Value                | Notes           |
| :------ | :------------------- | :-------------- |
| payload | `..` in path/pattern | rejected pre-fs |

#### Post-conditions

- None.

#### Edge cases

| Variation         | Input                 | Expected                    |
| :---------------- | :-------------------- | :-------------------------- |
| `..` inside brace | `pattern: "{a,..}/x"` | rejected (brace `..` regex) |
| `[..]` char class | `pattern: "[..]"`     | rejected (isSafeGlobSyntax) |

#### Related

- TC-SEC-005, TC-SEC-006, TC-SEC-007

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-005: shell metacharacters in path rejected

**Priority:** P1
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `SHELL_METACHAR_RE` (`/[\n\r;|`]/`) rejects newlines, `;`, `|`, backtick in path arguments and prompt topic/query args.

#### Control

**OWASP:** A03 (injection)
**Risk:** Medium

- Attack vector under test: path containing `;` or newline to break out of a shell context.
- Expected control: `VALIDATION_FAILED` "Path contains prohibited characters".

#### Preconditions

- Any allowed root.

#### Steps

1. `read {path: "<root>\x; rm -rf /"}`.
   - **Expected:** `VALIDATION_FAILED`.
2. `read {path: "<root>\x\ny"}`.
   - **Expected:** `VALIDATION_FAILED`.
3. Prompt `get-help {topic: "tools; rm"}`.
   - **Expected:** `VALIDATION_FAILED` (topicArg refines with `SHELL_METACHAR_RE`).

#### Test data

| Field   | Value                        | Notes        |
| :------ | :--------------------------- | :----------- |
| payload | `;`, `\|`, backtick, newline | metachar set |

#### Post-conditions

- None.

#### Edge cases

| Variation   | Input   | Expected                                                              |
| :---------- | :------ | :-------------------------------------------------------------------- |
| tab in path | `"\t"`  | accepted unless `isBlank`; whitespace-only path rejected by `isBlank` |
| backtick    | `` ` `` | rejected                                                              |

#### Related

- TC-SEC-004, TC-FUNC-029

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-006: reserved device names rejected

**Priority:** P2
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm Windows reserved device names (`CON`, `PRN`, `AUX`, `NUL`, `COM1-9`, `LPT1-9`) are rejected in any path segment (Windows surface).

#### Control

**OWASP:** A01
**Risk:** Medium

- Attack vector under test: `create {path: "<root>\\CON"}` to trigger a device.
- Expected control: `VALIDATION_FAILED`/`INVALID_INPUT` reserved-device rejection.

#### Preconditions

- Windows host, any allowed root.

#### Steps

1. `create {files: [{path: "<root>\CON", content: "x"}]}`.
   - **Expected:** validation rejection; no device touched.
2. `read {path: "<root>\sub\PRN"}`.
   - **Expected:** rejection.
3. `read {path: "<root>\COM1"}`.
   - **Expected:** rejection.

#### Test data

| Field  | Value                     | Notes                                      |
| :----- | :------------------------ | :----------------------------------------- |
| device | CON/PRN/AUX/NUL/COMn/LPTn | trailing dots/spaces stripped before check |

#### Post-conditions

- No device I/O.

#### Edge cases

| Variation     | Input        | Expected                                                  |
| :------------ | :----------- | :-------------------------------------------------------- |
| trailing dots | `CON.`       | stripped, then rejected                                   |
| with stream   | `CON:stream` | stream stripped, then rejected                            |
| POSIX         | same names   | platform-specific; reserved-name check is Windows-focused |

#### Related

- TC-SEC-007, TC-SEC-010

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-007: null byte in path rejected

**Priority:** P1
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 1
**Created:** 2026-08-22

#### Objective

Confirm a null byte in a path argument is rejected by schema validation.

#### Control

**OWASP:** A03
**Risk:** High

- Attack vector under test: `read {path: "<root>\x\0\..\..\secret"}` (null-byte truncation).
- Expected control: `VALIDATION_FAILED` "Path cannot contain null bytes".

#### Preconditions

- Any allowed root.

#### Steps

1. `read {path: "<root>\x\u0000y"}`.
   - **Expected:** `VALIDATION_FAILED` "Path cannot contain null bytes".

#### Test data

| Field   | Value         | Notes            |
| :------ | :------------ | :--------------- |
| payload | embedded `\0` | pre-fs rejection |

#### Post-conditions

- None.

#### Edge cases

| Variation              | Input              | Expected                                        |
| :--------------------- | :----------------- | :---------------------------------------------- |
| null in CLI positional | `--` arg with `\0` | `validateCliPath` rejects null bytes at startup |

#### Related

- TC-SEC-004, TC-SEC-005

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-008: symlink delete allowed (link in root, target outside)

**Priority:** P2
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `delete` of a symlink inside an allowed root succeeds even when the link target is outside the root (only the link itself is checked; `validatePathForDelete` checks link sensitivity, not target containment).

#### Control

**OWASP:** A01
**Risk:** Medium

- Attack vector under test: delete an escape symlink (clean-up, not data loss).
- Expected control: link removed; outside target untouched.

#### Preconditions

- Allowed root `%TEMP%\fsmcp-qa\sec`. `<root>\link.txt` -> `%TEMP%\fsmcp-qa\outside\target.txt`.

#### Steps

1. `delete {paths: ["<root>\link.txt"]}`.
   - **Expected:** `ok: true`; link gone; `outside\target.txt` still exists.

#### Test data

| Field    | Value          | Notes            |
| :------- | :------------- | :--------------- |
| link.txt | escape symlink | delete link only |

#### Post-conditions

- `outside\target.txt` intact.

#### Edge cases

| Variation            | Input                    | Expected                                |
| :------------------- | :----------------------- | :-------------------------------------- |
| sensitive-named link | `<root>\.env` -> outside | denied by sensitivity check (link name) |

#### Related

- TC-SEC-003, TC-FUNC-011

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-009: requestState HMAC tamper rejected

**Priority:** P1
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm a tampered or malformed `requestState` on a confirmation retry is rejected by the SDK `requestState.verify` (HMAC-SHA256 keyed with `FILESYSTEM_MCP_REQUEST_STATE_KEY`).

#### Control

**OWASP:** A01 / A07 (authentication of state)
**Risk:** High

- Attack vector under test: forge a `requestState` to confirm a destructive op without a prior `input_required`.
- Expected control: `-32602` (InvalidParams); destructive op does not run.

#### Preconditions

- As TC-FUNC-013. Key is random per boot (unset env) or a known `FILESYSTEM_MCP_REQUEST_STATE_KEY` (>=32 bytes).

#### Steps

1. `delete {paths: ["<root>\fulldir"], recursive: true, inputResponses: [{requestState: "<tampered>", content: {confirm: true}}]}` (no prior round 1).
   - **Expected:** `-32602` (verify rejects); `fulldir` unchanged.
2. Flip one byte of a real `requestState` from a prior round 1, retry.
   - **Expected:** `-32602`.

#### Test data

| Field        | Value    | Notes         |
| :----------- | :------- | :------------ |
| requestState | tampered | HMAC mismatch |

#### Post-conditions

- `fulldir` unchanged.

#### Edge cases

| Variation     | Input                                         | Expected                                               |
| :------------ | :-------------------------------------------- | :----------------------------------------------------- |
| short env key | `FILESYSTEM_MCP_REQUEST_STATE_KEY` < 32 bytes | warning logged; random key used; tamper still rejected |

#### Related

- TC-FUNC-013, TC-FUNC-014, TC-FUNC-018

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-010: Windows alternate data stream stripped

**Priority:** P3
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm the sensitive-path matcher strips Windows `:stream` ADS suffixes (and trailing dots/spaces) before matching, so `.env:secret` is treated as `.env`.

#### Control

**OWASP:** A01
**Risk:** Medium

- Attack vector under test: read `.env:stream` to bypass a `.env` match.
- Expected control: `ACCESS_DENIED` (ADS stripped, `.env` matched).

#### Preconditions

- Windows host, allowed root with `.env`. `ALLOW_SENSITIVE` unset.

#### Steps

1. `read {path: "<root>\.env:bar"}`.
   - **Expected:** `ACCESS_DENIED` (stripAlternateDataStreams -> `.env`).
2. `read {path: "<root>\file.txt.  "}` (trailing dots/spaces).
   - **Expected:** treated as `file.txt` (trailing stripped at syscall boundary); match resolved.

#### Test data

| Field   | Value                    | Notes               |
| :------ | :----------------------- | :------------------ |
| payload | `:stream`, trailing dots | Win32 normalization |

#### Post-conditions

- None.

#### Edge cases

| Variation                    | Input         | Expected                                       |
| :--------------------------- | :------------ | :--------------------------------------------- |
| drive-letter colon preserved | `C:\...\file` | first-segment colon preserved                  |
| POSIX                        | `file:stream` | no ADS stripping; `:` is a valid filename char |

#### Related

- TC-SEC-001, TC-SEC-006

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-SEC-011: --allow-sensitive suppresses built-ins only

**Priority:** P2
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `--allow-sensitive`/`ALLOW_SENSITIVE` suppresses only the built-in sensitive patterns, not `DENYLIST`, and that a per-tool override does not leak across tools.

#### Control

**OWASP:** A01
**Risk:** Medium

- Attack vector under test: operator enables `ALLOW_SENSITIVE`, expects explicit denies to still hold.
- Expected control: built-ins readable; `DENYLIST` still enforced.

#### Preconditions

- Server with `ALLOW_SENSITIVE=1`, `DENYLIST=*.lock`. Root has `.env` and `app.lock`.

#### Steps

1. `read {path: "<root>\.env"}`.
   - **Expected:** succeeds (built-in suppressed).
2. `read {path: "<root>\app.lock"}`.
   - **Expected:** `ACCESS_DENIED` (denylist still applies).

#### Test data

| Field           | Value    | Notes          |
| :-------------- | :------- | :------------- |
| ALLOW_SENSITIVE | 1        | built-ins off  |
| DENYLIST        | `*.lock` | always applies |

#### Post-conditions

- `.env` readable (deliberate).

#### Edge cases

| Variation                       | Input         | Expected            |
| :------------------------------ | :------------ | :------------------ |
| restart without ALLOW_SENSITIVE | same fixtures | `.env` denied again |

#### Related

- TC-SEC-001, TC-SEC-002

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

## Resources

### TC-INT-001: read instructions resource

**Priority:** P1
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm the static `internal://instructions` resource returns the server instructions (guidelines, tools overview, constraints, error recovery) as `text/markdown`.

#### Contract

**Systems:** client -> server (resources/read)
**Endpoint / message:** `resources/read {uri: "internal://instructions"}`

| Field    | Source                    | Expected transform                     | OK  |
| :------- | :------------------------ | :------------------------------------- | :-- |
| uri      | `internal://instructions` | contents[0].uri = same                 | [ ] |
| mimeType | text/markdown             | contents[0].mimeType = `text/markdown` | [ ] |
| text     | rendered sections         | includes "Guidelines", "Constraints"   | [ ] |

**Applicable failure paths:** missing uri -> `ResourceNotFoundError`; non-matching uri -> not found.

#### Preconditions

- Server initialized. The instructions resource is listed via `resources/list`.

#### Steps

1. `resources/list`.
   - **Expected:** includes `filesystem-mcp-instructions` with `uri: internal://instructions`, `annotations.audience: ["assistant"]`.
2. `resources/read {uri: "internal://instructions"}`.
   - **Expected:** one text entry; `text` contains "root_access", "Tools Overview", "Error Recovery".

#### Test data

| Field | Value                     | Notes  |
| :---- | :------------------------ | :----- |
| uri   | `internal://instructions` | static |

#### Post-conditions

- None.

#### Edge cases

| Variation            | Input         | Expected                                                    |
| :------------------- | :------------ | :---------------------------------------------------------- |
| `--read-only` server | same read     | Tools Overview omits the "Write" row; constraints unchanged |
| template variables   | none (static) | no completion                                               |

#### Related

- TC-INT-009, TC-INT-018

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-002: read filesystem file resource via template URI

**Priority:** P1
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm the `FILESYSTEM_FILE_URI_TEMPLATE` resource reads a file by URI (text -> `text`, binary -> `blob` base64), and that path validation mirrors the `read` tool.

#### Contract

**Systems:** client -> server (resources/read)
**Endpoint / message:** `resources/read {uri: filesystem-mcp://file/<encoded-path>}`

| Field | Source       | Expected transform        | OK  |
| :---- | :----------- | :------------------------ | :-- |
| uri   | encoded path | decoded via `extractPath` | [ ] |
| text  | utf-8 file   | contents[0].text          | [ ] |
| blob  | binary file  | contents[0].blob base64   | [ ] |

**Applicable failure paths:** out-of-root -> `ACCESS_DENIED`; missing -> `NOT_FOUND`; sensitive -> denied.

#### Preconditions

- Allowed root with `text.txt` (`hello`) and `bin.png` (small PNG).

#### Steps

1. `resources/read {uri: buildFileResourceUri("<root>\text.txt")}`.
   - **Expected:** `contents[0].mimeType: text/plain`, `text: "hello"`.
2. `resources/read {uri: buildFileResourceUri("<root>\bin.png")}`.
   - **Expected:** `contents[0].mimeType: image/png`, `blob` is base64 of the file bytes.
3. `resources/read {uri: buildFileResourceUri("<root>\missing")}`.
   - **Expected:** `ResourceNotFoundError` (validateExistingPath).

#### Test data

| Field | Value                 | Notes                     |
| :---- | :-------------------- | :------------------------ |
| uri   | encoded absolute path | percent-encoded `{+path}` |

#### Post-conditions

- None.

#### Edge cases

| Variation                | Input                | Expected                                                 |
| :----------------------- | :------------------- | :------------------------------------------------------- |
| out-of-root uri          | encoded outside path | `ACCESS_DENIED`                                          |
| sensitive uri            | `.env`               | denied (realpath re-check)                               |
| PathGuard not configured | server misconfig     | `ProtocolError InternalError` "PathGuard not configured" |

#### Related

- TC-INT-010, TC-SEC-001

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-003: read cached result resource within TTL

**Priority:** P1
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a `resourceUri` returned by a tool (e.g. `list`, `search_text`, `hash_file`, `stat`) is readable via `resources/read` within the 60-second TTL, returning the cached payload.

#### Contract

**Systems:** tool result -> ResourceStore -> resources/read
**Endpoint / message:** `resources/read {uri: filesystem-mcp://result/<id>}`

| Field | Source       | Expected transform      | OK  |
| :---- | :----------- | :---------------------- | :-- |
| id    | random UUID  | looked up in `byUri`    | [ ] |
| text  | stored entry | contents[0].text        | [ ] |
| hash  | sha256       | dedup hit refreshes TTL | [ ] |

**Applicable failure paths:** expired -> `NOT_FOUND` "expired"; missing -> `NOT_FOUND` "not found"; kind mismatch -> `NOT_FOUND`.

#### Preconditions

- Run a tool that overflows inline results, e.g. `list {path: <root>, maxEntries: 1}` capturing the returned `resourceUri`.

#### Steps

1. Capture `resourceUri` from the tool result.
2. `resources/read {uri: <resourceUri>}` within 60 s.
   - **Expected:** `contents[0]` carries the full cached payload (list JSON / matches JSON / hashes JSON / stats JSON); `mimeType: text/plain`.
3. `resources/read` the same URI again immediately.
   - **Expected:** same payload; LRU bumped.

#### Test data

| Field       | Value                            | Notes     |
| :---------- | :------------------------------- | :-------- |
| resourceUri | `filesystem-mcp://result/<uuid>` | ephemeral |

#### Post-conditions

- Cache entry persists until TTL/eviction.

#### Edge cases

| Variation                     | Input                 | Expected                                                       |
| :---------------------------- | :-------------------- | :------------------------------------------------------------- |
| same hash dedup               | re-run identical tool | `tryReturnHashHit` returns existing URI, refreshes `expiresAt` |
| not listed via resources/list | `resources/list`      | cached results are not enumerable (description: "Not listed")  |

#### Related

- TC-INT-004, TC-PERF-004

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-004: cached result after expiry

**Priority:** P1
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a cached result is unreadable after its 60-second TTL (entry removed, `NOT_FOUND` "expired. Re-run the tool").

#### Contract

**Systems:** ResourceStore -> resources/read
**Endpoint / message:** `resources/read {uri: <expired resourceUri>}`

| Field     | Source           | Expected transform         | OK  |
| :-------- | :--------------- | :------------------------- | :-- |
| isExpired | expiresAt <= now | entry removed              | [ ] |
| error     | `NOT_FOUND`      | "expired. Re-run the tool" | [ ] |

#### Preconditions

- As TC-INT-003; a `resourceUri` captured. Wait > 60 s (or lower TTL via a test build).

#### Steps

1. Wait until TTL elapses (>= 60 s).
2. `resources/read {uri: <resourceUri>}`.
   - **Expected:** `ResourceNotFoundError` "Resource expired: ... Re-run the tool to regenerate."

#### Test data

| Field | Value | Notes      |
| :---- | :---- | :--------- |
| TTL   | 60 s  | entryTtlMs |

#### Post-conditions

- Entry removed from store.

#### Edge cases

| Variation        | Input                   | Expected                           |
| :--------------- | :---------------------- | :--------------------------------- |
| missing entirely | never-minted URI        | `NOT_FOUND` "not found or expired" |
| wrong kind       | `getText` on blob entry | `NOT_FOUND` (kind mismatch)        |

#### Related

- TC-INT-003, TC-PERF-004

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-005: resources/subscribe — file change notification

**Priority:** P1
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 4
**Created:** 2026-08-22

#### Objective

Confirm `resources/subscribe` attaches a watcher and that modifying the file emits a `notifications/resources/updated` (or modern `subscriptions/listen` event) within the 50 ms debounce window.

#### Contract

**Systems:** client -> server (resources/subscribe, fs.watch, notifications/resources/updated)
**Endpoint / message:** `resources/subscribe {uri: <file uri>}`

| Field     | Source         | Expected transform        | OK  |
| :-------- | :------------- | :------------------------ | :-- |
| subscribe | uri            | `{}` ack                  | [ ] |
| change    | fs.watch event | debounced 50 ms -> notify | [ ] |

**Applicable failure paths:** cap -> `InternalError`; missing path -> `ResourceNotFoundError`.

#### Preconditions

- Allowed root with `watched.txt` (`a`). stdio transport (per-server watcher registry) for the legacy path, or HTTP modern leg (shared registry) for the per-request path.

#### Steps

1. `resources/subscribe {uri: <uri of watched.txt>}`.
   - **Expected:** `{}`.
2. Append `b` to `watched.txt`.
   - **Expected:** within ~100 ms, a `notifications/resources/updated` with the file uri arrives (debounced).
3. Repeat append rapidly.
   - **Expected:** coalesced into one notification (50 ms debounce, `unref`'d timer).

#### Test data

| Field       | Value | Notes           |
| :---------- | :---- | :-------------- |
| watched.txt | small | in allowed root |

#### Post-conditions

- Watcher persists until `unsubscribe` or shutdown.

#### Edge cases

| Variation                             | Input                    | Expected                                                  |
| :------------------------------------ | :----------------------- | :-------------------------------------------------------- |
| second subscriber same uri            | `subscribe` again        | re-registers callback; one watcher (idempotent)           |
| `fs.watch` fails (inotify exhaustion) | cap reached              | subscribe returns `false` -> `InternalError` (TC-INT-008) |
| symlinked file                        | subscribe to symlink uri | watches resolved real path                                |

#### Related

- TC-INT-006, TC-INT-007, TC-INT-008

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-006: resources/unsubscribe stops notifications

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `resources/unsubscribe` closes the watcher and stops notifications for that URI.

#### Contract

**Systems:** client -> server (resources/unsubscribe, fs.watch close)
**Endpoint / message:** `resources/unsubscribe {uri}`

| Field       | Source | Expected transform   | OK  |
| :---------- | :----- | :------------------- | :-- |
| unsubscribe | uri    | `{}`, watcher closed | [ ] |

#### Preconditions

- An active subscription from TC-INT-005.

#### Steps

1. `resources/unsubscribe {uri: <file uri>}`.
   - **Expected:** `{}`.
2. Modify the file.
   - **Expected:** no further `notifications/resources/updated`.

#### Test data

| Field | Value              | Notes         |
| :---- | :----------------- | :------------ |
| uri   | same as subscribed | canonicalized |

#### Post-conditions

- Watcher closed; callback removed.

#### Edge cases

| Variation                    | Input                         | Expected                                               |
| :--------------------------- | :---------------------------- | :----------------------------------------------------- |
| unsubscribe unknown uri      | never subscribed              | `{}` (no-op)                                           |
| unsubscribe canonicalization | trailing/encoding differences | `resourceUrlFromServerUrl` canonicalizes before lookup |

#### Related

- TC-INT-005

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-007: subscribe to unknown URI

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `resources/subscribe` on a URI that matches no contract (or a missing filesystem path) returns `ResourceNotFoundError`.

#### Contract

**Systems:** client -> server (resources/subscribe)
**Endpoint / message:** `resources/subscribe {uri: <unknown>}`

| Field      | Source | Expected transform      | OK  |
| :--------- | :----- | :---------------------- | :-- |
| foundMatch | false  | `ResourceNotFoundError` | [ ] |

#### Preconditions

- Server initialized.

#### Steps

1. `resources/subscribe {uri: "filesystem-mcp://file/<root>\missing"}`.
   - **Expected:** `ResourceNotFoundError` "Cannot subscribe ... not a filesystem URI" / path-missing variant.
2. `resources/subscribe {uri: "unrelated://x"}`.
   - **Expected:** `ResourceNotFoundError` "Resource not found".

#### Test data

| Field | Value           | Notes             |
| :---- | :-------------- | :---------------- |
| uri   | unknown/missing | no contract match |

#### Post-conditions

- No watcher attached.

#### Edge cases

| Variation      | Input  | Expected                                                                |
| :------------- | :----- | :---------------------------------------------------------------------- |
| sensitive path | `.env` | `ResourceNotFoundError` (sensitivity -> NOT_FOUND/ACCESS_DENIED mapped) |

#### Related

- TC-INT-005, TC-SEC-001

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-008: subscribe watcher cap rejects

**Priority:** P3
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm that when `MAX_WATCHERS` (`FILESYSTEM_MCP_MAX_WATCHERS`, default 256) is reached, a new `resources/subscribe` is rejected with `InternalError`.

#### Contract

**Systems:** client -> server (resources/subscribe, watcher registry cap)
**Endpoint / message:** `resources/subscribe` at cap

| Field   | Source               | Expected transform         | OK  |
| :------ | :------------------- | :------------------------- | :-- |
| isAtCap | size >= MAX_WATCHERS | `false` -> `InternalError` | [ ] |

#### Preconditions

- Server started with `FILESYSTEM_MCP_MAX_WATCHERS=2`. Create 2 distinct files and subscribe to each.

#### Steps

1. Subscribe to file A and file B (two distinct URIs) -> both `{}`.
2. Subscribe to file C (third distinct URI).
   - **Expected:** `ProtocolError InternalError` "Subscription rejected: no watcher attached (watcher limit 2 reached...)".

#### Test data

| Field        | Value | Notes            |
| :----------- | :---- | :--------------- |
| MAX_WATCHERS | 2     | low cap for test |

#### Post-conditions

- Watchers A, B still active.

#### Edge cases

| Variation                        | Input                          | Expected                                                              |
| :------------------------------- | :----------------------------- | :-------------------------------------------------------------------- |
| re-subscribe existing uri at cap | URI already watched            | `addCallback` re-registers (no new watcher) -> `{}` ack, not rejected |
| cap hit after validation await   | race where cap fills mid-await | rejected (post-await cap re-check)                                    |

#### Related

- TC-INT-005

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-009: path completion for template variable

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `resources/complete` on the `path` variable of the filesystem file template returns directory-entry suggestions scoped to allowed roots.

#### Contract

**Systems:** client -> server (resources/complete)
**Endpoint / message:** `completion/complete {ref: {uriTemplate, name: "path"}, value: "<partial>"}`

| Field       | Source        | Expected transform             | OK  |
| :---------- | :------------ | :----------------------------- | :-- |
| suggestions | PathCompleter | filtered entries under partial | [ ] |

#### Preconditions

- Allowed root with `apple.txt`, `apricot.txt`, `banana.txt`.

#### Steps

1. `completion/complete` with `value: "ap"`.
   - **Expected:** suggestions include `apple.txt`, `apricot.txt`; not `banana.txt`.
2. `completion/complete` with `value: ""`.
   - **Expected:** top-level entries of the root (or first root).

#### Test data

| Field | Value        | Notes                   |
| :---- | :----------- | :---------------------- |
| value | partial path | scoped to allowed roots |

#### Post-conditions

- None.

#### Edge cases

| Variation                  | Input                       | Expected                        |
| :------------------------- | :-------------------------- | :------------------------------ |
| partial outside root       | `../`                       | suggestions empty / scoped      |
| prompt path arg completion | `analyze-path {path: "ap"}` | PathCompleter reuses same logic |

#### Related

- TC-INT-002, TC-FUNC-022

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-010: filesystem resource binary read returns base64 blob

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm the filesystem resource returns binary content as a base64 `blob` (not `text`) for non-utf-8 files.

#### Contract

**Systems:** client -> server (resources/read)
**Endpoint / message:** `resources/read {uri: <bin file>}`

| Field    | Source                    | Expected transform | OK  |
| :------- | :------------------------ | :----------------- | :-- |
| isBinary | sniff                     | blob path taken    | [ ] |
| blob     | Buffer.toString('base64') | valid base64       | [ ] |

#### Preconditions

- Allowed root with `bin.png` (8-byte PNG header + data).

#### Steps

1. `resources/read {uri: buildFileResourceUri("<root>\bin.png")}`.
   - **Expected:** `contents[0].mimeType: image/png`, `blob` present (no `text`), base64 decodes to the original bytes.

#### Test data

| Field   | Value     | Notes  |
| :------ | :-------- | :----- |
| bin.png | small PNG | binary |

#### Post-conditions

- None.

#### Edge cases

| Variation      | Input               | Expected                                             |
| :------------- | :------------------ | :--------------------------------------------------- |
| utf-8 with BOM | `text.txt` with BOM | `text` path; BOM preserved or stripped per `readRaw` |
| empty file     | 0 bytes             | `text: ""` (utf-8 default)                           |

#### Related

- TC-INT-002, TC-FUNC-001

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

## Prompts

### TC-FUNC-019: get-help — no topic

**Priority:** P2
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `get-help` with no `topic` returns the full instructions text in a single user message.

#### Preconditions

- Server initialized.

#### Steps

1. `prompts/get {name: "get-help"}`.
   - **Expected:** `description` present; `messages` = one user message; `text` contains "Guidelines", "Tools Overview", "Constraints", "Error Recovery".

#### Test data

| Field | Value   | Notes                |
| :---- | :------ | :------------------- |
| topic | omitted | returns all sections |

#### Post-conditions

- None.

#### Edge cases

| Variation            | Input | Expected                       |
| :------------------- | :---- | :----------------------------- |
| `--read-only` server | same  | Tools Overview omits Write row |

#### Related

- TC-FUNC-020, TC-FUNC-021, TC-INT-001

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-020: get-help — valid topic filter

**Priority:** P2
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `get-help {topic}` returns only the named section (case-insensitive match against section keys).

#### Preconditions

- Server initialized.

#### Steps

1. `prompts/get {name: "get-help", arguments: {topic: "constraints"}}`.
   - **Expected:** `messages[0].content.text` contains "Constraints:" and `allowed_roots`/`enforced_limits`; omits "Error Recovery".
2. `prompts/get {name: "get-help", arguments: {topic: "TOOLS"}}` (uppercase).
   - **Expected:** matches `tools_overview` (case-insensitive); returns Tools Overview section.

#### Test data

| Field | Value       | Notes                    |
| :---- | :---------- | :----------------------- |
| topic | section key | lowercased before lookup |

#### Post-conditions

- None.

#### Edge cases

| Variation        | Input                            | Expected                                |
| :--------------- | :------------------------------- | :-------------------------------------- |
| topic completion | `completion/complete` on `topic` | returns section keys filtered by prefix |

#### Related

- TC-FUNC-019, TC-FUNC-021

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-021: get-help — unknown topic

**Priority:** P3
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 1
**Created:** 2026-08-22

#### Objective

Confirm `get-help {topic}` with a value that is not a section key returns a "Section not found. Available: ..." line followed by full instructions (debug log emitted).

#### Preconditions

- Server initialized.

#### Steps

1. `prompts/get {name: "get-help", arguments: {topic: "nonexistent"}}`.
   - **Expected:** `messages[0].content.text` starts with "Section 'nonexistent' not found. Available:"; then the full instructions.

#### Test data

| Field | Value   | Notes            |
| :---- | :------ | :--------------- |
| topic | unknown | fallback to full |

#### Post-conditions

- None.

#### Edge cases

| Variation             | Input    | Expected                                      |
| :-------------------- | :------- | :-------------------------------------------- |
| whitespace-only topic | `"   "`  | `VALIDATION_FAILED` (isBlank)                 |
| shell metachar topic  | `"a; b"` | `VALIDATION_FAILED` (TC-SEC-005, TC-FUNC-029) |

#### Related

- TC-FUNC-019, TC-FUNC-020, TC-FUNC-029

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-022: analyze-path — file

**Priority:** P2
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm `analyze-path` on a file returns a user message instructing `stat` + `read` (with `includeHash: true`), plus a resource link to the file and a link to the instructions resource.

#### Preconditions

- Allowed root with `target.txt` (`hello`). `initialize` completed (prompt `requiresInit`).

#### Steps

1. `prompts/get {name: "analyze-path", arguments: {path: "<root>\target.txt"}}`.
   - **Expected:** `messages` contains: a user text message ("Analyze this file: ...", "Call `stat`", "Call `read` (with `includeHash: true`)"); a `resource_link` to the file URI; a `resource_link` to `internal://instructions`.

#### Test data

| Field | Value         | Notes                             |
| :---- | :------------ | :-------------------------------- |
| path  | existing file | resolved via validateExistingPath |

#### Post-conditions

- None.

#### Edge cases

| Variation        | Input                           | Expected                                                     |
| :--------------- | :------------------------------ | :----------------------------------------------------------- |
| path completion  | `completion/complete` on `path` | PathCompleter suggestions (TC-INT-009)                       |
| nonexistent path | `path: "<root>\nope"`           | `ProtocolError InvalidRequest` (validateExistingPath throws) |

#### Related

- TC-FUNC-024, TC-FUNC-029, TC-INT-001

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-023: analyze-path — directory

**Priority:** P2
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `analyze-path` on a directory returns a user message instructing `list` (maxDepth: 3) and the resource links.

#### Preconditions

- Allowed root with `dir/`.

#### Steps

1. `prompts/get {name: "analyze-path", arguments: {path: "<root>\dir"}}`.
   - **Expected:** text message says "Analyze this directory: ...", "Call `list` (maxDepth: 3)"; resource link to the dir and to instructions.

#### Test data

| Field | Value              | Notes                     |
| :---- | :----------------- | :------------------------ |
| path  | existing directory | validateExistingDirectory |

#### Post-conditions

- None.

#### Edge cases

| Variation       | Input                       | Expected                  |
| :-------------- | :-------------------------- | :------------------------ |
| path is a file  | `path: "<root>\target.txt"` | file branch (TC-FUNC-022) |
| nonexistent dir | missing                     | `InvalidRequest`          |

#### Related

- TC-FUNC-022

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-024: analyze-path — before init

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 1
**Created:** 2026-08-22

#### Objective

Confirm `analyze-path` (and `find-in-tree`, `summarize-directory`) called before `notifications/initialized` returns `ProtocolError InvalidRequest` "Prompt ... called before roots are initialized".

#### Preconditions

- Connection open, `initialize` sent but `notifications/initialized` not yet sent (synchronizer in `initializing`).

#### Steps

1. `prompts/get {name: "analyze-path", arguments: {path: "<root>\x"}}` before init.
   - **Expected:** `InvalidRequest` "Prompt analyze-path called before roots are initialized".

#### Test data

| Field | Value        | Notes                      |
| :---- | :----------- | :------------------------- |
| state | initializing | requiresInit prompts gated |

#### Post-conditions

- None.

#### Edge cases

| Variation              | Input | Expected                         |
| :--------------------- | :---- | :------------------------------- |
| `get-help` before init | same  | succeeds (`requiresInit: false`) |

#### Related

- TC-INT-031, TC-FUNC-022

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-025: find-in-tree — modes (name, content, both)

**Priority:** P2
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm `find-in-tree` emits the right tool-call instructions per `mode`: `name` -> `find_files`, `content` -> `search_text`, `both` -> both.

#### Preconditions

- Allowed root with files containing a known term.

#### Steps

1. `prompts/get {name: "find-in-tree", arguments: {query: "TODO", mode: "name"}}`.
   - **Expected:** text message instructs only `find_files` with pattern `TODO`.
2. `prompts/get {..., arguments: {query: "TODO", mode: "content"}}`.
   - **Expected:** instructs only `search_text` with pattern `TODO`, including relative paths/line numbers/1-line context.
3. `prompts/get {..., arguments: {query: "TODO", mode: "both"}}`.
   - **Expected:** instructs both `find_files` and `search_text`.

#### Test data

| Field | Value       | Notes                         |
| :---- | :---------- | :---------------------------- |
| mode  | name        | content                       | both | default both |
| query | glob or RE2 | non-empty, no shell metachars |

#### Post-conditions

- None.

#### Edge cases

| Variation                         | Input                | Expected                               |
| :-------------------------------- | :------------------- | :------------------------------------- |
| explicit root                     | `root: "<root>\sub"` | resolved via validateExistingDirectory |
| omitted root, single allowed root | no `root`            | uses first allowed dir                 |
| mode default omitted              | no `mode`            | defaults to `both`                     |

#### Related

- TC-FUNC-026, TC-FUNC-029

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-026: find-in-tree — no root and no allowed dirs

**Priority:** P2
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `find-in-tree` with no `root` and no allowed directories returns `ProtocolError InvalidRequest` "find-in-tree: no root provided and no allowed directories".

#### Preconditions

- Server with zero allowed roots (no CLI, no env, no MCP roots, no `--allow-cwd`).

#### Steps

1. `prompts/get {name: "find-in-tree", arguments: {query: "x"}}`.
   - **Expected:** `InvalidRequest` "find-in-tree: no root provided and no allowed directories".

#### Test data

| Field   | Value | Notes       |
| :------ | :---- | :---------- |
| allowed | none  | empty roots |

#### Post-conditions

- None.

#### Edge cases

| Variation              | Input                    | Expected                                            |
| :--------------------- | :----------------------- | :-------------------------------------------------- |
| root given but missing | `root: "<root>\missing"` | `InvalidRequest` (validateExistingDirectory throws) |

#### Related

- TC-FUNC-025, TC-FUNC-012

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-027: summarize-directory — depth, manifests

**Priority:** P2
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm `summarize-directory` instructs `list` with the given `depth` and `read` of top-level manifests (README.md, package.json, Cargo.toml, etc.), and that `depth` coerces and clamps 1–6.

#### Preconditions

- Allowed root holding a project dir with `package.json` and `README.md`.

#### Steps

1. `prompts/get {name: "summarize-directory", arguments: {path: "<root>\proj", depth: 4}}`.
   - **Expected:** text instructs `list` with `maxDepth=4`; `read` of `README.md`, `package.json`, `Cargo.toml`, `pyproject.toml`, `go.mod`, `build.gradle`, `pom.xml`, `Dockerfile`; resource link to the dir.
2. `prompts/get {..., arguments: {path: "<root>\proj"}}` (depth omitted).
   - **Expected:** `depth` defaults to 3.

#### Test data

| Field | Value | Notes                                   |
| :---- | :---- | :-------------------------------------- |
| depth | 1–6   | z.coerce.number().pipe(int32 min1 max6) |

#### Post-conditions

- None.

#### Edge cases

| Variation       | Input      | Expected                                       |
| :-------------- | :--------- | :--------------------------------------------- |
| depth: 0        | `depth: 0` | coerced; min(1) rejects -> `VALIDATION_FAILED` |
| depth: 7        | `depth: 7` | max(6) rejects -> `VALIDATION_FAILED`          |
| depth as string | `"4"`      | coerced to 4                                   |

#### Related

- TC-FUNC-028, TC-FUNC-002

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-028: summarize-directory — non-dir

**Priority:** P3
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 1
**Created:** 2026-08-22

#### Objective

Confirm `summarize-directory` on a file path returns `ProtocolError InvalidRequest` (`validateExistingDirectory` throws `NOT_DIRECTORY`).

#### Preconditions

- Allowed root with `file.txt`.

#### Steps

1. `prompts/get {name: "summarize-directory", arguments: {path: "<root>\file.txt"}}`.
   - **Expected:** `InvalidRequest` (wrapped `NOT_DIRECTORY`).

#### Test data

| Field | Value  | Notes           |
| :---- | :----- | :-------------- |
| path  | a file | not a directory |

#### Post-conditions

- None.

#### Edge cases

| Variation   | Input        | Expected                     |
| :---------- | :----------- | :--------------------------- |
| nonexistent | missing path | `InvalidRequest` (NOT_FOUND) |

#### Related

- TC-FUNC-027, TC-FUNC-024

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-FUNC-029: prompt arg — shell metacharacter and traversal validation

**Priority:** P1
**Type:** Functional
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm prompt path/topic/query args reject shell metacharacters (`SHELL_METACHAR_RE`) and traversal (`..`), and that the `pathArg` completable still works.

#### Preconditions

- Allowed root.

#### Steps

1. `prompts/get {name: "analyze-path", arguments: {path: "<root>\x; rm"}}`.
   - **Expected:** `VALIDATION_FAILED` "Path contains prohibited characters".
2. `prompts/get {name: "find-in-tree", arguments: {query: "a; b"}}`.
   - **Expected:** `VALIDATION_FAILED` "Query contains prohibited characters".
3. `prompts/get {name: "analyze-path", arguments: {path: "..\\..\\x"}}`.
   - **Expected:** `VALIDATION_FAILED` (RequiredPath rejects `..`).

#### Test data

| Field   | Value            | Notes         |
| :------ | :--------------- | :------------ |
| payload | metachars / `..` | shared schema |

#### Post-conditions

- None.

#### Edge cases

| Variation   | Input         | Expected                                                       |
| :---------- | :------------ | :------------------------------------------------------------- |
| empty query | `query: "  "` | `VALIDATION_FAILED` "Query cannot be empty or whitespace-only" |
| empty topic | `topic: "  "` | `VALIDATION_FAILED` (isBlank)                                  |

#### Related

- TC-SEC-004, TC-SEC-005, TC-FUNC-021

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

## Transport, CLI, and HTTP security

### TC-INT-011: stdio initialize handshake

**Priority:** P0
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a stdio `initialize` completes, roots are negotiated, and `notifications/initialized` moves the synchronizer to `idle` (tools usable).

#### Contract

**Systems:** client -> server (stdio JSON-RPC)
**Endpoint / message:** `initialize`, `notifications/initialized`, optional `roots/list`

| Field           | Source              | Expected transform                               | OK  |
| :-------------- | :------------------ | :----------------------------------------------- | :-- |
| protocolVersion | negotiate           | agreed version                                   | [ ] |
| capabilities    | server advertises   | resources.subscribe, tools, prompts, completions | [ ] |
| state           | initialized -> idle | tools callable                                   | [ ] |

#### Preconditions

- Server started stdio with one allowed root.

#### Steps

1. Send `initialize` with `roots` capability.
   - **Expected:** `result` with `protocolVersion`, `capabilities`, `serverInfo`; `instructions` string present.
2. Send `notifications/initialized`.
   - **Expected:** synchronizer -> `idle`; roots fetched via `roots/list` if client advertises roots.
3. Call `list_roots`.
   - **Expected:** roots resolved.

#### Test data

| Field     | Value | Notes              |
| :-------- | :---- | :----------------- |
| transport | stdio | legacy `serve` era |

#### Post-conditions

- Connection usable.

#### Edge cases

| Variation             | Input                                                  | Expected                                           |
| :-------------------- | :----------------------------------------------------- | :------------------------------------------------- |
| no `roots` capability | omit                                                   | rootDirectories cleared; CLI/env roots still apply |
| handshake timeout     | no `initialized` within `FS_INIT_HANDSHAKE_TIMEOUT_MS` | warning logged; `FS_INIT_TIMEOUT_CLOSE` may close  |

#### Related

- TC-INT-012, TC-INT-031, TC-INT-033

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-012: HTTP initialize + session id

**Priority:** P1
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm `POST /mcp` `initialize` opens a session and returns `mcp-session-id`; subsequent requests carry it; GET/DELETE manage the session.

#### Contract

**Systems:** client -> HTTP server
**Endpoint / message:** `POST /mcp` (initialize), `Mcp-Session-Id` header

| Field      | Source        | Expected transform                          | OK  |
| :--------- | :------------ | :------------------------------------------ | :-- |
| session id | random UUID   | returned in header                          | [ ] |
| era        | legacy/modern | sessionful (legacy) or per-request (modern) | [ ] |

#### Preconditions

- Server started with `--port <p>`.

#### Steps

1. `POST /mcp` with `initialize`.
   - **Expected:** 200, `Mcp-Session-Id` header set (printable, <=256 chars).
2. `POST /mcp` with the session id, `tools/call list_roots`.
   - **Expected:** 200, result present.
3. `DELETE /mcp` with session id.
   - **Expected:** 200/202; session closed.

#### Test data

| Field | Value     | Notes           |
| :---- | :-------- | :-------------- |
| port  | free port | Streamable HTTP |

#### Post-conditions

- Session removed after DELETE.

#### Edge cases

| Variation               | Input                                | Expected                                     |
| :---------------------- | :----------------------------------- | :------------------------------------------- |
| missing session on POST | no `Mcp-Session-Id` (non-initialize) | 400 `InvalidRequest`                         |
| unknown session         | stale id                             | 404 `Session not found`                      |
| GET without id          | `GET /mcp` no header                 | 400 "Missing session ID"                     |
| `app.all /mcp`          | PUT/PATCH                            | 405 with `Allow: GET, POST, DELETE, OPTIONS` |
| invalid session id      | whitespace/control chars             | rejected by `isValidSessionId`               |

#### Related

- TC-INT-013, TC-INT-014, TC-INT-015

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-013: HTTP session idle timeout eviction

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm an idle HTTP session is evicted after `FILESYSTEM_MCP_SESSION_IDLE_TIMEOUT_MS` (default 30 min; lower it for the test) when `activeRequests === 0`.

#### Contract

**Systems:** HttpSessionRegistry sweep -> session close
**Endpoint / message:** background sweep timer

| Field  | Source                       | Expected transform | OK  |
| :----- | :--------------------------- | :----------------- | :-- |
| idle   | now - lastActiveAt > timeout | session closed     | [ ] |
| reason | evictionReason               | "idle"             | [ ] |

#### Preconditions

- Server with `FILESYSTEM_MCP_SESSION_IDLE_TIMEOUT_MS=2000`. Open a session and leave it idle.

#### Steps

1. `initialize` -> session id; do not send further requests.
2. Wait > 2 s.
3. `POST /mcp` with the stale id.
   - **Expected:** 404 `Session not found` (evicted).

#### Test data

| Field        | Value   | Notes            |
| :----------- | :------ | :--------------- |
| idle timeout | 2000 ms | lowered for test |

#### Post-conditions

- Session closed.

#### Edge cases

| Variation         | Input                                                  | Expected                            |
| :---------------- | :----------------------------------------------------- | :---------------------------------- |
| handshake timeout | `!isInitialized()` past `FS_INIT_HANDSHAKE_TIMEOUT_MS` | evicted with reason "handshake"     |
| active request    | in-flight `tools/call` during sweep                    | `activeRequests > 0` -> not evicted |

#### Related

- TC-INT-012, TC-INT-014

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-014: HTTP max sessions -> 503 Retry-After

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a new `initialize` is rejected with 503 and `Retry-After: 60` once `FILESYSTEM_MCP_MAX_HTTP_SESSIONS` is reached.

#### Contract

**Systems:** client -> HTTP server
**Endpoint / message:** `POST /mcp` initialize at cap

| Field       | Source               | Expected transform | OK  |
| :---------- | :------------------- | :----------------- | :-- |
| size        | registry.size >= max | 503                | [ ] |
| Retry-After | 60                   | header set         | [ ] |

#### Preconditions

- Server with `FILESYSTEM_MCP_MAX_HTTP_SESSIONS=1`. Open one session.

#### Steps

1. `initialize` -> session A (cap reached).
2. Second `initialize`.
   - **Expected:** 503, `Retry-After: 60`, JSON-RPC `InternalError`.

#### Test data

| Field        | Value | Notes   |
| :----------- | :---- | :------ |
| max sessions | 1     | low cap |

#### Post-conditions

- Session A intact.

#### Edge cases

| Variation                                | Input                    | Expected                       |
| :--------------------------------------- | :----------------------- | :----------------------------- |
| response/notification on missing session | stale id, non-initialize | 400 `InvalidRequest` (not 503) |

#### Related

- TC-INT-012

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-015: HTTP oversized body -> 413

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm a `POST /mcp` body exceeding `FS_CONTEXT_MAX_REQUEST_BYTES` (default 4 MiB) returns 413 mapped to JSON-RPC `InvalidRequest`.

#### Contract

**Systems:** client -> Express json limit
**Endpoint / message:** `POST /mcp` oversized

| Field     | Source                 | Expected transform | OK  |
| :-------- | :--------------------- | :----------------- | :-- |
| jsonLimit | MAX_REQUEST_BODY_BYTES | 413 on exceed      | [ ] |

#### Preconditions

- Server default body limit.

#### Steps

1. `POST /mcp` with a JSON body > 4 MiB.
   - **Expected:** 413, JSON-RPC error `InvalidRequest`.

#### Test data

| Field | Value | Notes        |
| :---- | :---- | :----------- |
| body  | 5 MiB | over default |

#### Post-conditions

- None.

#### Edge cases

| Variation    | Input                               | Expected             |
| :----------- | :---------------------------------- | :------------------- |
| custom limit | `FS_CONTEXT_MAX_REQUEST_BYTES=1024` | 413 on larger bodies |

#### Related

- TC-INT-012

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-016: GET /healthz — 200 ok

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 1
**Created:** 2026-08-22

#### Objective

Confirm `GET /healthz` returns 200 with `status: ok`, uptime, and session count while running.

#### Preconditions

- HTTP server running.

#### Steps

1. `GET /healthz`.
   - **Expected:** 200, JSON `{status: "ok", uptime, sessions}`.

#### Test data

| Field | Value      | Notes    |
| :---- | :--------- | :------- |
| path  | `/healthz` | unauthed |

#### Post-conditions

- None.

#### Edge cases

| Variation       | Input         | Expected                                     |
| :-------------- | :------------ | :------------------------------------------- |
| during shutdown | after SIGTERM | 503 `{status: "shutting_down"}` (TC-INT-017) |

#### Related

- TC-INT-017

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-017: /healthz 503 during shutdown

**Priority:** P3
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `GET /healthz` returns 503 `status: shutting_down` after the server begins shutdown (SIGTERM/SIGINT), and that the shared watcher registry + sessions are torn down.

#### Preconditions

- HTTP server running with at least one session.

#### Steps

1. Send SIGTERM (or `Ctrl+C`) to the server.
2. Immediately `GET /healthz`.
   - **Expected:** 503 `{status: "shutting_down", ...}`.
3. After shutdown completes, `GET /healthz`.
   - **Expected:** connection refused (server closed).

#### Test data

| Field  | Value          | Notes                   |
| :----- | :------------- | :---------------------- |
| signal | SIGTERM/SIGINT | SHUTDOWN_TIMEOUT_MS 5 s |

#### Post-conditions

- Server stopped; watchers destroyed; sessions closed.

#### Edge cases

| Variation          | Input                               | Expected                         |
| :----------------- | :---------------------------------- | :------------------------------- |
| in-flight requests | active `tools/call` during shutdown | allowed to finish within timeout |

#### Related

- TC-INT-016, TC-INT-005

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-018: --read-only hides mutating tools

**Priority:** P1
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `--read-only` (or `--safe`) registers only the 7 read-only tools and excludes the 5 mutating ones from `tools/list`; the instructions resource's Tools Overview omits the Write row.

#### Preconditions

- Server started with `--read-only`.

#### Steps

1. `tools/list`.
   - **Expected:** includes `hash_file`, `list`, `read`, `list_roots`, `search_text`, `find_files`, `stat`; excludes `create`, `delete`, `edit`, `move`, `replace_text`.
2. `resources/read {uri: internal://instructions}`.
   - **Expected:** Tools Overview has Navigate/Inspect/Read rows only.
3. Call `create` (absent tool).
   - **Expected:** method-not-found / `INVALID_INPUT` per `enforceStrictCapabilities`.

#### Test data

| Field | Value         | Notes          |
| :---- | :------------ | :------------- |
| flag  | `--read-only` | `--safe` alias |

#### Post-conditions

- None.

#### Edge cases

| Variation      | Input    | Expected      |
| :------------- | :------- | :------------ |
| `--safe` alias | `--safe` | same behavior |

#### Related

- SMOKE-002, TC-FUNC-007, TC-FUNC-011, TC-INT-001

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-019: API_KEY missing/invalid bearer -> 401

**Priority:** P1
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm that with `API_KEY` set, a request without or with an invalid bearer token is rejected with 401 and a `WWW-Authenticate: Bearer` challenge.

#### Control

**OWASP:** A01 / A07
**Risk:** High

- Attack vector under test: unauthenticated HTTP request to `/mcp`.
- Expected control: 401; no JSON-RPC processing; `WWW-Authenticate` header set.

#### Preconditions

- Server started with `--port <p> --api-key <16+ char key>` (loopback so bind is allowed).

#### Steps

1. `POST /mcp` with no `Authorization` header.
   - **Expected:** 401, `WWW-Authenticate: Bearer`, body JSON-RPC error code -32000 "Unauthorized".
2. `POST /mcp` with `Authorization: Bearer wrongtoken`.
   - **Expected:** 401, `WWW-Authenticate: Bearer error="invalid_token"`.
3. `POST /mcp` with the correct bearer.
   - **Expected:** passes auth (TC-INT-020).

#### Test data

| Field   | Value      | Notes                     |
| :------ | :--------- | :------------------------ |
| API_KEY | >=16 chars | timingSafeEqual on sha256 |

#### Post-conditions

- No session opened on 401.

#### Edge cases

| Variation                      | Input        | Expected                                            |
| :----------------------------- | :----------- | :-------------------------------------------------- |
| oversized token                | > 4096 chars | rejected before compare                             |
| API_KEY < 16 chars on loopback | short key    | startup `PERMISSION_DENIED` (insecure) (TC-INT-023) |

#### Related

- TC-INT-020, TC-INT-023, TC-INT-025

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-020: API_KEY valid bearer passes; cacheScope private

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm a valid bearer token passes the auth middleware and that `tools/list`/`prompts/list` responses carry `cacheScope: private` when `API_KEY` is set.

#### Contract

**Systems:** client -> bearerAuthMiddleware -> handler
**Endpoint / message:** `POST /mcp` with valid bearer

| Field      | Source      | Expected transform | OK  |
| :--------- | :---------- | :----------------- | :-- |
| token      | valid       | next()             | [ ] |
| cacheScope | API_KEY set | `private`          | [ ] |

#### Preconditions

- As TC-INT-019.

#### Steps

1. `POST /mcp` `tools/list` with the correct bearer.
   - **Expected:** 200, tools listed; response cache hint `cacheScope: private`.

#### Test data

| Field  | Value   | Notes                  |
| :----- | :------ | :--------------------- |
| bearer | correct | sha256 timingSafeEqual |

#### Post-conditions

- None.

#### Edge cases

| Variation      | Input | Expected                      |
| :------------- | :---- | :---------------------------- |
| no API_KEY set | unset | no auth; `cacheScope: public` |

#### Related

- TC-INT-019, TC-INT-021

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-021: CORS preflight OPTIONS /mcp -> 204

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `OPTIONS /mcp` returns 204 with reflected `Access-Control-Allow-Origin` (localhost or `FILESYSTEM_MCP_ALLOWED_ORIGINS`) and the required `Access-Control-Allow-Headers`/`Methods`, and that preflight is not rate-limited.

#### Contract

**Systems:** browser -> HTTP server (CORS preflight)
**Endpoint / message:** `OPTIONS /mcp`

| Field   | Source  | Expected transform                                                | OK  |
| :------ | :------ | :---------------------------------------------------------------- | :-- |
| origin  | allowed | reflected                                                         | [ ] |
| methods | fixed   | GET, POST, DELETE, OPTIONS                                        | [ ] |
| headers | fixed   | Content-Type, Authorization, mcp-session-id, mcp-protocol-version | [ ] |

#### Preconditions

- Server with HTTP transport.

#### Steps

1. `OPTIONS /mcp` with `Origin: http://localhost:5173`.
   - **Expected:** 204; `Access-Control-Allow-Origin` reflected; `Access-Control-Allow-Methods` set.
2. `OPTIONS /mcp` with `Origin: https://evil.example`.
   - **Expected:** 204; no `Access-Control-Allow-Origin` (not in allowlist).

#### Test data

| Field  | Value     | Notes              |
| :----- | :-------- | :----------------- |
| origin | localhost | allowed by default |

#### Post-conditions

- None.

#### Edge cases

| Variation      | Input                                        | Expected              |
| :------------- | :------------------------------------------- | :-------------------- |
| custom origins | `FILESYSTEM_MCP_ALLOWED_ORIGINS=app.example` | that origin reflected |

#### Related

- TC-INT-019, TC-INT-022

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-022: rate limit exceeded -> 429 Retry-After

**Priority:** P3
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm the per-client-IP rate limiter (mounted only when `API_KEY` is set) returns 429 with `Retry-After` over `FILESYSTEM_MCP_RATE_LIMIT_RPM` (default 120) requests/min.

#### Control

**OWASP:** A04 (abuse)
**Risk:** Low

- Attack vector under test: flood `/mcp` with requests.
- Expected control: 429 after the per-minute cap; `Retry-After` set.

#### Preconditions

- Server with `API_KEY` set and `FILESYSTEM_MCP_RATE_LIMIT_RPM=5`. OPTIONS excluded from limiting.

#### Steps

1. Send 6 authenticated `POST /mcp` `tools/list` rapidly from one IP.
   - **Expected:** the 6th returns 429 with `Retry-After` >= 1, body code -32000 "Rate limit exceeded".

#### Test data

| Field | Value | Notes   |
| :---- | :---- | :------ |
| RPM   | 5     | low cap |

#### Post-conditions

- Bucket swept after 60 s (drops > 120 s old).

#### Edge cases

| Variation  | Input     | Expected                         |
| :--------- | :-------- | :------------------------------- |
| no API_KEY | unset     | rate limiter not mounted; no 429 |
| OPTIONS    | preflight | not counted                      |

#### Related

- TC-INT-019, TC-INT-020

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-023: non-loopback bind without secure key -> startup reject

**Priority:** P1
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `assertHttpBindingPolicy` rejects a non-loopback `--http-host` without a secure (>=16 char) `API_KEY`, and a loopback bind with an insecure key.

#### Control

**OWASP:** A05 (misconfiguration)
**Risk:** High

- Attack vector under test: bind 0.0.0.0 with no/weak auth.
- Expected control: startup `PERMISSION_DENIED`; server refuses to start.

#### Preconditions

- Hostname resolvable to a non-loopback address (use `--http-host 0.0.0.0` or LAN IP).

#### Steps

1. Start with `--http-host 0.0.0.0` and no `--api-key`.
   - **Expected:** startup `PERMISSION_DENIED` (non-loopback requires secure key).
2. Start with `--http-host 127.0.0.1 --api-key short` (<16 chars).
   - **Expected:** startup `PERMISSION_DENIED` (insecure key).

#### Test data

| Field | Value        | Notes            |
| :---- | :----------- | :--------------- |
| host  | non-loopback | needs secure key |

#### Post-conditions

- Server does not start.

#### Edge cases

| Variation             | Input                     | Expected |
| :-------------------- | :------------------------ | :------- |
| loopback + secure key | `127.0.0.1` + 16-char key | starts   |

#### Related

- TC-INT-019, TC-INT-024

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-024: wildcard host without allowed_hosts/unrestricted -> reject

**Priority:** P2
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `assertHttpHostPolicy` rejects a wildcard bind (`0.0.0.0`/`::`) unless `FILESYSTEM_MCP_ALLOWED_HOSTS` is set or `FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1`.

#### Control

**OWASP:** A05
**Risk:** Medium

- Attack vector under test: Host header spoofing on a wildcard bind.
- Expected control: startup reject unless hosts are pinned or unrestricted is explicitly enabled.

#### Preconditions

- Secure `API_KEY` set (to pass binding policy first).

#### Steps

1. Start with `--http-host 0.0.0.0`, secure key, no `ALLOWED_HOSTS`.
   - **Expected:** reject.
2. Start with `--http-host 0.0.0.0`, secure key, `FILESYSTEM_MCP_ALLOWED_HOSTS=myhost`.
   - **Expected:** starts; Host header validated against `myhost`.
3. Start with `--http-host 0.0.0.0`, secure key, `FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS=1`.
   - **Expected:** starts; `protectedResourceUrl` returns null (refuses to publish attacker-controlled identifier).

#### Test data

| Field | Value    | Notes               |
| :---- | :------- | :------------------ |
| host  | wildcard | needs allowed_hosts |

#### Post-conditions

- Server starts or rejects per step.

#### Edge cases

| Variation             | Input       | Expected                           |
| :-------------------- | :---------- | :--------------------------------- |
| loopback bind         | `127.0.0.1` | no Host validation needed          |
| concrete non-loopback | LAN IP      | allowed; Host validated against it |

#### Related

- TC-INT-023, TC-INT-025

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-025: discovery /.well-known/oauth-protected-resource

**Priority:** P3
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm the RFC 9728 discovery endpoint is mounted only when `API_KEY` is set, returns resource metadata, and 400s when the resource URL cannot be derived and no `FILESYSTEM_MCP_PUBLIC_URL` is set.

#### Contract

**Systems:** client -> HTTP server
**Endpoint / message:** `GET /.well-known/oauth-protected-resource` (and `/mcp`-suffixed)

| Field          | Source             | Expected transform   | OK  |
| :------------- | :----------------- | :------------------- | :-- |
| resource       | Host or PUBLIC_URL | `http(s)://host/mcp` | [ ] |
| bearer_methods | fixed              | `["header"]`         | [ ] |
| resource_name  | fixed              | `filesystem-mcp`     | [ ] |

#### Preconditions

- Server with `API_KEY` set and a valid Host.

#### Steps

1. `GET /.well-known/oauth-protected-resource` with valid Host.
   - **Expected:** 200, JSON with `resource`, `bearer_methods_supported: ["header"]`, `resource_name`, `Access-Control-Allow-Origin: *`.
2. `GET /.well-known/oauth-protected-resource/mcp`.
   - **Expected:** same body.
3. Without `API_KEY` set, `GET /.well-known/oauth-protected-resource`.
   - **Expected:** 404 (endpoint not mounted).

#### Test data

| Field      | Value    | Notes                      |
| :--------- | :------- | :------------------------- |
| PUBLIC_URL | optional | overrides Host-derived URL |

#### Post-conditions

- None.

#### Edge cases

| Variation                         | Input                   | Expected                                            |
| :-------------------------------- | :---------------------- | :-------------------------------------------------- |
| unrestricted hosts, no PUBLIC_URL | wildcard + unrestricted | `protectedResourceUrl` null -> 400 `InvalidRequest` |
| unparseable PUBLIC_URL            | malformed URL           | warn + fallback to Host URL                         |

#### Related

- TC-INT-019, TC-INT-024

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-026: --allow-cwd adds cwd root

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `--allow-cwd` adds the current working directory as an allowed root (unless CWD is unsafe: filesystem root, home dir, or hardcoded system dirs).

#### Preconditions

- Start server from a project subdirectory that is not unsafe.

#### Steps

1. Start with `--allow-cwd` and no other roots.
   - **Expected:** `list_roots` returns CWD.
2. Start with `--allow-cwd` from `C:\Windows` (unsafe).
   - **Expected:** CWD skipped; warning logged; `roots: []` (unless other roots).

#### Test data

| Field       | Value                                 | Notes   |
| :---------- | :------------------------------------ | :------ |
| unsafe dirs | Windows, Program Files, home, FS root | skipped |

#### Post-conditions

- None.

#### Edge cases

| Variation    | Input | Expected                                                     |
| :----------- | :---- | :----------------------------------------------------------- |
| `--walk-cwd` | set   | walks up to project root; implies `--allow-cwd` (TC-INT-027) |

#### Related

- TC-FUNC-012, TC-INT-027

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-027: --walk-cwd finds project root

**Priority:** P3
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `--walk-cwd` (`ALLOW_CWD_WALK`) walks up from CWD to the nearest directory containing a project marker (`.git`/`package.json`/`pyproject.toml`) within max depth 32 and adds it as a root.

#### Preconditions

- Start from a subdirectory of a project that has a marker at its root.

#### Steps

1. Start with `--walk-cwd` from `<proj>\src\deep`.
   - **Expected:** `list_roots` returns `<proj>` (where the marker lives).

#### Test data

| Field   | Value                                    | Notes       |
| :------ | :--------------------------------------- | :---------- |
| markers | `.git`, `package.json`, `pyproject.toml` | first found |

#### Post-conditions

- None.

#### Edge cases

| Variation                  | Input                   | Expected                             |
| :------------------------- | :---------------------- | :----------------------------------- |
| no marker within 32 levels | deep dir                | walks to depth 32, falls back to CWD |
| marker at unsafe path      | project root under home | skipped if unsafe                    |

#### Related

- TC-INT-026

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-028: --deny / DENYLIST blocks path

**Priority:** P2
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `--deny` (repeatable, additive with `DENYLIST` env) blocks matching paths on read/stat/list, with `**/<pattern>` variant matching at any depth.

#### Control

**OWASP:** A01
**Risk:** Medium

- Attack vector under test: read a denylisted file inside an otherwise-allowed root.
- Expected control: `ACCESS_DENIED`.

#### Preconditions

- Server with `--deny *.log` and allowed root containing `app.log`, `sub/debug.log`.

#### Steps

1. `read {path: "<root>\app.log"}`.
   - **Expected:** `ACCESS_DENIED`.
2. `read {path: "<root>\sub\debug.log"}`.
   - **Expected:** `ACCESS_DENIED` (glob variant matches at depth).
3. `read {path: "<root>\app.txt"}`.
   - **Expected:** succeeds (not matched).

#### Test data

| Field | Value   | Notes                            |
| :---- | :------ | :------------------------------- |
| deny  | `*.log` | compiled with `**/*.log` variant |

#### Post-conditions

- None.

#### Edge cases

| Variation           | Input                             | Expected            |
| :------------------ | :-------------------------------- | :------------------ |
| env + flag both set | `DENYLIST=*.env` + `--deny *.log` | both apply, deduped |

#### Related

- TC-SEC-002, TC-SEC-011

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-029: --root-boundary restricts granted roots

**Priority:** P2
**Type:** Security
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `--root-boundary` (`ROOT_BOUNDARY`) confines all allowed roots (CLI, env, MCP, grants) to live under the boundary, realpath-resolved.

#### Control

**OWASP:** A01
**Risk:** Medium

- Attack vector under test: client offers an MCP root outside the boundary.
- Expected control: root filtered out; grant outside boundary skipped.

#### Preconditions

- `ROOT_BOUNDARY=%TEMP%\fsmcp-qa`. Roots offered: one inside, one outside.

#### Steps

1. `list_roots` after negotiation.
   - **Expected:** only the root inside the boundary listed.
2. Attempt a grant (TC-FUNC-017) to a dir outside the boundary.
   - **Expected:** grant skipped (re-check `isWithinBoundary`).

#### Test data

| Field    | Value             | Notes          |
| :------- | :---------------- | :------------- |
| boundary | realpath-resolved | at config time |

#### Post-conditions

- None.

#### Edge cases

| Variation                                 | Input | Expected                                     |
| :---------------------------------------- | :---- | :------------------------------------------- |
| baseline roots (CLI/env) outside boundary | mixed | filtered with `requireRequestedInside=false` |

#### Related

- TC-FUNC-017, TC-FUNC-012

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-030: --allow-missing-roots starts with missing dir

**Priority:** P3
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `--allow-missing-roots` (`ALLOW_MISSING_ROOTS`) keeps a configured allowed dir that does not exist (normalized path) instead of warning/dropping it.

#### Preconditions

- A CLI positional pointing to a nonexistent dir.

#### Steps

1. Start without `--allow-missing-roots`, positional `%TEMP%\fsmcp-qa\nope`.
   - **Expected:** warning logged; root dropped (or kept-with-warning per impl).
2. Start with `--allow-missing-roots`, same positional.
   - **Expected:** no warning; `list_roots` includes the normalized missing path; `list` on it later returns `NOT_DIRECTORY`/`NOT_FOUND`.

#### Test data

| Field       | Value       | Notes                |
| :---------- | :---------- | :------------------- |
| missing dir | nonexistent | normalized path kept |

#### Post-conditions

- None.

#### Edge cases

| Variation         | Input             | Expected                   |
| :---------------- | :---------------- | :------------------------- |
| dir created later | mkdir after start | subsequent `list` succeeds |

#### Related

- TC-FUNC-012

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-031: call tool before init -> not initialized

**Priority:** P0
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm any tool called before the synchronizer reaches `idle` returns `isError` "Server not initialized. Roots unavailable." and that prompts with `requiresInit` return `InvalidRequest`.

#### Preconditions

- Connection open, `initialize` sent, `notifications/initialized` not yet sent.

#### Steps

1. `tools/call list_roots` before init.
   - **Expected:** `isError: true`, content "Server not initialized. Roots unavailable." (code UNKNOWN).
2. `prompts/get analyze-path` before init.
   - **Expected:** `InvalidRequest` "Prompt analyze-path called before roots are initialized".

#### Test data

| Field | Value        | Notes               |
| :---- | :----------- | :------------------ |
| state | initializing | isInitialized false |

#### Post-conditions

- None.

#### Edge cases

| Variation                 | Input                 | Expected                                                        |
| :------------------------ | :-------------------- | :-------------------------------------------------------------- |
| PathGuard not initialized | direct validateAccess | `UNKNOWN` "PathGuard not initialized. Call initialize() first." |

#### Related

- TC-FUNC-012, TC-FUNC-024, TC-INT-011

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-032: MAX_FILE_SIZE env override changes read limit

**Priority:** P2
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `MAX_FILE_SIZE` (env or `--max-file-size`) overrides `MAX_TEXT_FILE_SIZE` for reads/edits, clamped to 1 MiB–100 MiB, and that it must be lifted before dynamic import (flag lifted to env by `cli-env`).

#### Preconditions

- A 5 MiB file. Server started with `--max-file-size 6291456` (6 MiB).

#### Steps

1. `read {path: <5 MiB file>}`.
   - **Expected:** succeeds (under raised limit).
2. Restart with `--max-file-size 1048576` (1 MiB) and `read` the same file.
   - **Expected:** `TOO_LARGE`.

#### Test data

| Field         | Value | Notes         |
| :------------ | :---- | :------------ |
| MAX_FILE_SIZE | bytes | 1 MiB–100 MiB |

#### Post-conditions

- None.

#### Edge cases

| Variation     | Input   | Expected                    |
| :------------ | :------ | :-------------------------- |
| below 1 MiB   | 512 KiB | clamped to 1 MiB; warning   |
| above 100 MiB | 200 MiB | clamped to 100 MiB; warning |

#### Related

- TC-PERF-001, TC-FUNC-001, TC-FUNC-008

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-INT-033: roots/list_changed re-negotiates roots

**Priority:** P1
**Type:** Integration
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a client `notifications/roots/list_changed` triggers a debounced (100 ms) re-negotiation and that `list_roots` reflects the new set; also that the notification is ignored before `isInitialized()`.

#### Contract

**Systems:** client -> server (roots synchronizer)
**Endpoint / message:** `notifications/roots/list_changed`

| Field    | Source           | Expected transform      | OK  |
| :------- | :--------------- | :---------------------- | :-- |
| debounce | 100 ms           | coalesces bursts        | [ ] |
| roots    | filtered file:// | realpath variants added | [ ] |

#### Preconditions

- Initialized session with client advertising `roots`.

#### Steps

1. Client changes its roots, sends `notifications/roots/list_changed`.
2. `list_roots`.
   - **Expected:** after the 100 ms debounce, roots updated to the new set (with realpath variants where different).
3. Before re-init, send `roots/list_changed` during `initializing` (new connection).
   - **Expected:** ignored until `isInitialized()`.

#### Test data

| Field    | Value  | Notes             |
| :------- | :----- | :---------------- |
| debounce | 100 ms | ROOTS_DEBOUNCE_MS |

#### Post-conditions

- Roots updated.

#### Edge cases

| Variation                       | Input        | Expected                                                 |
| :------------------------------ | :----------- | :------------------------------------------------------- |
| `listRoots` timeout (> 5000 ms) | slow client  | `debug` log if message contains "timeout"; roots cleared |
| no `roots` capability           | notification | no-op                                                    |

#### Related

- TC-FUNC-012, TC-INT-011

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

## Performance and limits

### TC-PERF-001: read at MAX_TEXT_FILE_SIZE boundary

**Priority:** P1
**Type:** Performance
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a read exactly at and one byte over `MAX_TEXT_FILE_SIZE` (default 10 MiB): boundary read succeeds; over returns `TOO_LARGE`; budget path (batch) skips via `preFilterByBudget`.

#### Metrics

| Metric        | Target      | Acceptable  | Actual | OK  |
| :------------ | :---------- | :---------- | :----- | :-- |
| read 10 MiB   | succeeds    | succeeds    |        | [ ] |
| read 10 MiB+1 | `TOO_LARGE` | `TOO_LARGE` |        | [ ] |

**Load:** single-file boundary; batch budget in TC-PERF-003.

#### Preconditions

- Files `exact.bin` (exactly `MAX_TEXT_FILE_SIZE` bytes) and `over.bin` (+1 byte). Default limit.

#### Steps

1. `read {path: "<root>\exact.bin"}`.
   - **Expected:** succeeds; content length = limit.
2. `read {path: "<root>\over.bin"}`.
   - **Expected:** `TOO_LARGE`.
3. `read {path: "<root>\over.bin", head: 1}` (partial read of oversized file).
   - **Expected:** succeeds (head avoids full read); content = first line.

#### Test data

| Field | Value           | Notes              |
| :---- | :-------------- | :----------------- |
| size  | 10 MiB boundary | MAX_TEXT_FILE_SIZE |

#### Post-conditions

- None.

#### Edge cases

| Variation           | Input                    | Expected                                            |
| :------------------ | :----------------------- | :-------------------------------------------------- |
| edit oversized file | `edit` on over.bin       | `TOO_LARGE` "File too large for edit" (TC-FUNC-008) |
| custom limit        | `--max-file-size` raised | boundary shifts (TC-INT-032)                        |

#### Related

- TC-FUNC-001, TC-FUNC-008, TC-INT-032

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-PERF-002: search timeout -> stoppedReason timeout

**Priority:** P2
**Type:** Performance
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm `search_text` and `find_files` return `stoppedReason: "timeout"` when the walk exceeds `DEFAULT_SEARCH_TIMEOUT` (default 5000 ms; lower for the test), without hanging.

#### Metrics

| Metric        | Target             | Acceptable | Actual | OK  |
| :------------ | :----------------- | :--------- | :----- | :-- |
| wall time     | <= timeout + slack | <= 6 s     |        | [ ] |
| stoppedReason | "timeout"          | "timeout"  |        | [ ] |

**Load:** a tree large enough to exceed the lowered timeout.

#### Preconditions

- Server with `DEFAULT_SEARCH_TIMEOUT=200` and a deep/wide tree of thousands of files.

#### Steps

1. `search_text {searchPattern: "rare"}` over the large tree.
   - **Expected:** `stoppedReason: "timeout"`; partial `matches`; no hang.
2. `find_files {pattern: "**/*"}` over the same tree.
   - **Expected:** `stoppedReason: "timeout"`; `nextCursor` or partial `results`.

#### Test data

| Field   | Value  | Notes                  |
| :------ | :----- | :--------------------- |
| timeout | 200 ms | DEFAULT_SEARCH_TIMEOUT |

#### Post-conditions

- None.

#### Edge cases

| Variation    | Input                    | Expected                                        |
| :----------- | :----------------------- | :---------------------------------------------- |
| cancellation | client aborts mid-search | `CANCELLED` (rethrowIfAborted); progress `fail` |

#### Related

- TC-FUNC-004, TC-FUNC-005, TC-FUNC-009

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-PERF-003: batch read budget MAX_READ_MANY_TOTAL_SIZE

**Priority:** P2
**Type:** Performance
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 3
**Created:** 2026-08-22

#### Objective

Confirm a batch `read` whose combined estimated size exceeds `MAX_READ_MANY_TOTAL_SIZE` (default 512 KiB) skips the overflowing paths with per-path `TOO_LARGE` "Skipped: combined estimated read would exceed maxTotalSize" rather than failing the whole batch.

#### Metrics

| Metric        | Target        | Acceptable    | Actual | OK  |
| :------------ | :------------ | :------------ | :----- | :-- |
| skipped paths | overflow ones | `TOO_LARGE`   |        | [ ] |
| succeeded     | within-budget | read normally |        | [ ] |

**Load:** batch of files summing > 512 KiB.

#### Preconditions

- Files `a.bin` (400 KiB), `b.bin` (200 KiB) in an allowed root.

#### Steps

1. `read {paths: ["<root>\a.bin", "<root>\b.bin"]}` (sum 600 KiB > 512 KiB).
   - **Expected:** at least one path skipped with `TOO_LARGE`; `summary.failed` reflects skips; the first(s) within budget succeed.
2. `read {paths: ["<root>\a.bin"]}` alone.
   - **Expected:** succeeds (400 KiB < 512 KiB).

#### Test data

| Field  | Value   | Notes                    |
| :----- | :------ | :----------------------- |
| budget | 512 KiB | MAX_READ_MANY_TOTAL_SIZE |

#### Post-conditions

- None.

#### Edge cases

| Variation     | Input                             | Expected            |
| :------------ | :-------------------------------- | :------------------ |
| custom budget | `MAX_READ_MANY_TOTAL_SIZE` raised | larger batches pass |

#### Related

- TC-FUNC-001, TC-PERF-001

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-PERF-004: result store LRU eviction

**Priority:** P3
**Type:** Performance
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 4
**Created:** 2026-08-22

#### Objective

Confirm the `ResourceStore` evicts oldest entries when `maxEntries` (64) or `maxTotalBytes` (25 MiB) is exceeded, and that `maxEntryBytes` (10 MiB) rejects oversize puts with `TOO_LARGE`.

#### Metrics

| Metric       | Target      | Acceptable     | Actual | OK  |
| :----------- | :---------- | :------------- | :----- | :-- |
| entries cap  | 64          | oldest evicted |        | [ ] |
| oversize put | `TOO_LARGE` | rejected       |        | [ ] |

**Load:** sequential tool results filling the store.

#### Preconditions

- Server with default store limits. Generate > 64 distinct cached results (e.g. > 64 `list` calls each overflowing to `resourceUri` with distinct dirs, or repeated `hash_file` on distinct content).

#### Steps

1. Produce 65 distinct cached result URIs.
   - **Expected:** the 65th push evicts the oldest; the first URI is now unreadable (`NOT_FOUND` "expired"/evicted).
2. Generate a single cached result > 10 MiB.
   - **Expected:** put rejected with `TOO_LARGE` "Resource too large to cache"; no `resourceUri` (or error path).
3. Re-read a recently used URI (LRU bumped).
   - **Expected:** still readable after older entries evicted.

#### Test data

| Field         | Value  | Notes   |
| :------------ | :----- | :------ |
| maxEntries    | 64     | default |
| maxEntryBytes | 10 MiB | default |

#### Post-conditions

- Store self-managed.

#### Edge cases

| Variation                | Input                                   | Expected                                 |
| :----------------------- | :-------------------------------------- | :--------------------------------------- |
| same hash dedup          | identical content re-run                | no new entry; TTL refreshed (TC-INT-003) |
| enforceAfterPut eviction | entry evicted by limits right after put | `TOO_LARGE` "Cache full: entry evicted"  |

#### Related

- TC-INT-003, TC-INT-004

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

### TC-PERF-005: list maxEntries truncation -> resourceUri

**Priority:** P2
**Type:** Performance
**Traceability:** Not required
**Status:** Not Run
**Estimated time:** 2
**Created:** 2026-08-22

#### Objective

Confirm `list` with `maxEntries` smaller than the directory size truncates inline entries, sets `resourceUri` for the full list, and that the cached list is readable (with `truncated: true` if beyond the stored cap).

#### Metrics

| Metric      | Target        | Acceptable | Actual | OK  |
| :---------- | :------------ | :--------- | :----- | :-- |
| inline      | <= maxEntries | truncated  |        | [ ] |
| resourceUri | present       | readable   |        | [ ] |

**Load:** directory with > `maxEntries` entries.

#### Preconditions

- Allowed root with a dir containing 200 files.

#### Steps

1. `list {path: "<root>\big", maxEntries: 10}`.
   - **Expected:** `entryCount: 10`, `totalEntries: 200`, `resourceUri` present.
2. `resources/read {uri: <resourceUri>}`.
   - **Expected:** full list (capped at `MAX_LIST_ENTRIES` 20000; if over, `truncated: true`).

#### Test data

| Field      | Value | Notes    |
| :--------- | :---- | :------- |
| maxEntries | 10    | small    |
| files      | 200   | over cap |

#### Post-conditions

- None.

#### Edge cases

| Variation                        | Input           | Expected                                             |
| :------------------------------- | :-------------- | :--------------------------------------------------- |
| maxEntries: 0                    | `maxEntries: 0` | schema min is 1 (`PositiveInt`); `VALIDATION_FAILED` |
| maxEntries over MAX_LIST_ENTRIES | 20001           | `VALIDATION_FAILED` (max 20000)                      |

#### Related

- TC-FUNC-002, TC-INT-003

#### Execution history

| Date | Tester | Build | Result | Bug ID | Notes |
| ---- | ------ | ----- | ------ | ------ | ----- |
|      |        |       |        |        |       |

## Ready gate

Every case above passes the test-case ready gate: at least one observable step, priority set, objective stated, preconditions given, test data table present, and **Traceability: Not required** (no spec exists). Edge-case rows and dedicated cases cover the parameter and error variation requested.

Coverage totals: 2 smoke, 29 functional, 17 security, 27 integration, 5 performance = **80 cases**. P0: 9 (SMOKE-001, SMOKE-002, TC-FUNC-001, TC-FUNC-012, TC-FUNC-013, TC-FUNC-015, TC-INT-011, TC-INT-031, TC-SEC-001).

Open assumptions (verify before first run):

- Symlink creation on Windows requires Developer Mode or admin privileges; symlink cases (TC-FUNC-003, TC-SEC-003, TC-SEC-008, TC-INT-005) skip on hosts lacking it, noted in execution history.
- Several limits (idle timeout, rate limit, watcher cap, search timeout, max sessions) are lowered via env for test speed; restore defaults after the run.
- Cross-device (EXDEV) in TC-FUNC-010 needs a second volume; mark Skipped if unavailable.
- The `list {}` no-path-with-multiple-roots behavior in SMOKE-001 edge row is inferred from `resolvePathOrRoot`; confirm against the running server and correct the expected text if it differs.
