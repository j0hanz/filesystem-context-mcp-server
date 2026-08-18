import process from 'node:process';
import { parseArgs } from 'node:util';

/**
 * CLI flags that are consumed via `process.env` rather than the parsed value.
 *
 * `--help` promises "flags take precedence when both are set", but every
 * consumer of these reads `process.env`, so the flag has to be copied across.
 * {@link liftFlagsToEnv} must run before any module that freezes an env value
 * into a module-level constant (`core/observability.ts` does this for
 * `LOG_LEVEL`, `core/util.ts` for `MAX_FILE_SIZE`), which is why
 * `src/index.ts` calls it above its dynamic imports rather than from
 * `parseArgs()`.
 *
 * Keep in sync with `CLI_PARSER_CONFIG` in `cli.ts` — `cli-flag-env.test.ts`
 * enforces that every key here is a declared flag there.
 */
export const FLAG_TO_ENV = {
  'http-host': 'HTTP_HOST',
  'api-key': 'API_KEY',
  'log-level': 'LOG_LEVEL',
  'max-file-size': 'MAX_FILE_SIZE',
  'root-boundary': 'ROOT_BOUNDARY',
} as const satisfies Record<string, string>;

/** Flags whose env var is not a plain string copy. */
export const SPECIAL_FLAG_TO_ENV = {
  'allow-sensitive': 'ALLOW_SENSITIVE',
  'walk-cwd': 'ALLOW_CWD_WALK',
  'allow-missing-roots': 'ALLOW_MISSING_ROOTS',
  deny: 'DENYLIST',
} as const satisfies Record<string, string>;

/** Boolean flags lifted as "1" when present. */
const BOOLEAN_FLAGS = ['allow-sensitive', 'walk-cwd', 'allow-missing-roots'] as const;

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
      options: {
        ...Object.fromEntries(
          Object.keys(FLAG_TO_ENV).map((flag) => [flag, { type: 'string' } as const]),
        ),
        ...Object.fromEntries(BOOLEAN_FLAGS.map((flag) => [flag, { type: 'boolean' } as const])),
        deny: { type: 'string', multiple: true },
      },
      strict: false,
      allowPositionals: true,
    }));
  } catch {
    return;
  }

  for (const [flag, envVar] of Object.entries(FLAG_TO_ENV)) {
    const value = values[flag];
    if (typeof value === 'string') env[envVar] = value;
  }

  for (const flag of BOOLEAN_FLAGS) {
    if (values[flag] === true) env[SPECIAL_FLAG_TO_ENV[flag]] = '1';
  }

  const deny = values['deny'];
  if (Array.isArray(deny) && deny.length > 0) env['DENYLIST'] = deny.join(',');
}
