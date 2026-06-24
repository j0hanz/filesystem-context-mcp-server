import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import { CliExitError, IS_WINDOWS, validateCliPath } from './cli.js';
import { cliFmt } from './core/fmt.js';
import { isSamePath } from './core/path.js';
import { isRecord } from './core/primitives.js';

// ════════════════════════════════════════════════════════════
// Config Constants & Keys (Internal to Client Config)
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

const ENV_DIR_SEP = (process.platform === 'win32') ? ';' : ':';

// ════════════════════════════════════════════════════════════
// Config Helper Functions (Installer Block)
// ════════════════════════════════════════════════════════════

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
