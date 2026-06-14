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
];

/**
 * Parse `argv` for bridge flags and write the corresponding env vars.
 * An already-set env var wins; the flag only fills a gap.
 */
export function applyBridgeFlags(argv: string[]): void {
  for (const [flag, envVar, isBoolean] of BRIDGE_MAP) {
    if (process.env[envVar] !== undefined) continue;
    const idx = argv.indexOf(flag);
    if (idx === -1) continue;
    if (isBoolean) {
      process.env[envVar] = '1';
    } else {
      const val = argv[idx + 1];
      if (val !== undefined && !val.startsWith('-')) {
        process.env[envVar] = val;
      }
    }
  }
}
