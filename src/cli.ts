import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { getSystemErrorMessage, getSystemErrorName, parseArgs as utilParseArgs } from 'node:util';

import { processInParallel } from './core/concurrency.js';
import { formatUnknownErrorMessage } from './core/errors.js';
import { cliFmt, padEndVisible } from './core/fmt.js';
import {
  getReservedDeviceNameForPath,
  isWindowsDriveRelativePath,
  normalizePath,
  PathGuard,
} from './core/path.js';
import { IS_WINDOWS, isRecord, parseTrueEnvFlag } from './core/primitives.js';
import { MAX_TEXT_FILE_SIZE } from './core/util.js';
import { pkgInfo } from './pkg-info.js';
import { MUTATING_TOOL_NAMES, registeredTools } from './tools/index.js';

const { version: SERVER_VERSION } = pkgInfo;
const CLI_VALIDATE_CONCURRENCY = 8;

// ════════════════════════════════════════════════════════════
// Path & Config Utilities — pure functions and error types
// ════════════════════════════════════════════════════════════

export class CliExitError extends Error {
  readonly exitCode: number;

  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'CliExitError';
    this.exitCode = exitCode;
  }
}

function validateCliPath(inputPath: string): void {
  if (inputPath.includes('\0')) {
    throw new CliExitError('Path contains null bytes.', 1);
  }

  if (isWindowsDriveRelativePath(inputPath)) {
    throw new CliExitError(
      'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
      1,
    );
  }

  const reserved = getReservedDeviceNameForPath(inputPath);
  if (reserved) {
    throw new CliExitError(`Windows reserved device name not allowed: ${reserved}.`, 1);
  }
}

function getSystemErrorDetails(error: unknown): {
  code: string | undefined;
  errno: number | undefined;
} {
  if (!isRecord(error)) return { code: undefined, errno: undefined };
  const code = typeof error['code'] === 'string' ? error['code'] : undefined;
  const errno = typeof error['errno'] === 'number' ? error['errno'] : undefined;
  return { code, errno };
}

function normalizeDirectoryError(error: unknown, inputPath: string): Error {
  const { code, errno } = getSystemErrorDetails(error);
  if (error instanceof Error && code === undefined && errno === undefined) {
    return error;
  }

  if (typeof errno === 'number') {
    try {
      const name = getSystemErrorName(errno);
      const message = getSystemErrorMessage(errno);
      return new Error(`Cannot access directory ${inputPath} (${name}: ${message})`);
    } catch {
      // Fall through, but preserve raw errno value
    }
    return new Error(`Cannot access directory ${inputPath} (errno ${errno})`);
  }

  if (code) {
    return new Error(`Cannot access directory ${inputPath} (${code})`);
  }

  return new Error(`Cannot access directory ${inputPath}`);
}

function assertDirectory(stats: Stats, inputPath: string): void {
  if (stats.isDirectory()) return;
  throw new Error(`${inputPath} is not a directory`);
}

async function validateDirectoryPath(inputPath: string, allowMissing = false): Promise<string> {
  const normalized = normalizePath(inputPath);

  try {
    const stats = await stat(normalized);
    assertDirectory(stats, inputPath);
    return normalized;
  } catch (error) {
    if (allowMissing) {
      if (error instanceof Error && error.message.includes('is not a directory')) {
        throw error;
      }
      return normalized;
    }
    throw normalizeDirectoryError(error, inputPath);
  }
}

export async function normalizeAndValidateDirs(
  paths: readonly string[],
  allowMissing = false,
): Promise<string[]> {
  const { results, errors } = await processInParallel(
    [...paths],
    (p) => validateDirectoryPath(p, allowMissing),
    CLI_VALIDATE_CONCURRENCY,
  );
  if (errors.length === 0) {
    return deduplicateAllowedDirectories(results.map((r) => r.value));
  }
  const first = errors.reduce((prev, curr) => (curr.index < prev.index ? curr : prev));
  throw first.error;
}

interface HelpRow {
  flags: string;
  desc: string;
}

// ════════════════════════════════════════════════════════════
// CLI Display & Argument Parsing — impure, calls process.exit
// ════════════════════════════════════════════════════════════

const OPTIONS_HELP: HelpRow[] = [
  { flags: '-h, --help', desc: 'Show this help message' },
  { flags: '-v, --version', desc: 'Show the server version' },
  { flags: '--allow-cwd', desc: 'Add the current working directory as an allowed root' },
  { flags: '--port <number>', desc: 'Start HTTP transport on this port (Node Streamable HTTP)' },
  {
    flags: '--read-only',
    desc: `Disable write tools: ${[...MUTATING_TOOL_NAMES].sort().join(', ')}`,
  },
  { flags: '--safe', desc: 'Alias for --read-only' },
  {
    flags: '--print-config',
    desc: 'Print the active configuration and exit (use with --json for machine output)',
  },
  { flags: '--json', desc: 'Output --print-config as JSON' },
  {
    flags: '--log-level <level>',
    desc: 'Log level: debug|info|warn|error (env: LOG_LEVEL)',
  },
  {
    flags: '--log-format <format>',
    desc: 'Log format: text|json (env: LOG_FORMAT)',
  },
  { flags: '--http-host <host>', desc: 'HTTP server bind address (env: HTTP_HOST)' },
  {
    flags: '--api-key <key>',
    desc: 'Require this API key on HTTP requests; prefer API_KEY (argv is world-readable)',
  },
  {
    flags: '--allow-sensitive',
    desc: 'Allow access to sensitive system paths (env: ALLOW_SENSITIVE)',
  },
  {
    flags: '--root-boundary <path>',
    desc: 'Require all allowed roots to fall under this path (env: ROOT_BOUNDARY)',
  },
  {
    flags: '--max-file-size <bytes>',
    desc: 'Maximum file size for reads in bytes (env: MAX_FILE_SIZE)',
  },
  { flags: '--walk-cwd', desc: 'Walk up from CWD to find a project root; implies --allow-cwd' },
  { flags: '--deny <pattern>', desc: 'Block paths matching this pattern; repeatable' },
  {
    flags: '--allow-missing-roots',
    desc: 'Start even if configured allowed directories do not exist',
  },
];

export const ENV_HELP: HelpRow[] = [
  { flags: 'LOG_LEVEL', desc: 'Log level: debug|info|warn|error' },
  { flags: 'LOG_FORMAT', desc: 'Log format: text|json (default: text)' },
  { flags: 'HTTP_HOST', desc: 'HTTP bind address' },
  { flags: 'API_KEY', desc: 'HTTP API key' },
  {
    flags: 'FILESYSTEM_MCP_TRUST_PROXY',
    desc: 'Express trust-proxy setting: hop count or expression (unset = do not trust X-Forwarded-*)',
  },
  {
    flags: 'ALLOW_SENSITIVE',
    desc: 'Allow sensitive system paths (any value enables this)',
  },
  { flags: 'ROOT_BOUNDARY', desc: 'Path prefix all allowed roots must fall under' },
  { flags: 'MAX_FILE_SIZE', desc: 'Maximum file size for reads in bytes' },
  {
    flags: 'FS_ALLOWED_DIRS',
    desc: 'Allowed dirs: colon-separated (Unix), semicolon-separated (Windows)',
  },
  {
    flags: 'ALLOW_CWD_WALK',
    desc: 'Walk up from CWD to find a project root (any value enables this)',
  },
  { flags: 'DENYLIST', desc: 'Paths/patterns to block, comma-separated' },
  {
    flags: 'ALLOW_MISSING_ROOTS',
    desc: 'Start even if configured allowed directories do not exist (any value enables this)',
  },
  {
    flags: 'FILESYSTEM_MCP_ALLOWED_HOSTS',
    desc: 'Comma-separated Host header values to accept (HTTP transport)',
  },
  { flags: 'FILESYSTEM_MCP_ALLOWED_ORIGINS', desc: 'Comma-separated origin hostnames for CORS' },
  {
    flags: 'FILESYSTEM_MCP_ALLOW_UNRESTRICTED_HOSTS',
    desc: 'Set to 1 to bind a wildcard host with no Host validation (accepts the risk)',
  },
  { flags: 'FILESYSTEM_MCP_PUBLIC_URL', desc: 'Resource identifier URL for RFC 9728 discovery' },
  {
    flags: 'FILESYSTEM_MCP_MAX_HTTP_SESSIONS',
    desc: 'Max concurrent HTTP sessions (default 100, 1–10000)',
  },
  {
    flags: 'FILESYSTEM_MCP_SESSION_IDLE_TIMEOUT_MS',
    desc: 'HTTP session idle timeout in ms (default 1800000, 1000–86400000)',
  },
  {
    flags: 'FILESYSTEM_MCP_RATE_LIMIT_RPM',
    desc: 'Per-client-IP requests/min on public HTTP bind (default 120, 1–100000)',
  },
  {
    flags: 'FS_CONTEXT_MAX_REQUEST_BYTES',
    desc: 'Max HTTP request body bytes (default 4194304, 1024–268435456)',
  },
  {
    flags: 'FILESYSTEM_MCP_MAX_WATCHERS',
    desc: 'Max concurrent file watchers (default 256, 1–4096)',
  },
  {
    flags: 'FS_CONTEXT_MAX_INLINE_MATCHES',
    desc: 'Max inline content matches per search (default 50, 1–10000)',
  },
  {
    flags: 'FS_INIT_HANDSHAKE_TIMEOUT_MS',
    desc: 'Init handshake timeout in ms (default 30000, 1000–300000)',
  },
  { flags: 'FS_INIT_TIMEOUT_CLOSE', desc: 'Truthy value closes the server on handshake timeout' },
  {
    flags: 'MAX_READ_MANY_TOTAL_SIZE',
    desc: 'Max total bytes across read_many (default 524288, 10240–104857600)',
  },
  { flags: 'DEFAULT_SEARCH_TIMEOUT', desc: 'Search timeout in ms (default 5000, 100–60000)' },
  { flags: 'NO_COLOR', desc: 'Any value disables ANSI color output' },
  {
    flags: 'FILESYSTEM_MCP_REQUEST_STATE_KEY',
    desc: 'HMAC key sealing input_required requestState across retry rounds (UTF-8, >=32 bytes; random per boot if unset)',
  },
];

const EXAMPLES_HELP = [
  '$ filesystem-mcp /path/to/allowed/dir',
  '$ filesystem-mcp --allow-cwd',
  '$ filesystem-mcp /project/src /project/tests --allow-cwd',
  '$ filesystem-mcp --port 3000 /path/to/allowed/dir',
  '$ filesystem-mcp --read-only /data/readonly',
  '$ filesystem-mcp --print-config --json /project',
];

function printHelpAndExit(): never {
  const { bold, dim, section, flag, placeholder, cyan } = cliFmt;
  const COL = 27;

  const optRow = (flags: string, desc: string): string => {
    const colored = flags
      .replace(/<[^>]+>/g, (m) => placeholder(m))
      .replace(/-{1,2}[\w-]+/g, (m) => flag(m));
    return `  ${padEndVisible(colored, COL)}${desc}`;
  };

  const envRow = (name: string, desc: string): string => {
    return `  ${padEndVisible(cyan(name), COL - 1)} ${desc}`;
  };

  const lines = [
    '',
    `${bold('Filesystem MCP')} ${dim(`v${SERVER_VERSION}`)}`,
    '',
    dim('Pass one or more directories to set the allowed access roots.'),
    '',
    section('Options:'),
    ...OPTIONS_HELP.map(({ flags, desc }) => optRow(flags, desc)),
    '',
    `${section('Environment variables:')} ${dim('(flags take precedence when both are set)')}`,
    ...ENV_HELP.map(({ flags, desc }) => envRow(flags, desc)),
    '',
    section('Examples:'),
    ...EXAMPLES_HELP.map((ex) => `  ${dim(ex)}`),
    '',
  ];

  process.stdout.write(lines.join('\n'));
  process.exit(0);
}

function printVersionAndExit(): never {
  process.stdout.write(`${cliFmt.cyan(SERVER_VERSION)}\n`);
  process.exit(0);
}

function normalizeCliExitMessage(error: unknown): string {
  const rawMessage = formatUnknownErrorMessage(error);
  return rawMessage.startsWith('Error:') ? rawMessage : `Error: ${rawMessage}`;
}

function deduplicateAllowedDirectories(dirs: readonly string[]): string[] {
  const seen = new Set<string>();
  const deduplicated: string[] = [];

  for (const dir of dirs) {
    const key = IS_WINDOWS ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    deduplicated.push(dir);
  }

  return deduplicated;
}

function parsePortOption(raw: unknown): number | undefined {
  if (raw === undefined) return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new CliExitError(`Error: --port must be an integer between 1 and 65535`, 1);
  }
  return n;
}

export const CLI_PARSER_CONFIG = {
  options: {
    'allow-cwd': { type: 'boolean', default: false },
    'read-only': { type: 'boolean', default: false },
    safe: { type: 'boolean', default: false },
    'print-config': { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
    port: { type: 'string' },
    help: { type: 'boolean', short: 'h' },
    version: { type: 'boolean', short: 'v' },
    'log-level': { type: 'string' },
    'log-format': { type: 'string' },
    'http-host': { type: 'string' },
    'api-key': { type: 'string' },
    'allow-sensitive': { type: 'boolean', default: false },
    'root-boundary': { type: 'string' },
    'max-file-size': { type: 'string' },
    'walk-cwd': { type: 'boolean', default: false },
    deny: { type: 'string', multiple: true },
    'allow-missing-roots': { type: 'boolean', default: false },
  },
  strict: true,
  allowPositionals: true,
} as const;

export async function parseArgs(): Promise<{
  allowedDirs: string[];
  allowCwd: boolean;
  port: number | undefined;
  readOnly: boolean;
  printConfig: boolean;
  json: boolean;
}> {
  try {
    const parsed = utilParseArgs(CLI_PARSER_CONFIG);

    if (parsed.values.help) {
      printHelpAndExit();
    }

    if (parsed.values.version) {
      printVersionAndExit();
    }

    for (const positional of parsed.positionals) {
      validateCliPath(positional);
    }

    const vals = parsed.values as Record<string, unknown>;
    // Both halves of these flag-or-env reads stay live even though
    // liftFlagsToEnv (index.ts) has already copied every flag into its env var
    // by the time the server calls this: the flag half covers parseArgs called
    // standalone (tests, --print-config), the env half covers an operator who
    // sets only the env var and passes no flag.
    const allowCwd =
      (vals['allow-cwd'] as boolean) ||
      (vals['walk-cwd'] as boolean) ||
      parseTrueEnvFlag(process.env['ALLOW_CWD_WALK']);
    const readOnly = (vals['read-only'] as boolean) || (vals['safe'] as boolean);
    const printConfig = vals['print-config'] as boolean;
    const json = vals['json'] as boolean;
    const port = parsePortOption(parsed.values.port);
    const allowMissingRoots =
      (vals['allow-missing-roots'] as boolean) ||
      parseTrueEnvFlag(process.env['ALLOW_MISSING_ROOTS']);

    let allowedDirs: string[] = [];
    try {
      allowedDirs =
        parsed.positionals.length > 0
          ? await normalizeAndValidateDirs(parsed.positionals, allowMissingRoots)
          : [];
    } catch (error: unknown) {
      throw new CliExitError(normalizeCliExitMessage(error), 1);
    }

    return {
      allowedDirs,
      allowCwd,
      port,
      readOnly,
      printConfig,
      json,
    };
  } catch (error: unknown) {
    if (error instanceof CliExitError) {
      throw error;
    }

    throw new CliExitError(normalizeCliExitMessage(error), 1);
  }
}

// ════════════════════════════════════════════════════════════
// Effective config reporting — prints the resolved server config
// ════════════════════════════════════════════════════════════

export interface EffectiveConfig {
  transport: string;
  readOnly: boolean;
  allowedRoots: string[];
  tools: string[];
  apiKey: string | null;
  limits: { maxFileSizeBytes: number };
}

export interface PrintConfigOptions {
  allowedDirs: string[];
  allowCwd: boolean;
  readOnly: boolean;
  json: boolean;
  apiKey?: string;
  stdout?: (chunk: string) => void;
}

export async function runPrintConfig(options: PrintConfigOptions): Promise<EffectiveConfig> {
  const write = options.stdout ?? ((s: string) => process.stdout.write(s));

  const pathGuard = new PathGuard({
    allowCwd: options.allowCwd,
    cliAllowedDirs: options.allowedDirs,
  });
  await pathGuard.recomputeAllowedDirectories();
  const allowedRoots = pathGuard.getAllowedDirectories();

  const tools = registeredTools(options.readOnly).map((t) => t.name);

  const config: EffectiveConfig = {
    transport: 'stdio',
    readOnly: options.readOnly,
    allowedRoots,
    tools,
    apiKey: options.apiKey ? '***' : null,
    limits: { maxFileSizeBytes: MAX_TEXT_FILE_SIZE },
  };

  if (options.json) {
    write(JSON.stringify(config, null, 2));
  } else {
    const key = (k: string) => padEndVisible(cliFmt.cyan(k), 14);
    write(`${key('transport:')}${config.transport}\n`);
    write(`${key('readOnly:')}${cliFmt.bool(config.readOnly)}\n`);
    write(`${key('apiKey:')}${cliFmt.dim(config.apiKey ?? 'none')}\n`);
    write(`${key('allowedRoots:')}${config.allowedRoots.join(', ') || cliFmt.dim('(none)')}\n`);
    write(`${key('tools:')}${cliFmt.dim(config.tools.join(', '))}\n`);
    write(`${key('maxFileSize:')}${cliFmt.yellow(String(config.limits.maxFileSizeBytes))}\n`);
  }

  return config;
}
