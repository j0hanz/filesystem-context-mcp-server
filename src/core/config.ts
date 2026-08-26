// Resolved CLI-flag overrides — the one owner of the flag-beats-env rule.
//
// `parseArgs` (cli.ts) used to write flag values back into `process.env` so
// deep core readers (path, sensitive, observability, util) would pick them up.
// That made the environment a hidden mutable config bus. Instead, cli.ts
// assigns onto `cli` once at startup and each reader consults it first, falling
// back to the operator's environment. This module deliberately has zero imports
// so any core module can read it without a cycle.

export interface CliOverrides {
  /** `--log-level` */
  logLevel?: string;
  /** `--max-file-size` (raw string; validated by the reader like the env var) */
  maxFileSize?: string;
  /** `--root-boundary` */
  rootBoundary?: string;
  /** `--allow-sensitive` */
  allowSensitive?: boolean;
  /** `--walk-cwd` */
  allowCwdWalk?: boolean;
  /** `--allow-missing-roots` */
  allowMissingRoots?: boolean;
  /** `--deny` entries (merged with DENYLIST by the reader) */
  denyPatterns?: readonly string[];
}

/** Written once by cli.ts; an absent key means "not set on the command line". */
export const cli: CliOverrides = {};
