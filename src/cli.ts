import { randomUUID } from 'node:crypto';
import { existsSync, type Stats } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getSystemErrorMessage, getSystemErrorName, parseArgs as utilParseArgs } from 'node:util';

import { processInParallel } from './core/concurrency.js';
import { cliFmt, padEndVisible } from './core/fmt.js';
import {
  getReservedDeviceNameForPath,
  isSamePath,
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
const ENV_DIR_SEP = IS_WINDOWS ? ';' : ':';

// ════════════════════════════════════════════════════════════
// Path & Config Utilities — pure functions and error types
// ════════════════════════════════════════════════════════════

const CONFIG_KEY_MAP: Record<string, string> = {
  logLevel: 'LOG_LEVEL',
  httpHost: 'HTTP_HOST',
  apiKey: 'API_KEY',
  allowSensitive: 'ALLOW_SENSITIVE',
  rootBoundary: 'ROOT_BOUNDARY',
  maxFileSize: 'MAX_FILE_SIZE',
  walkCwd: 'ALLOW_CWD_WALK',
  allowMissingRoots: 'ALLOW_MISSING_ROOTS',
  deny: 'DENYLIST',
};

function resolveConfigKey(key: string): string {
  return CONFIG_KEY_MAP[key] ?? key;
}

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
    return deduplicateAllowedDirectories(results);
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

export interface ClientConfigTarget {
  name: string;
  path: string;
}

export function getExistingConfigPaths(
  env: Record<string, string | undefined> = process.env,
  osPlatform: string = platform(),
  homeDir: string = homedir(),
  exists: (p: string) => boolean = existsSync,
): ClientConfigTarget[] {
  const targets: ClientConfigTarget[] = [];
  const appData =
    env['APPDATA'] ?? (osPlatform === 'win32' ? join(homeDir, 'AppData', 'Roaming') : '');

  const addIfExist = (name: string, p: string) => {
    if (exists(p)) {
      targets.push({ name, path: p });
    }
  };

  // 1. Claude Code config
  addIfExist('Claude Code', join(homeDir, '.claude.json'));

  // 2. Claude Desktop config
  const claudeDesktopPath =
    osPlatform === 'win32'
      ? join(appData, 'Claude', 'claude_desktop_config.json')
      : osPlatform === 'darwin'
        ? join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json')
        : join(homeDir, '.config', 'Claude', 'claude_desktop_config.json');
  addIfExist('Claude Desktop', claudeDesktopPath);

  // 3. Cursor Global and Global MCP configs
  addIfExist('Cursor Global', join(homeDir, '.cursor', 'mcp.json'));
  addIfExist('Global MCP (.mcp.json)', join(homeDir, '.mcp.json'));
  addIfExist('Global MCP (.mcp/mcp.json)', join(homeDir, '.mcp', 'mcp.json'));

  // 4. VS Code Extensions (Cline, Roo Code) for stable and insiders
  const getVSCodeUserData = (prefix: string) => {
    if (osPlatform === 'win32') return join(appData, prefix, 'User');
    if (osPlatform === 'darwin')
      return join(homeDir, 'Library', 'Application Support', prefix, 'User');
    return join(homeDir, '.config', prefix, 'User');
  };

  const addExtensionConfig = (prefix: string, name: string, settingsPath: string) => {
    const isInsiders = prefix.includes('Insiders');
    const label = `VS Code${isInsiders ? ' Insiders' : ''} ${name} Extension`;
    addIfExist(label, join(getVSCodeUserData(prefix), 'globalStorage', settingsPath));
  };

  for (const prefix of ['Code', 'Code - Insiders']) {
    addExtensionConfig(prefix, 'Cline', 'saoudrizwan.claude-dev/settings/cline_mcp_settings.json');
    addExtensionConfig(prefix, 'Roo Code', 'rooveterinaryinc.roo-cline/settings/mcp_settings.json');
  }

  return targets;
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const content = JSON.stringify(data, null, 2) + '\n';
  const tempPath = `${filePath}.${randomUUID().replace(/-/g, '').slice(0, 12)}.tmp`;

  try {
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    process.stderr.write(
      `${cliFmt.stderrWarn(`Atomic write failed for ${filePath}. Falling back to direct write (non-atomic).`)}\n`,
    );
    try {
      await unlink(tempPath);
    } catch (unlinkErr) {
      const unlinkMsg = unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr);
      process.stderr.write(
        `${cliFmt.stderrWarn(`Failed to remove temp file ${tempPath}: ${unlinkMsg}`)}\n`,
      );
    }
    try {
      await writeFile(filePath, content, 'utf8');
    } catch (fallbackError) {
      const origMsg = error instanceof Error ? error.message : String(error);
      const fallbackMsg =
        fallbackError instanceof Error ? fallbackError.message : String(fallbackError);
      throw new Error(
        `Failed to write configuration atomically, and fallback write also failed.\nOriginal error: ${origMsg}\nFallback error: ${fallbackMsg}`,
        { cause: fallbackError },
      );
    }
  }
}

export interface ModifyOptions {
  client?: string | undefined;
  config?: string | undefined;
  serverName?: string | undefined;
  dryRun?: boolean | undefined;
  json?: boolean | undefined;
}

function findServerEntry(
  mcpServers: Record<string, unknown> | undefined,
  serverNameOpt?: string,
): { key: string; entry: Record<string, unknown> } | null {
  if (!mcpServers || typeof mcpServers !== 'object') return null;

  const getValidEntry = (key: string): Record<string, unknown> | null => {
    const entry = mcpServers[key];
    return entry && typeof entry === 'object' ? (entry as Record<string, unknown>) : null;
  };

  // 1. Explicit server name request
  if (serverNameOpt) {
    const entry = getValidEntry(serverNameOpt);
    if (entry) return { key: serverNameOpt, entry };
  }

  // 2. Default standard keys
  for (const key of ['filesystem', 'filesystem-mcp']) {
    const entry = getValidEntry(key);
    if (entry) return { key, entry };
  }

  // 3. Fallback: inspect command or arguments containing 'filesystem-mcp'
  for (const [key, entry] of Object.entries(mcpServers)) {
    if (entry && typeof entry === 'object') {
      const entryObj = entry as Record<string, unknown>;
      const cmd = typeof entryObj['command'] === 'string' ? entryObj['command'] : '';
      const args = Array.isArray(entryObj['args']) ? entryObj['args'].map(String).join(' ') : '';
      if (cmd.includes('filesystem-mcp') || args.includes('filesystem-mcp')) {
        return { key, entry: entryObj };
      }
    }
  }

  return null;
}

async function acquireLock(
  lockFilePath: string,
  retries = 10,
  delay = 100,
  staleLockMs = 30_000,
): Promise<() => Promise<void>> {
  for (let i = 0; i < retries; i++) {
    try {
      const handle = await open(lockFilePath, 'wx');
      await handle.close();
      return async () => {
        try {
          await unlink(lockFilePath);
        } catch (releaseErr) {
          const releaseMsg = releaseErr instanceof Error ? releaseErr.message : String(releaseErr);
          process.stderr.write(
            `${cliFmt.stderrWarn(`Failed to release lock file ${lockFilePath}: ${releaseMsg}`)}\n`,
          );
        }
      };
    } catch (error) {
      if (isRecord(error) && error['code'] === 'EEXIST') {
        try {
          const lockStat = await stat(lockFilePath);
          if (Date.now() - lockStat.mtimeMs > staleLockMs) {
            process.stderr.write(
              `${cliFmt.stderrWarn(`Removing stale lock file ${lockFilePath}.`)}\n`,
            );
            await unlink(lockFilePath).catch((_: unknown) => undefined);
            continue;
          }
        } catch {
          // Lock may have been released between EEXIST and stat — just retry.
        }
        await new Promise<void>((resolve) => {
          setTimeout(resolve, delay);
        });
        continue;
      }
      throw error;
    }
  }
  throw new Error(`Failed to acquire lock on config file: ${lockFilePath}`);
}

async function readOrCreateConfig(filePath: string): Promise<Record<string, unknown>> {
  if (!existsSync(filePath)) {
    return { mcpServers: {} };
  }
  try {
    const content = await readFile(filePath, 'utf8');
    return JSON.parse(content) as Record<string, unknown>;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    throw new CliExitError(`Failed to parse configuration file ${filePath}: ${msg}`, 1);
  }
}

function tryComparePaths(arg: string, targetPath: string): boolean {
  try {
    return isAbsolute(arg) && isSamePath(arg, targetPath);
  } catch (compareErr) {
    const msg = compareErr instanceof Error ? compareErr.message : String(compareErr);
    process.stderr.write(
      `${cliFmt.stderrWarn(`Could not compare path '${arg}' with '${targetPath}': ${msg}`)}\n`,
    );
    return false;
  }
}

function readDirsFromEnv(entry: Record<string, unknown>): string[] {
  const env = isRecord(entry['env']) ? entry['env'] : {};
  const raw = typeof env['FS_ALLOWED_DIRS'] === 'string' ? env['FS_ALLOWED_DIRS'] : '';
  return raw
    .split(ENV_DIR_SEP)
    .map((s) => s.trim())
    .filter(Boolean);
}

function updateEnvForPath(
  entry: Record<string, unknown>,
  action: 'allow' | 'disallow',
  targetPath: string,
): boolean {
  if (!isRecord(entry['env'])) {
    entry['env'] = {};
  }
  const env = entry['env'] as Record<string, unknown>;
  const current = readDirsFromEnv(entry);

  if (action === 'allow') {
    if (current.some((d) => tryComparePaths(d, targetPath))) return false;
    env['FS_ALLOWED_DIRS'] = [...current, targetPath].join(ENV_DIR_SEP);
    return true;
  } else {
    const filtered = current.filter((d) => !tryComparePaths(d, targetPath));
    if (filtered.length === current.length) return false;
    if (filtered.length === 0) {
      delete env['FS_ALLOWED_DIRS'];
    } else {
      env['FS_ALLOWED_DIRS'] = filtered.join(ENV_DIR_SEP);
    }
    return true;
  }
}

async function modifySingleConfig(
  filePath: string,
  action: 'allow' | 'disallow',
  targetPath: string,
  options: ModifyOptions,
): Promise<boolean> {
  const lockFilePath = `${filePath}.lock`;
  let release: (() => Promise<void>) | undefined;

  try {
    if (!options.dryRun) {
      await mkdir(dirname(filePath), { recursive: true });
      release = await acquireLock(lockFilePath);
    }

    const configData = await readOrCreateConfig(filePath);
    const mcpServersKey =
      !configData['mcpServers'] && configData['servers'] ? 'servers' : 'mcpServers';
    configData[mcpServersKey] ??= {};

    const mcpServers = configData[mcpServersKey] as Record<string, unknown>;
    const matched = findServerEntry(mcpServers, options.serverName);

    const key = matched ? matched.key : (options.serverName ?? 'filesystem');
    let entry = matched ? matched.entry : null;

    if (!entry) {
      if (action === 'disallow') {
        return false;
      }
      entry = {
        command: 'npx',
        args: ['-y', '@j0hanz/filesystem-mcp'],
        env: {},
      };
      mcpServers[key] = entry;
    }

    const cmdVal = entry['command'];
    const cmdStr = typeof cmdVal === 'string' ? cmdVal : '';
    if (cmdStr.includes('docker') && action === 'allow') {
      process.stderr.write(
        `${cliFmt.stderrWarn(`Server '${key}' in config ${filePath} appears to be running via Docker. Path allowance via env.FS_ALLOWED_DIRS might not map correctly inside the container.`)}\n`,
      );
    }

    const changed = updateEnvForPath(entry, action, targetPath);
    if (changed && !options.dryRun) {
      await writeJsonAtomic(filePath, configData);
    }

    return changed;
  } finally {
    if (release) {
      await release();
    }
  }
}

function getTargetConfigs(options: ModifyOptions): ClientConfigTarget[] {
  const targets = getExistingConfigPaths();
  const clientOpt = options.client;
  if (!clientOpt) {
    return targets;
  }
  const search = clientOpt.toLowerCase();
  return targets.filter((t) => t.name.toLowerCase().includes(search));
}

export async function allowPath(pathToAdd: string, options: ModifyOptions = {}): Promise<void> {
  validateCliPath(pathToAdd);
  const resolvedPath = resolve(pathToAdd);
  const prefix = options.dryRun ? '[dry-run] ' : '';

  if (options.config) {
    const added = await modifySingleConfig(options.config, 'allow', resolvedPath, options);
    const msg = added
      ? cliFmt.success(
          `${prefix}Authorized ${cliFmt.pathStr(`'${resolvedPath}'`)} → ${options.config}`,
        )
      : `${cliFmt.pathStr(`'${resolvedPath}'`)} is already authorized in ${options.config}`;
    process.stdout.write(`${msg}\n`);
    return;
  }

  const filtered = getTargetConfigs(options);
  if (filtered.length === 0) {
    const hint = options.client
      ? `No configuration file found for client matching '${options.client}'.`
      : 'No supported MCP configuration files were found on this system.';
    throw new CliExitError(`${hint} Use --config <path> to target a specific file explicitly.`, 1);
  }

  for (const target of filtered) {
    const added = await modifySingleConfig(target.path, 'allow', resolvedPath, options);
    const msg = added
      ? cliFmt.success(
          `${prefix}Authorized ${cliFmt.pathStr(`'${resolvedPath}'`)} → ${target.name} ${cliFmt.dim(`(${target.path})`)}`,
        )
      : `${cliFmt.pathStr(`'${resolvedPath}'`)} is already authorized in ${target.name}`;
    process.stdout.write(`${msg}\n`);
  }
}

export async function disallowPath(
  pathToRemove: string,
  options: ModifyOptions = {},
): Promise<void> {
  validateCliPath(pathToRemove);
  const resolvedPath = resolve(pathToRemove);
  const prefix = options.dryRun ? '[dry-run] ' : '';

  if (options.config) {
    const removed = await modifySingleConfig(options.config, 'disallow', resolvedPath, options);
    if (removed) {
      process.stdout.write(
        `${cliFmt.success(`${prefix}Removed ${cliFmt.pathStr(`'${resolvedPath}'`)} from ${options.config}`)}\n`,
      );
    } else {
      process.stderr.write(
        `${cliFmt.stderrWarn(`Path '${resolvedPath}' was not found in ${options.config}`)}\n`,
      );
    }
    return;
  }

  const filtered = getTargetConfigs(options);
  let anyModified = false;
  for (const target of filtered) {
    if (await modifySingleConfig(target.path, 'disallow', resolvedPath, options)) {
      anyModified = true;
      process.stdout.write(
        `${cliFmt.success(`${prefix}Removed ${cliFmt.pathStr(`'${resolvedPath}'`)} from ${target.name} ${cliFmt.dim(`(${target.path})`)}`)}\n`,
      );
    }
  }
  if (!anyModified) {
    process.stderr.write(
      `${cliFmt.stderrWarn(`Path '${resolvedPath}' was not found in any configuration.`)}\n`,
    );
  }
}

export async function listAllowedPaths(options: ModifyOptions = {}): Promise<string[]> {
  const seen = new Set<string>();
  const allPaths: string[] = [];

  const getPathsFromFile = async (filePath: string): Promise<string[]> => {
    if (!existsSync(filePath)) return [];
    try {
      const content = await readFile(filePath, 'utf8');
      const configData = JSON.parse(content) as Record<string, unknown>;
      const mcpServers = (configData['mcpServers'] ?? configData['servers']) as
        | Record<string, unknown>
        | undefined;
      const matched = findServerEntry(mcpServers, options.serverName);
      if (matched?.entry) {
        return readDirsFromEnv(matched.entry);
      }
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `${cliFmt.stderrWarn(`Skipping ${filePath} — could not parse (results may be incomplete): ${msg}`)}\n`,
      );
    }
    return [];
  };

  if (options.config) {
    return await getPathsFromFile(options.config);
  }

  const filtered = getTargetConfigs(options);
  for (const target of filtered) {
    const paths = await getPathsFromFile(target.path);
    for (const p of paths) {
      const key = IS_WINDOWS ? p.toLowerCase() : p;
      if (!seen.has(key)) {
        seen.add(key);
        allPaths.push(p);
      }
    }
  }

  return allPaths;
}

async function modifyConfig(
  filePath: string,
  action: 'set' | 'get' | 'list' | 'reset',
  envVar: string | undefined,
  value: string | undefined,
  options: ModifyOptions,
): Promise<void> {
  const lockFilePath = `${filePath}.lock`;
  let release: (() => Promise<void>) | undefined;

  try {
    if (action !== 'get' && action !== 'list' && !options.dryRun) {
      await mkdir(dirname(filePath), { recursive: true });
      release = await acquireLock(lockFilePath);
    }

    const configData = await readOrCreateConfig(filePath);
    const mcpServersKey =
      !configData['mcpServers'] && configData['servers'] ? 'servers' : 'mcpServers';
    configData[mcpServersKey] ??= {};

    const mcpServers = configData[mcpServersKey] as Record<string, unknown>;
    const matched = findServerEntry(mcpServers, options.serverName);

    if (!matched) {
      if (action === 'get' || action === 'list' || action === 'reset') {
        process.stdout.write('(no server entry found)\n');
        return;
      }
      if (!envVar) throw new CliExitError('Key is required for config set', 1);
      const entryKey = options.serverName ?? 'filesystem';
      const newEntry: Record<string, unknown> = {
        command: 'npx',
        args: ['-y', '@j0hanz/filesystem-mcp'],
        env: { [envVar]: value ?? '' },
      };
      mcpServers[entryKey] = newEntry;
      if (!options.dryRun) {
        await writeJsonAtomic(filePath, configData);
      }
      process.stdout.write(`${cliFmt.success(`Set ${envVar} = ${value ?? ''}`)}\n`);
      return;
    }

    const { entry } = matched;
    if (!isRecord(entry['env'])) {
      entry['env'] = {};
    }
    const env = entry['env'] as Record<string, unknown>;

    if (action === 'set') {
      if (!envVar) throw new CliExitError('Key is required for config set', 1);
      env[envVar] = value ?? '';
      if (!options.dryRun) await writeJsonAtomic(filePath, configData);
      process.stdout.write(`${cliFmt.success(`Set ${envVar} = ${value ?? ''}`)}\n`);
    } else if (action === 'get') {
      if (!envVar) throw new CliExitError('Key is required for config get', 1);
      const val = env[envVar];
      process.stdout.write(
        val !== undefined
          ? `${typeof val === 'string' ? val : JSON.stringify(val)}\n`
          : '(not set)\n',
      );
    } else if (action === 'list') {
      const keys = Object.keys(env);
      if (keys.length === 0) {
        process.stdout.write('(no env vars configured)\n');
      } else {
        for (const k of keys) {
          process.stdout.write(`${k}=${String(env[k])}\n`);
        }
      }
    } else {
      if (!envVar) throw new CliExitError('Key is required for config reset', 1);
      if (!(envVar in env)) {
        process.stdout.write(`(${envVar} was not set)\n`);
        return;
      }
      Reflect.deleteProperty(env, envVar);
      if (Object.keys(env).length === 0) delete entry['env'];
      if (!options.dryRun) await writeJsonAtomic(filePath, configData);
      process.stdout.write(`${cliFmt.success(`Removed ${envVar}`)}\n`);
    }
  } finally {
    if (release) await release();
  }
}

export async function manageConfig(
  action: 'set' | 'get' | 'list' | 'reset',
  key: string | undefined,
  value: string | undefined,
  options: ModifyOptions = {},
): Promise<void> {
  const envVar = key !== undefined ? resolveConfigKey(key) : undefined;

  if (options.config) {
    await modifyConfig(options.config, action, envVar, value, options);
    return;
  }

  const filtered = getTargetConfigs(options);
  if (filtered.length === 0) {
    const hint = options.client
      ? `No configuration file found for client matching '${options.client}'.`
      : 'No supported MCP configuration files were found on this system.';
    throw new CliExitError(`${hint} Use --config <path> to target a specific file explicitly.`, 1);
  }

  for (const target of filtered) {
    if (filtered.length > 1) {
      process.stdout.write(`\n${cliFmt.dim(target.name)} ${cliFmt.dim(`(${target.path})`)}\n`);
    }
    await modifyConfig(target.path, action, envVar, value, options);
  }
}
