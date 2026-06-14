/**
 * Flag→env bridge — zero project imports.
 *
 * Must remain free of any intra-package dependencies so it can be statically
 * imported by the entrypoint and executed BEFORE any config-bearing module
 * (e.g. util.ts) is loaded. util.ts freezes env-derived constants at first
 * import; this module sets process.env first so those constants observe the
 * flag values.
 */

/** [flag, envVar, isBoolean] */
export const BRIDGE_MAP: readonly (readonly [string, string, boolean])[] = [
  ['--log-level', 'FILESYSTEM_MCP_LOG_LEVEL', false],
  ['--http-host', 'FILESYSTEM_MCP_HTTP_HOST', false],
  ['--api-key', 'FILESYSTEM_MCP_API_KEY', false],
  ['--allow-sensitive', 'FS_CONTEXT_ALLOW_SENSITIVE', true],
  ['--root-boundary', 'FS_ROOT_BOUNDARY', false],
  ['--max-file-size', 'MAX_FILE_SIZE', false],
  ['--walk-cwd', 'FS_ALLOW_CWD_WALK', true],
  ['--allow-missing-roots', 'FS_ALLOW_MISSING_ROOTS', true],
  ['--deny', 'FS_CONTEXT_DENYLIST', false],
];

/**
 * Parse `argv` for bridge flags and write the corresponding env vars.
 * The flag wins and overrides any already-set env var.
 */
export function applyBridgeFlags(argv: string[]): void {
  const values = new Map<string, string[]>();

  for (const [flag, envVar, isBoolean] of BRIDGE_MAP) {
    let idx = -1;
    while ((idx = argv.indexOf(flag, idx + 1)) !== -1) {
      if (isBoolean) {
        let list = values.get(envVar);
        if (!list) {
          list = [];
          values.set(envVar, list);
        }
        list.push('1');
      } else {
        const val = argv[idx + 1];
        if (val !== undefined && !val.startsWith('-')) {
          let list = values.get(envVar);
          if (!list) {
            list = [];
            values.set(envVar, list);
          }
          list.push(val);
        }
      }
    }
  }

  for (const [envVar, list] of values.entries()) {
    if (envVar === 'FS_CONTEXT_DENYLIST') {
      process.env[envVar] = list.join(',');
    } else {
      process.env[envVar] = list[list.length - 1];
    }
  }
}
