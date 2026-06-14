import { existsSync, type Stats } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { getSystemErrorMessage, getSystemErrorName, parseArgs as utilParseArgs } from 'node:util';

import { processInParallel } from './core/concurrency.js';
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
      // Fall through, but preserve the raw errno value.
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

Filesystem MCP server. Pass one or more directories to set the allowed access roots.

Options:
  -h, --help                 Show this help message
  -v, --version              Show the server version
  --allow-cwd                Add the current working directory as an allowed root
  --port <number>            Start HTTP transport on this port (Node Streamable HTTP)
  --read-only                Disable write tools: create, edit, delete, move, replace
  --safe                     Alias for --read-only
  --print-config             Print the active configuration and exit (use with --json for machine output)
  --json                     Output --print-config as JSON
  --log-level <level>        Log level: debug|info|warn|error (env: FILESYSTEM_MCP_LOG_LEVEL)
  --http-host <host>         HTTP server bind address (env: FILESYSTEM_MCP_HTTP_HOST)
  --api-key <key>            Require this API key on HTTP requests (env: FILESYSTEM_MCP_API_KEY)
  --allow-sensitive          Allow access to sensitive system paths (env: FS_CONTEXT_ALLOW_SENSITIVE)
  --root-boundary <path>     Require all allowed roots to fall under this path (env: FS_ROOT_BOUNDARY)
  --max-file-size <bytes>    Maximum file size for reads in bytes (env: MAX_FILE_SIZE)
  --walk-cwd                 Walk up from CWD to find a project root; implies --allow-cwd
  --deny <pattern>           Block paths matching this pattern; repeatable
  --allow-missing-roots      Start even if configured allowed directories do not exist

Environment variables (flags take precedence when both are set):
  FILESYSTEM_MCP_LOG_LEVEL   Log level: debug|info|warn|error
  FILESYSTEM_MCP_HTTP_HOST   HTTP bind address
  FILESYSTEM_MCP_API_KEY     HTTP API key
  FS_CONTEXT_ALLOW_SENSITIVE Allow sensitive system paths (any value enables this)
  FS_ROOT_BOUNDARY           Path prefix all allowed roots must fall under
  MAX_FILE_SIZE              Maximum file size for reads in bytes
  FS_ALLOWED_DIRS            Allowed dirs: colon-separated (Unix), semicolon-separated (Windows)
  FS_ALLOW_CWD_WALK          Walk up from CWD to find a project root (any value enables this)
  FS_CONTEXT_DENYLIST        Paths/patterns to block, comma-separated
  FS_ALLOW_MISSING_ROOTS     Start even if configured allowed directories do not exist (any value enables this)

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
  subcommand: 'allow' | 'disallow' | 'list-allowed' | undefined;
  subcommandPath: string | undefined;
  client: string | undefined;
  config: string | undefined;
  serverName: string | undefined;
  dryRun: boolean;
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
        client: { type: 'string' },
        config: { type: 'string' },
        'server-name': { type: 'string' },
        'dry-run': { type: 'boolean', default: false },
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

    const firstPos = parsed.positionals[0];
    let subcommand: 'allow' | 'disallow' | 'list-allowed' | undefined;
    let subcommandPath: string | undefined;

    if (firstPos === 'allow' || firstPos === 'disallow' || firstPos === 'list-allowed') {
      subcommand = firstPos;
      if (subcommand === 'allow' || subcommand === 'disallow') {
        subcommandPath = parsed.positionals[1];
        if (subcommandPath !== undefined) {
          validateCliPath(subcommandPath);
        }
      }
    } else {
      const positionals = parsed.positionals;
      for (const positional of positionals) {
        validateCliPath(positional);
      }
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

    const client = vals['client'] as string | undefined;
    const config = vals['config'] as string | undefined;
    const serverName = vals['server-name'] as string | undefined;
    const dryRun = vals['dry-run'] as boolean;

    let allowedDirs: string[] = [];
    if (!subcommand) {
      try {
        allowedDirs =
          parsed.positionals.length > 0
            ? await normalizeCliDirectories(parsed.positionals, allowMissingRoots)
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
      client,
      config,
      serverName,
      dryRun,
    };
  } catch (error: unknown) {
    if (error instanceof CliExitError) {
      throw error;
    }

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

  // 1. Claude Desktop config
  if (osPlatform === 'win32') {
    addIfExist('Claude Desktop', join(appData, 'Claude', 'claude_desktop_config.json'));
  } else if (osPlatform === 'darwin') {
    addIfExist(
      'Claude Desktop',
      join(homeDir, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    );
  } else {
    addIfExist('Claude Desktop', join(homeDir, '.config', 'Claude', 'claude_desktop_config.json'));
  }

  // 2. Cursor Global config
  addIfExist('Cursor Global', join(homeDir, '.cursor', 'mcp.json'));

  // 3. Global MCP (.mcp.json)
  addIfExist('Global MCP (.mcp.json)', join(homeDir, '.mcp.json'));
  addIfExist('Global MCP (.mcp/mcp.json)', join(homeDir, '.mcp', 'mcp.json'));

  // 4. VS Code Extensions (Cline, Roo Code)
  const vscodeUserData =
    osPlatform === 'win32'
      ? join(appData, 'Code', 'User')
      : osPlatform === 'darwin'
        ? join(homeDir, 'Library', 'Application Support', 'Code', 'User')
        : join(homeDir, '.config', 'Code', 'User');

  // Cline
  addIfExist(
    'VS Code Cline Extension',
    join(
      vscodeUserData,
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    ),
  );
  // Roo Code
  addIfExist(
    'VS Code Roo Code Extension',
    join(
      vscodeUserData,
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings',
      'mcp_settings.json',
    ),
  );

  // VS Code Insiders versions
  const vscodeInsidersUserData =
    osPlatform === 'win32'
      ? join(appData, 'Code - Insiders', 'User')
      : osPlatform === 'darwin'
        ? join(homeDir, 'Library', 'Application Support', 'Code - Insiders', 'User')
        : join(homeDir, '.config', 'Code - Insiders', 'User');

  addIfExist(
    'VS Code Insiders Cline Extension',
    join(
      vscodeInsidersUserData,
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    ),
  );
  addIfExist(
    'VS Code Insiders Roo Code Extension',
    join(
      vscodeInsidersUserData,
      'globalStorage',
      'rooveterinaryinc.roo-cline',
      'settings',
      'mcp_settings.json',
    ),
  );

  return targets;
}

export async function writeJsonAtomic(filePath: string, data: unknown): Promise<void> {
  const dir = dirname(filePath);
  await mkdir(dir, { recursive: true });

  const tempPath = `${filePath}.${Math.random().toString(36).slice(2, 9)}.tmp`;
  try {
    const content = JSON.stringify(data, null, 2) + '\n';
    await writeFile(tempPath, content, 'utf8');
    await rename(tempPath, filePath);
  } catch (error) {
    process.stderr.write(
      `Warning: Atomic write failed for ${filePath}. Falling back to direct write (non-atomic).\n`,
    );
    try {
      await unlink(tempPath);
    } catch (unlinkErr) {
      process.stderr.write(
        `Warning: Failed to remove temp file ${tempPath}: ${unlinkErr instanceof Error ? unlinkErr.message : String(unlinkErr)}\n`,
      );
    }
    try {
      await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf8');
    } catch (fallbackError) {
      throw new Error(
        `Failed to write configuration atomically, and fallback write also failed.\nOriginal error: ${error instanceof Error ? error.message : String(error)}\nFallback error: ${fallbackError instanceof Error ? fallbackError.message : String(fallbackError)}`,
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

  if (serverNameOpt && mcpServers[serverNameOpt] && typeof mcpServers[serverNameOpt] === 'object') {
    return { key: serverNameOpt, entry: mcpServers[serverNameOpt] as Record<string, unknown> };
  }

  const defaults = ['filesystem', 'filesystem-mcp'];
  for (const d of defaults) {
    if (mcpServers[d] && typeof mcpServers[d] === 'object') {
      return { key: d, entry: mcpServers[d] as Record<string, unknown> };
    }
  }

  for (const key of Object.keys(mcpServers)) {
    const entry = mcpServers[key];
    if (entry && typeof entry === 'object') {
      const entryObj = entry as Record<string, unknown>;
      const commandValue = entryObj['command'];
      const cmd = typeof commandValue === 'string' ? commandValue : '';
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
          process.stderr.write(
            `Warning: Failed to release lock file ${lockFilePath}: ${releaseErr instanceof Error ? releaseErr.message : String(releaseErr)}\n`,
          );
        }
      };
    } catch (error) {
      if (isRecord(error) && error['code'] === 'EEXIST') {
        try {
          const lockStat = await stat(lockFilePath);
          if (Date.now() - lockStat.mtimeMs > staleLockMs) {
            process.stderr.write(`Warning: Removing stale lock file ${lockFilePath}.\n`);
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
      release = await acquireLock(lockFilePath);
    }

    const configData: Record<string, unknown> = { mcpServers: {} };
    const fileExists = existsSync(filePath);

    if (fileExists) {
      try {
        const content = await readFile(filePath, 'utf8');
        Object.assign(configData, JSON.parse(content) as Record<string, unknown>);
      } catch (error) {
        throw new CliExitError(
          `Failed to parse configuration file ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
          1,
        );
      }
    }

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
      };
      mcpServers[key] = entry;
    }

    if (!Array.isArray(entry['args'])) {
      entry['args'] = ['-y', '@j0hanz/filesystem-mcp'];
    }

    const argsArray = entry['args'] as string[];

    const cmdVal = entry['command'];
    const cmdStr = typeof cmdVal === 'string' ? cmdVal : '';
    if (cmdStr.includes('docker') && action === 'allow') {
      process.stderr.write(
        `Warning: Server '${key}' in config ${filePath} appears to be running via Docker. Path allowance via command line arguments might not map correctly inside the container.\n`,
      );
    }

    if (action === 'allow') {
      const alreadyExists = argsArray.some((arg: string) => {
        try {
          return isAbsolute(arg) && isSamePath(arg, targetPath);
        } catch (compareErr) {
          process.stderr.write(
            `Warning: Could not compare path '${arg}' with '${targetPath}': ${compareErr instanceof Error ? compareErr.message : String(compareErr)}\n`,
          );
          return false;
        }
      });

      if (!alreadyExists) {
        argsArray.push(targetPath);
      }
    } else {
      entry['args'] = argsArray.filter((arg: string) => {
        try {
          if (!isAbsolute(arg)) return true;
          return !isSamePath(arg, targetPath);
        } catch (compareErr) {
          process.stderr.write(
            `Warning: Could not compare path '${arg}' with '${targetPath}': ${compareErr instanceof Error ? compareErr.message : String(compareErr)}\n`,
          );
          return true;
        }
      });
    }

    if (!options.dryRun) {
      await writeJsonAtomic(filePath, configData);
    }
    return true;
  } finally {
    if (release) {
      await release();
    }
  }
}

export async function allowPath(pathToAdd: string, options: ModifyOptions = {}): Promise<void> {
  validateCliPath(pathToAdd);
  const resolvedPath = resolve(pathToAdd);

  if (options.config) {
    await modifySingleConfig(options.config, 'allow', resolvedPath, options);
    return;
  }

  const targets = getExistingConfigPaths();
  const clientOpt = options.client;
  const filtered = clientOpt
    ? targets.filter((t) => t.name.toLowerCase().includes(clientOpt.toLowerCase()))
    : targets;

  if (filtered.length === 0) {
    if (clientOpt) {
      throw new CliExitError(
        `No existing configuration file found for client matching '${clientOpt}'. Use --config to specify a path explicitly.`,
        1,
      );
    }
    const defaultPath = getClaudeConfigPath();
    await modifySingleConfig(defaultPath, 'allow', resolvedPath, options);
    process.stdout.write(`Initialized new configuration for Claude Desktop at: ${defaultPath}\n`);
    return;
  }

  for (const target of filtered) {
    await modifySingleConfig(target.path, 'allow', resolvedPath, options);
  }
}

export async function disallowPath(
  pathToRemove: string,
  options: ModifyOptions = {},
): Promise<void> {
  validateCliPath(pathToRemove);
  const resolvedPath = resolve(pathToRemove);

  if (options.config) {
    await modifySingleConfig(options.config, 'disallow', resolvedPath, options);
    return;
  }

  const targets = getExistingConfigPaths();
  const clientOpt = options.client;
  const filtered = clientOpt
    ? targets.filter((t) => t.name.toLowerCase().includes(clientOpt.toLowerCase()))
    : targets;

  let anyModified = false;
  for (const target of filtered) {
    if (await modifySingleConfig(target.path, 'disallow', resolvedPath, options)) {
      anyModified = true;
    }
  }
  if (!anyModified) {
    process.stderr.write(`Warning: Path '${resolvedPath}' was not found in any configuration.\n`);
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
      if (matched?.entry && Array.isArray(matched.entry['args'])) {
        const argsArray = matched.entry['args'] as string[];
        return argsArray.filter((arg: string) => isAbsolute(arg));
      }
    } catch (error: unknown) {
      process.stderr.write(
        `Warning: Skipping ${filePath} — could not parse (results may be incomplete): ${error instanceof Error ? error.message : String(error)}\n`,
      );
    }
    return [];
  };

  if (options.config) {
    return await getPathsFromFile(options.config);
  }

  const targets = getExistingConfigPaths();
  const clientOpt = options.client;
  const filtered = clientOpt
    ? targets.filter((t) => t.name.toLowerCase().includes(clientOpt.toLowerCase()))
    : targets;

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

function getClaudeConfigPath(): string {
  const osPlatform = platform();
  if (osPlatform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming');
    return join(appData, 'Claude', 'claude_desktop_config.json');
  } else if (osPlatform === 'darwin') {
    return join(
      homedir(),
      'Library',
      'Application Support',
      'Claude',
      'claude_desktop_config.json',
    );
  } else {
    return join(homedir(), '.config', 'Claude', 'claude_desktop_config.json');
  }
}
