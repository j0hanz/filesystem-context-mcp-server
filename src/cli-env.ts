import process from 'node:process';
import { parseArgs } from 'node:util';

/**
 * Every CLI flag that is consumed via `process.env` rather than the parsed
 * value, and how it is lifted.
 *
 * `--help` promises "flags take precedence when both are set", but every
 * consumer of these reads `process.env`, so the flag has to be copied across.
 * {@link liftFlagsToEnv} must run before any module that freezes an env value
 * into a module-level constant (`core/observability.ts` does this for
 * `LOG_LEVEL`, `core/util.ts` for `MAX_FILE_SIZE`), which is why
 * `src/index.ts` calls it above its dynamic imports rather than from
 * `parseArgs()`.
 *
 * - `string`  — copied verbatim into `env[name]`
 * - `boolean` — lifted as "1" when the flag is present
 * - `list`    — appended to a comma-separated `env[name]`, deduped
 *
 * Keys must be declared options in `CLI_PARSER_CONFIG` (`cli.ts`);
 * `cli-flag-env.test.ts` proves it.
 */
export const FLAG_ENV_SPECS = {
  'http-host': { env: 'HTTP_HOST', lift: 'string' },
  'api-key': { env: 'API_KEY', lift: 'string' },
  'log-level': { env: 'LOG_LEVEL', lift: 'string' },
  'log-format': { env: 'LOG_FORMAT', lift: 'string' },
  'max-file-size': { env: 'MAX_FILE_SIZE', lift: 'string' },
  'root-boundary': { env: 'ROOT_BOUNDARY', lift: 'string' },
  'allow-sensitive': { env: 'ALLOW_SENSITIVE', lift: 'boolean' },
  'walk-cwd': { env: 'ALLOW_CWD_WALK', lift: 'boolean' },
  'allow-missing-roots': { env: 'ALLOW_MISSING_ROOTS', lift: 'boolean' },
  deny: { env: 'DENYLIST', lift: 'list' },
} as const satisfies Record<string, { env: string; lift: 'string' | 'boolean' | 'list' }>;

/**
 * Copies env-backed CLI flags into `process.env`. `cli.ts` still owns strict
 * validation and error reporting; this pass only moves values across, and stays
 * silent on malformed argv so the strict parse produces the real message.
 *
 * @param argv - Argument list to read, defaulting to the process arguments.
 * @param env - Environment to write into, defaulting to `process.env`.
 */
export function liftFlagsToEnv(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): void {
  let values: Record<string, unknown>;
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: Object.fromEntries(
        Object.entries(FLAG_ENV_SPECS).map(([flag, spec]) => [
          flag,
          spec.lift === 'string'
            ? { type: 'string' }
            : spec.lift === 'boolean'
              ? { type: 'boolean' }
              : { type: 'string', multiple: true },
        ]),
      ),
      strict: false,
      allowPositionals: true,
    }));
  } catch {
    return;
  }

  for (const [flag, spec] of Object.entries(FLAG_ENV_SPECS)) {
    const value = values[flag];
    if (spec.lift === 'string') {
      if (typeof value === 'string') env[spec.env] = value;
    } else if (spec.lift === 'boolean') {
      if (value === true) env[spec.env] = '1';
    } else {
      // Deny is additive — a CLI `--deny` extends the env `DENYLIST` rather than
      // replacing it, so operators can layer extra entries onto a base denylist.
      // Deduped so a second lift over the same argv is a no-op, like every other
      // flag here (which simply overwrite).
      if (Array.isArray(value) && value.length > 0) {
        const existing = env[spec.env];
        const entries = existing ? existing.split(',') : [];
        for (const entry of value) {
          if (typeof entry === 'string' && !entries.includes(entry)) entries.push(entry);
        }
        env[spec.env] = entries.join(',');
      }
    }
  }
}
