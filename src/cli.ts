import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { getSystemErrorMessage, getSystemErrorName, parseArgs as utilParseArgs } from 'node:util';

import { processInParallel } from './core/concurrency.js';
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
const IS_WINDOWS = process.platform === 'win32';
const CLI_VALIDATE_CONCURRENCY = 8;

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

function getNodeErrorProperty(error: unknown, key: 'code' | 'errno'): string | number | undefined {
  if (!isRecord(error)) return undefined;
  const value = error[key];
  if (typeof value === 'string' || typeof value === 'number') {
    return value;
  }
  return undefined;
}

function getNodeErrorCode(error: unknown): string | undefined {
  const code = getNodeErrorProperty(error, 'code');
  return typeof code === 'string' ? code : undefined;
}

function getNodeErrorErrno(error: unknown): number | undefined {
  const errno = getNodeErrorProperty(error, 'errno');
  return typeof errno === 'number' ? errno : undefined;
}

function normalizeDirectoryError(error: unknown, inputPath: string): Error {
  const code = getNodeErrorCode(error);
  const errno = getNodeErrorErrno(error);
  if (error instanceof Error && code === undefined && errno === undefined) {
    return error;
  }

  if (typeof errno === 'number') {
    try {
      const name = getSystemErrorName(errno);
      const message = getSystemErrorMessage(errno);
      return new Error(`Cannot access directory ${inputPath} (${name}: ${message})`);
    } catch {
      // Fall through to best-effort formatting.
    }
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
    return deduplicateAllowedDirectories(results);
  }
  let first = errors[0];
  for (const failure of errors) {
    if (first && failure.index < first.index) {
      first = failure;
    }
  }
  throw first?.error ?? new Error('Failed to validate directories');
}

async function normalizeCliDirectories(
  args: readonly string[],
  allowMissing = false,
): Promise<string[]> {
  return normalizeAndValidateDirs(args, allowMissing);
}

function printHelpAndExit(): never {
  const help = `filesystem-mcp [options] [allowedDirs...]

MCP filesystem server. Positional directories define allowed access roots.

Options:
  -h, --help                 Display command help
  -v, --version              Display server version
  --allow-cwd                Allow the current working directory as an additional root
  --port <number>            Enable HTTP transport on the given port (Node Streamable HTTP)
  --read-only                Disable all mutating tools (create, edit, delete, move, replace)
  --safe                     Alias for --read-only
  --print-config             Print effective configuration and exit (combine with --json)
  --json                     Output --print-config as JSON instead of human-readable text
  --log-level <level>        Set log level: debug|info|warn|error (env: FILESYSTEM_MCP_LOG_LEVEL)
  --http-host <host>         Bind HTTP server to host (env: FILESYSTEM_MCP_HTTP_HOST)
  --api-key <key>            Require this API key for HTTP requests (env: FILESYSTEM_MCP_API_KEY)
  --allow-sensitive          Allow access to sensitive system paths (env: FS_CONTEXT_ALLOW_SENSITIVE)
  --root-boundary <path>     Restrict allowed roots to be under this path (env: FS_ROOT_BOUNDARY)
  --max-file-size <bytes>    Override maximum file size for reads (env: MAX_FILE_SIZE)
  --walk-cwd                 Walk up from CWD to find project root (requires --allow-cwd or implies it)
  --deny <pattern>           Deny access to paths matching this pattern (can be specified multiple times)
  --allow-missing-roots      Do not fail startup if configured allowed directories do not exist

Environment variables (overridden by flags when both are set):
  FILESYSTEM_MCP_LOG_LEVEL   Log verbosity (debug|info|warn|error)
  FILESYSTEM_MCP_HTTP_HOST   HTTP bind host
  FILESYSTEM_MCP_API_KEY     HTTP API key
  FS_CONTEXT_ALLOW_SENSITIVE Allow sensitive system paths (set to any value to enable)
  FS_ROOT_BOUNDARY           Path prefix that all allowed roots must fall under
  MAX_FILE_SIZE              Maximum file size in bytes for read operations
  FS_ALLOWED_DIRS            Colon-separated (Unix) or semicolon-separated (Windows) allowed dirs
  FS_ALLOW_CWD_WALK          Walk up from CWD to find project root (set to any value to enable)
  FS_CONTEXT_DENYLIST        Comma-separated list of paths/patterns to deny access to
  FS_ALLOW_MISSING_ROOTS     Do not fail startup if configured allowed directories do not exist (set to any value to enable)

Examples:
  $ filesystem-mcp /path/to/allowed/dir
  $ filesystem-mcp --allow-cwd
  $ filesystem-mcp /project/src /project/tests --allow-cwd
  $ filesystem-mcp --port 3000 /path/to/allowed/dir
  $ filesystem-mcp --read-only /data/readonly
  $ filesystem-mcp --print-config --json /project
`;
  process.stdout.write(help);
  process.exit(0);
}

function printVersionAndExit(): never {
  process.stdout.write(`${SERVER_VERSION}\n`);
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

export async function parseArgs(): Promise<{
  allowedDirs: string[];
  allowCwd: boolean;
  port: number | undefined;
  readOnly: boolean;
  printConfig: boolean;
  json: boolean;
  walkCwd: boolean;
  allowMissingRoots: boolean;
}> {
  try {
    const parsed = utilParseArgs({
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
      },
      strict: true,
      allowPositionals: true,
    });

    if (parsed.values.help) {
      printHelpAndExit();
    }

    if (parsed.values.version) {
      printVersionAndExit();
    }

    const positionals = parsed.positionals;
    for (const positional of positionals) {
      validateCliPath(positional);
    }

    const vals = parsed.values as Record<string, unknown>;
    const walkCwd =
      (vals['walk-cwd'] as boolean) || parseTrueEnvFlag(process.env['FS_ALLOW_CWD_WALK']);
    const allowCwd = (vals['allow-cwd'] as boolean) || walkCwd;
    const readOnly = (vals['read-only'] as boolean) || (vals['safe'] as boolean);
    const printConfig = vals['print-config'] as boolean;
    const json = vals['json'] as boolean;
    const port = parsePortOption(parsed.values.port);
    const allowMissingRoots =
      (vals['allow-missing-roots'] as boolean) ||
      parseTrueEnvFlag(process.env['FS_ALLOW_MISSING_ROOTS']);

    let allowedDirs: string[];
    try {
      allowedDirs =
        positionals.length > 0 ? await normalizeCliDirectories(positionals, allowMissingRoots) : [];
    } catch (error: unknown) {
      throw new CliExitError(normalizeCliExitMessage(error), 1);
    }

    const deduplicatedDirs = deduplicateAllowedDirectories(allowedDirs);

    return {
      allowedDirs: deduplicatedDirs,
      allowCwd,
      port,
      readOnly,
      printConfig,
      json,
      walkCwd,
      allowMissingRoots,
    };
  } catch (error: unknown) {
    if (error instanceof CliExitError) {
      throw error;
    }

    // Handle parsing errors from util.parseArgs
    const message = error instanceof Error ? error.message : String(error);
    const formattedMessage = message.startsWith('Error:') ? message : `Error: ${message}`;
    throw new CliExitError(formattedMessage, 1);
  }
}

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
    write(`transport:    ${config.transport}\n`);
    write(`readOnly:     ${String(config.readOnly)}\n`);
    write(`apiKey:       ${config.apiKey ?? 'none'}\n`);
    write(`allowedRoots: ${config.allowedRoots.join(', ') || '(none)'}\n`);
    write(`tools:        ${config.tools.join(', ')}\n`);
    write(`maxFileSize:  ${config.limits.maxFileSizeBytes}\n`);
    write(`maxSearch:    ${config.limits.maxSearchFileSizeBytes}\n`);
    write(`workers:      ${config.limits.searchWorkers}\n`);
  }

  return config;
}
