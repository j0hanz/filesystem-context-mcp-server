# 0001-cli-client-config-boundary

Spec: [0001-cli-client-config-boundary.specs.md](0001-cli-client-config-boundary.specs.md)

## Goal

Extract the client-config installer (allow/disallow/list/manageConfig + its file-locking and atomic-write internals) out of `src/cli.ts` into a new `src/client-config.ts`, per [ADR-0001](../docs/adr/0001-cli-client-config-boundary.md), with zero behavior change and `npm run check` green.

## Current Context

All client-config logic currently lives in [src/cli.ts](src/cli.ts) lines 525-1075, interleaved with CLI bootstrap. `runPrintConfig`/`EffectiveConfig`/`PrintConfigOptions` (lines 457-523) sit in the same file section but are bootstrap, not installer — they stay in `cli.ts`. The only production caller is `main()` in [src/index.ts](src/index.ts#L120). [**tests**/unit/config-helper.test.ts](__tests__/unit/config-helper.test.ts) imports 5 installer functions directly from `src/cli.js`.

## PHASE-001: Implementation

### TASK-001: Create src/client-config.ts with the moved installer code

Depends on: none
Files: [UNVERIFIED: src/client-config.ts](UNVERIFIED), [src/cli.ts](src/cli.ts)
Symbols: [ClientConfigTarget](src/cli.ts#L525), [getExistingConfigPaths](src/cli.ts#L530), [writeJsonAtomic](src/cli.ts#L585), [ModifyOptions](src/cli.ts#L621), [findServerEntry](src/cli.ts#L629), [acquireLock](src/cli.ts#L667), [readOrCreateConfig](src/cli.ts#L712), [tryComparePaths](src/cli.ts#L725), [readDirsFromEnv](src/cli.ts#L737), [updateEnvForPath](src/cli.ts#L746), [modifySingleConfig](src/cli.ts#L773), [getTargetConfigs](src/cli.ts#L832), [allowPath](src/cli.ts#L842), [disallowPath](src/cli.ts#L877), [listAllowedPaths](src/cli.ts#L916), [modifyConfig](src/cli.ts#L960), [manageConfig](src/cli.ts#L1048), [CONFIG_KEY_MAP](src/cli.ts#L37), [resolveConfigKey](src/cli.ts#L49), [ENV_DIR_SEP](src/cli.ts#L31)
Satisfies: REQ-001, REQ-004, REQ-006
Action: Create `src/client-config.ts` containing the 17 installer symbols copied verbatim (same logic, same constants — 30000ms stale-lock, 10 retries/100ms delay, temp-file-then-rename) plus `CONFIG_KEY_MAP`, `resolveConfigKey`, and `ENV_DIR_SEP` moved in wholesale (they have no caller in `cli.ts`'s bootstrap code); export only `ClientConfigTarget`, `getExistingConfigPaths`, `writeJsonAtomic`, `ModifyOptions`, `allowPath`, `disallowPath`, `listAllowedPaths`, `manageConfig`, keeping everything else (including the internal `modifyConfig` helper, `CONFIG_KEY_MAP`, `resolveConfigKey`, `ENV_DIR_SEP`) non-exported; import `CliExitError`, `IS_WINDOWS`, `validateCliPath` from `./cli.js` (the latter two will be newly exported by TASK-002); add the `node:fs`/`node:fs/promises`/`node:os`/`node:path`/`node:crypto` and `src/core/{path,primitives,fmt}.js` imports these symbols need.
Validate: `npm run type-check`
Expected result: `src/client-config.ts` compiles with no type errors and exports the 8 public symbols.

### TASK-002: Remove the moved code from src/cli.ts and export the two shared helpers

Depends on: [TASK-001](#task-001-create-srcclient-configts-with-the-moved-installer-code)
Files: [src/cli.ts](src/cli.ts)
Symbols: [IS_WINDOWS](src/cli.ts#L29), [validateCliPath](src/cli.ts#L63)
Satisfies: REQ-003, REQ-006
Action: Delete lines 525-1075's installer block plus the moved-only `CONFIG_KEY_MAP`/`resolveConfigKey`/`ENV_DIR_SEP` (lines 31, 37-51) from `src/cli.ts`; add `export` to the `IS_WINDOWS` const (line 29) and the `validateCliPath` function (line 63) declarations since `client-config.ts` now imports both — no other bootstrap symbol changes.
Validate: `grep -c "^export \(async \)\?function \(allowPath\|disallowPath\|listAllowedPaths\|manageConfig\|getExistingConfigPaths\|writeJsonAtomic\)" src/cli.ts; grep -c "CONFIG_KEY_MAP\|resolveConfigKey\|ENV_DIR_SEP" src/cli.ts; grep -c "^export const IS_WINDOWS\|^export function validateCliPath" src/cli.ts`
Expected result: `0`, `0`, `2`

### TASK-003: Point src/index.ts at the new module

Depends on: [TASK-002](#task-002-remove-the-moved-code-from-srcclitsts-and-export-the-two-shared-helpers)
Files: [src/index.ts](src/index.ts)
Symbols: [main](src/index.ts#L120)
Satisfies: REQ-002
Action: In the top-level dynamic `await import('./cli.js')` destructure (lines 24-32, evaluated before `main()` runs but whose results `main()` uses), move `allowPath`, `disallowPath`, `listAllowedPaths`, `manageConfig` into a new `await import('./client-config.js')` destructure, keeping `CliExitError`, `parseArgs`, `runPrintConfig` imported from `./cli.js`.
Validate: `npm run type-check`
Expected result: No type errors; `src/index.ts` resolves all four installer imports from `client-config.js`.

### TASK-004: Update config-helper test imports

Depends on: [TASK-001](#task-001-create-srcclient-configts-with-the-moved-installer-code)
Files: [**tests**/unit/config-helper.test.ts](__tests__/unit/config-helper.test.ts)
Symbols: none
Satisfies: REQ-005
Action: Change the import of `allowPath`, `disallowPath`, `getExistingConfigPaths`, `listAllowedPaths`, `writeJsonAtomic` from `../../src/cli.js` to `../../src/client-config.js`, keeping `parseArgs` imported from `../../src/cli.js`.
Validate: `npm test -- __tests__/unit/config-helper.test.ts`
Expected result: All tests in the file pass, 0 failures.

## PHASE-END: Acceptance

### TASK-005: Final acceptance verification

Depends on: [TASK-004](#task-004-update-config-helper-test-imports)
Files: none
Symbols: none
Satisfies: AC-001, AC-002, AC-003, AC-004, AC-005
Action: Run every VAL command from the spec in sequence and confirm each expected result.
Validate: `npm run check`
Expected result: Build + type-check + eslint + prettier + knip + full test suite all pass, 0 errors.
