import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { getSystemErrorMessage, getSystemErrorName, parseArgs as utilParseArgs } from 'node:util';

import { processInParallel } from './core/concurrency.js';
import { cliFmt, padEndVisible } from './core/fmt.js';
import {
  getReservedDeviceNameForPath,
  isWindowsDriveRelativePath,
  normalizePath,
  PathGuard,
} from './core/path.js';
import { isRecord, parseTrueEnvFlag } from './core/primitives.js';
import {
  MAX_SEARCHABLE_FILE_SIZE,
  MAX_TEXT_FILE_SIZE,
  SEARCH_WORKERS,
  WORKER_POOL_MAX,
} from './core/util.js';
import { pkgInfo } from './pkg-info.js';
import { ALL_REGISTERED_TOOL_NAMES, MUTATING_TOOL_NAMES } from './tools/index.js';

const { version: SERVER_VERSION } = pkgInfo;
export const IS_WINDOWS = process.platform === 'win32';
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

export function validateCliPath(inputPath: string): void {
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
  { flags: '--read-only', desc: 'Disable write tools: create, edit, delete, move, replace' },
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
  { flags: '--http-host <host>', desc: 'HTTP server bind address (env: HTTP_HOST)' },
  {
    flags: '--api-key <key>',
    desc: 'Require this API key on HTTP requests (env: API_KEY)',
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

const ENV_HELP: HelpRow[] = [
  { flags: 'LOG_LEVEL', desc: 'Log level: debug|info|warn|error' },
  { flags: 'HTTP_HOST', desc: 'HTTP bind address' },
  { flags: 'API_KEY', desc: 'HTTP API key' },
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
    return `  ${padEndVisible(cyan(name), COL)}${desc}`;
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
  const rawMessage = error instanceof Error ? error.message : String(error);
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

const CLI_PARSER_CONFIG = {
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
    'http-host': { type: 'string' },
    'api-key': { type: 'string' },
    'allow-sensitive': { type: 'boolean', default: false },
    'root-boundary': { type: 'string' },
    'max-file-size': { type: 'string' },
    'walk-cwd': { type: 'boolean', default: false },
    deny: { type: 'string', multiple: true },
    'allow-missing-roots': { type: 'boolean', default: false },
    client: { type: 'string' },
    config: { type: 'string' },
    'server-name': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
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
  walkCwd: boolean;
  allowMissingRoots: boolean;
  subcommand: 'allow' | 'disallow' | 'list-allowed' | 'config' | undefined;
  subcommandPath: string | undefined;
  configAction: 'set' | 'get' | 'list' | 'reset' | undefined;
  configKey: string | undefined;
  configValue: string | undefined;
  client: string | undefined;
  config: string | undefined;
  serverName: string | undefined;
  dryRun: boolean;
}> {
  try {
    const parsed = utilParseArgs(CLI_PARSER_CONFIG);

    if (parsed.values.help) {
      printHelpAndExit();
    }

    if (parsed.values.version) {
      printVersionAndExit();
    }

    const firstPos = parsed.positionals[0];
    let subcommand: 'allow' | 'disallow' | 'list-allowed' | 'config' | undefined;
    let subcommandPath: string | undefined;
    let configAction: 'set' | 'get' | 'list' | 'reset' | undefined;
    let configKey: string | undefined;
    let configValue: string | undefined;

    if (firstPos === 'allow' || firstPos === 'disallow' || firstPos === 'list-allowed') {
      subcommand = firstPos;
      if (subcommand === 'allow' || subcommand === 'disallow') {
        subcommandPath = parsed.positionals[1];
        if (subcommandPath !== undefined) {
          validateCliPath(subcommandPath);
        }
      }
    } else if (firstPos === 'config') {
      subcommand = 'config';
      const action = parsed.positionals[1];
      if (action === 'set' || action === 'get' || action === 'list' || action === 'reset') {
        configAction = action;
        configKey = parsed.positionals[2];
        configValue = parsed.positionals[3];
      } else if (action !== undefined) {
        throw new CliExitError(`Unknown config action '${action}'. Use: set, get, list, reset`, 1);
      }
    } else {
      for (const positional of parsed.positionals) {
        validateCliPath(positional);
      }
    }

    const vals = parsed.values as Record<string, unknown>;
    const walkCwd =
      (vals['walk-cwd'] as boolean) || parseTrueEnvFlag(process.env['ALLOW_CWD_WALK']);
    const allowCwd = (vals['allow-cwd'] as boolean) || walkCwd;
    const readOnly = (vals['read-only'] as boolean) || (vals['safe'] as boolean);
    const printConfig = vals['print-config'] as boolean;
    const json = vals['json'] as boolean;
    const port = parsePortOption(parsed.values.port);
    const allowMissingRoots =
      (vals['allow-missing-roots'] as boolean) ||
      parseTrueEnvFlag(process.env['ALLOW_MISSING_ROOTS']);

    const client = vals['client'] as string | undefined;
    const config = vals['config'] as string | undefined;
    const serverName = vals['server-name'] as string | undefined;
    const dryRun = vals['dry-run'] as boolean;

    let allowedDirs: string[] = [];
    if (!subcommand) {
      try {
        allowedDirs =
          parsed.positionals.length > 0
            ? await normalizeAndValidateDirs(parsed.positionals, allowMissingRoots)
            : [];
      } catch (error: unknown) {
        throw new CliExitError(normalizeCliExitMessage(error), 1);
      }
    }

    return {
      allowedDirs,
      allowCwd,
      port,
      readOnly,
      printConfig,
      json,
      walkCwd,
      allowMissingRoots,
      subcommand,
      subcommandPath,
      configAction,
      configKey,
      configValue,
      client,
      config,
      serverName,
      dryRun,
    };
  } catch (error: unknown) {
    if (error instanceof CliExitError) {
      throw error;
    }

    throw new CliExitError(normalizeCliExitMessage(error), 1);
  }
}

// ════════════════════════════════════════════════════════════
// Config File Management — reads/writes MCP client config files
// ════════════════════════════════════════════════════════════

export interface EffectiveConfig {
  transport: string;
  readOnly: boolean;
  allowedRoots: string[];
  tools: string[];
  apiKey: string | null;
  limits: {
    maxFileSizeBytes: number;
    maxSearchFileSizeBytes: number;
    searchWorkers: number;
    workerPoolMax: number;
  };
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

  const tools = ALL_REGISTERED_TOOL_NAMES.filter(
    (name) => !options.readOnly || !MUTATING_TOOL_NAMES.has(name),
  );

  const config: EffectiveConfig = {
    transport: 'stdio',
    readOnly: options.readOnly,
    allowedRoots,
    tools: [...tools],
    apiKey: options.apiKey ? '***' : null,
    limits: {
      maxFileSizeBytes: MAX_TEXT_FILE_SIZE,
      maxSearchFileSizeBytes: MAX_SEARCHABLE_FILE_SIZE,
      searchWorkers: SEARCH_WORKERS,
      workerPoolMax: WORKER_POOL_MAX,
    },
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
    write(`${key('maxSearch:')}${cliFmt.yellow(String(config.limits.maxSearchFileSizeBytes))}\n`);
    write(`${key('workers:')}${cliFmt.yellow(String(config.limits.searchWorkers))}\n`);
  }

  return config;
}

