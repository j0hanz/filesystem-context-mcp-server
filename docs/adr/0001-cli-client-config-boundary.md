# ADR-0001: client-config Boundary Inside cli.ts

**Date**: 2026-06-24
**Status**: Accepted

## Problem

`src/cli.ts` (1075 lines, highest-churn file after `package.json`) mixes two concerns that change for different reasons: CLI bootstrap/arg-parsing (`parseArgs`, `validateDirectoryPath`, `printHelpAndExit`, `runPrintConfig`) and a client-config installer (`allowPath`, `disallowPath`, `listAllowedPaths`, `manageConfig`, `getExistingConfigPaths`, `writeJsonAtomic`, plus the internal `findServerEntry`/`acquireLock`/`modifySingleConfig`/`getTargetConfigs`) that reads and mutates third-party MCP client config files (Claude Desktop, Cursor, VS Code extensions, etc.) under file-lock and atomic-write guarantees.

The file's own section comment ("Config File Management — reads/writes MCP client config files", line 454) already gestures at this boundary, but it over-includes `runPrintConfig`/`EffectiveConfig`, which print this server's own runtime settings and never touch a client config file.

## Decision

Recognize `client-config` as a distinct concern from CLI bootstrap, with this exact boundary:

- **client-config** (the installer): `ClientConfigTarget`, `getExistingConfigPaths`, `writeJsonAtomic`, `ModifyOptions`, `findServerEntry`, `acquireLock`, `readOrCreateConfig`, `tryComparePaths`, `readDirsFromEnv`, `updateEnvForPath`, `modifySingleConfig`, `getTargetConfigs`, `modifyConfig`, `allowPath`, `disallowPath`, `listAllowedPaths`, `manageConfig`.
- **CLI bootstrap** (stays in `cli.ts`): `CliExitError`, `resolveConfigKey`, `validateCliPath`, `validateDirectoryPath`, `normalizeAndValidateDirs`, `printHelpAndExit`, `printVersionAndExit`, `parsePortOption`, `parseArgs`, `EffectiveConfig`, `PrintConfigOptions`, `runPrintConfig` — including `runPrintConfig`, despite living inside the "Config File Management" section today, since it never reads or writes a client's config file.

`acquireLock` and `writeJsonAtomic` are internal mechanisms of client-config, not their own domain — nothing outside this concern calls them.

We are **not** physically splitting the file right now. This ADR records the boundary for the next time `cli.ts` is touched; no code moved.

## Rationale

Static callers are exactly two: `src/index.ts` (`main()`, imports `parseArgs`/`runPrintConfig`/`CliExitError` for bootstrap and `allowPath`/`disallowPath`/`listAllowedPaths`/`manageConfig` for the installer) and `__tests__/unit/config-helper.test.ts` (imports the installer functions directly). No dynamic/runtime callers exist — this is pure CLI subcommand logic, unreachable from the MCP server itself.

The deletion test is mixed here: with only one production caller, the installer logic wouldn't duplicate across many call sites if deleted (the classic "deep module, extract it" signal is weak). The value of this boundary is locality and reduced churn-conflation, not reuse — `cli.ts` is the second-highest-churn file in the repo, and bootstrap changes (new flags) and installer changes (new client config formats) currently land in the same file and the same git-blame history for unrelated reasons.

Non-negotiable: the locking (`acquireLock`'s 30s stale-lock takeover) and atomic-write-with-fallback (`writeJsonAtomic`'s temp-file+rename, falling back to a direct write on rename failure) behavior must survive any future split byte-for-byte — this is what prevents two concurrent CLI invocations from corrupting a user's real Claude Desktop/Cursor config file.

## Implications

- Future PRs touching CLI flags/argument parsing should not also touch `findServerEntry`/`modifyConfig`/lock logic in the same change, and vice versa — that's the signal this boundary exists to separate.
- If `cli.ts` is split later, `runPrintConfig`/`EffectiveConfig`/`PrintConfigOptions` go with CLI bootstrap, not with client-config, regardless of which section comment they currently sit under.
- `acquireLock` and `writeJsonAtomic` should stay non-exported internals of whichever file holds client-config — do not promote them to a shared `utils` location (see `No_Utility_Bins` constraint).
- `writeJsonAtomic` is currently exported and directly imported by `__tests__/unit/config-helper.test.ts` — any future split must keep it exported from wherever client-config lands, or update that test's import path.

## Related Issues

None — recorded ahead of any ticket, from an architecture audit pass.
