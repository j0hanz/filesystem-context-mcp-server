# 0001-cli-client-config-boundary

## 1. Goal

- Extract the client-config installer (allowPath, disallowPath, listAllowedPaths, manageConfig, getExistingConfigPaths, writeJsonAtomic, and their internal helpers) out of `src/cli.ts` into a new `src/client-config.ts` module, per [ADR-0001](../docs/adr/0001-cli-client-config-boundary.md), with zero behavior change.
- Completion signal: `src/cli.ts` exports no client-config-installer function; `src/index.ts` imports them from `src/client-config.js`; `npm run check` passes.

## 2. Requirements

- `REQ-001`: `src/client-config.ts` MUST export `getExistingConfigPaths`, `writeJsonAtomic`, `allowPath`, `disallowPath`, `listAllowedPaths`, `manageConfig`, `ClientConfigTarget`, and `ModifyOptions` with signatures identical to their current `src/cli.ts` counterparts.
- `REQ-002`: `src/index.ts`'s `main()` MUST import `allowPath`, `disallowPath`, `listAllowedPaths`, `manageConfig` from `src/client-config.js` instead of `src/cli.js`.
- `REQ-003`: `src/cli.ts` MUST retain `parseArgs`, `runPrintConfig`, `EffectiveConfig`, `PrintConfigOptions`, `CliExitError`, and all other CLI-bootstrap symbols with unchanged behavior and signatures.
- `REQ-004`: `findServerEntry`, `acquireLock`, `readOrCreateConfig`, `tryComparePaths`, `readDirsFromEnv`, `updateEnvForPath`, `modifySingleConfig`, `getTargetConfigs` MUST move to `src/client-config.ts` as non-exported internals.
- `REQ-005`: `__tests__/unit/config-helper.test.ts` MUST import `allowPath`, `disallowPath`, `getExistingConfigPaths`, `listAllowedPaths`, `writeJsonAtomic` from `src/client-config.js` instead of `src/cli.js`; `parseArgs` MUST stay imported from `src/cli.js`.
- `REQ-006`: `src/client-config.ts` MUST resolve its cross-boundary dependencies on the moved code's behalf: import `CliExitError` (already exported), `IS_WINDOWS`, and `validateCliPath` from `src/cli.js` (the latter two newly exported, since `cli.ts`'s bootstrap code at lines 289/377/392 also uses them); and must own `CONFIG_KEY_MAP`, `resolveConfigKey`, and `ENV_DIR_SEP` outright (moved out of `cli.ts`, not duplicated), since no bootstrap code calls them.

## 3. Constraints

- `CON-001`: The solution MUST NOT change `acquireLock`'s stale-lock timing (30000ms) or retry/backoff parameters (10 retries, 100ms delay).
- `CON-002`: The solution MUST NOT change `writeJsonAtomic`'s temp-file-then-rename algorithm or its non-atomic fallback-write path.
- `CON-003`: The solution MUST NOT introduce a shared `utils/`-style file for `acquireLock`/`writeJsonAtomic` — they stay internal to `client-config.ts`.
- `CON-004`: The solution MUST NOT change `parseArgs`'s external CLI flag surface as part of this split.

## 4. Interfaces

The module exposes the following interfaces (unchanged signatures, new file location):

### `getExistingConfigPaths(env?, osPlatform?, homeDir?, exists?) -> ClientConfigTarget[]`

**Input:** all params optional, default to `process.env`/`platform()`/`homedir()`/`existsSync`
**Output:** `ClientConfigTarget[]` — `{ name: string; path: string }[]` for every client config file found on disk
**Errors:** none — returns `[]` if no config files exist

### `writeJsonAtomic(filePath: string, data: unknown) -> Promise<void>`

**Input:** `filePath` (string, required), `data` (unknown, required, JSON-serializable)
**Output:** `void` — file written
**Errors:** throws `Error` if both the atomic rename and the non-atomic fallback write fail

### `allowPath(pathToAdd: string, options?: ModifyOptions) -> Promise<void>`

**Input:** `pathToAdd` (string, required), `options` (ModifyOptions, optional: client/config/serverName/dryRun)
**Output:** `void` — target client config(s) updated with the new allowed directory
**Errors:** throws `CliExitError` on invalid/missing path or lock-acquisition failure

### `disallowPath(pathToRemove: string, options?: ModifyOptions) -> Promise<void>`

**Input:** `pathToRemove` (string, required), `options` (ModifyOptions, optional)
**Output:** `void` — directory removed from target client config(s)
**Errors:** throws `CliExitError` on invalid/missing path or lock-acquisition failure

### `listAllowedPaths(options?: ModifyOptions) -> Promise<string[]>`

**Input:** `options` (ModifyOptions, optional)
**Output:** `string[]` of currently allowed directories
**Errors:** throws `CliExitError` if the target config can't be read

### `manageConfig(action, key?, value?, options?) -> Promise<void>`

**Input:** `action` (`'set'|'get'|'list'|'reset'`, required), `key`/`value` (string, optional), `options` (ModifyOptions, optional)
**Output:** `void` — server env config mutated/printed per action
**Errors:** throws `CliExitError` on invalid action or missing required key/value

## 5. Context

- Files: [src/cli.ts](src/cli.ts) (current home of all functions above, lines 525-1075, plus the cross-boundary dependencies `IS_WINDOWS`/`CliExitError`/`validateCliPath`/`CONFIG_KEY_MAP`/`resolveConfigKey`/`ENV_DIR_SEP` at lines 29-63), [src/index.ts](src/index.ts) (sole production caller — top-level dynamic `await import('./cli.js')` destructure at lines 24-32, consumed inside `main()` starting at line 120), [**tests**/unit/config-helper.test.ts](__tests__/unit/config-helper.test.ts) (direct importer of 5 installer functions)
- Current behavior: all client-config logic lives inside `src/cli.ts` alongside CLI bootstrap; documented boundary in [docs/adr/0001-cli-client-config-boundary.md](../docs/adr/0001-cli-client-config-boundary.md)
- Conventions: ESM imports require explicit `.js` extensions; new file follows the same top-level-module convention as `src/cli.ts`/`src/server.ts` (not placed under `src/core/`, since nothing outside `cli.ts`/`index.ts` will ever import it)

## 6. Acceptance Criteria & Validation

- `AC-001`: `src/cli.ts` no longer defines `allowPath`, `disallowPath`, `listAllowedPaths`, `manageConfig`, `getExistingConfigPaths`, or `writeJsonAtomic`.
- `VAL-001`: `grep -c "^export \(async \)\?function \(allowPath\|disallowPath\|listAllowedPaths\|manageConfig\|getExistingConfigPaths\|writeJsonAtomic\)" src/cli.ts`
- Expected: `0`

- `AC-002`: All four existing CLI test files pass unmodified in behavior (only import paths may change).
- `VAL-002`: `npm test -- __tests__/unit/config-helper.test.ts __tests__/unit/cli-read-only.test.ts __tests__/unit/cli-dir-unify.test.ts __tests__/unit/cli-print-config.test.ts`
- Expected: all tests pass, 0 failures

- `AC-003`: The project type-checks cleanly after the split.
- `VAL-003`: `npm run type-check`
- Expected: exits 0, no errors

- `AC-004`: The full check pipeline (build + type-check + eslint + prettier + knip + test) passes, confirming no unused-export or dead-code regressions from the move.
- `VAL-004`: `npm run check`
- Expected: exits 0

- `AC-005`: `cli.ts` no longer owns the moved-only constants/helpers, and exports the two genuinely-shared ones.
- `VAL-005`: `grep -c "CONFIG_KEY_MAP\|resolveConfigKey\|ENV_DIR_SEP" src/cli.ts; grep -c "^export const IS_WINDOWS\|^export function validateCliPath" src/cli.ts`
- Expected: first command outputs `0`, second outputs `2`

## 7. Examples & Edge Cases

**Positive example:**

```
Input:  CLI invocation `node dist/index.js allow /some/path`
Output: main() in src/index.ts calls allowPath() imported from src/client-config.js;
        target client config file gains /some/path under mcpServers.<name>.env; exit 0
```

**Edge cases:**

- Two concurrent `allow`/`disallow` invocations racing on the same config file → `acquireLock` (now in `client-config.ts`) still serializes via the lock file; a stale lock (>30s old) is still reclaimed exactly as before the move.
- `knip` (run via `npm run check`) flags `writeJsonAtomic` as an unused export if `__tests__/unit/config-helper.test.ts`'s import path isn't updated to `src/client-config.js` in the same change.
- `src/cli.ts` importing from `src/client-config.js` for nothing (cli.ts itself has no internal caller of the installer functions) — confirm no leftover unused import is added to `cli.ts` during the move.
