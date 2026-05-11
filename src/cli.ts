import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { getSystemErrorMessage, getSystemErrorName, parseArgs as utilParseArgs } from 'node:util';

import { processInParallel } from './core/concurrency.js';
import {
  getReservedDeviceNameForPath,
  isWindowsDriveRelativePath,
  normalizePath,
} from './core/path.js';
import { isRecord } from './core/util.js';
import { pkgInfo } from './pkg-info.js';

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

async function validateDirectoryPath(inputPath: string): Promise<string> {
  const normalized = normalizePath(inputPath);

  try {
    const stats = await stat(normalized);
    assertDirectory(stats, inputPath);
    return normalized;
  } catch (error) {
    throw normalizeDirectoryError(error, inputPath);
  }
}

async function normalizeCliDirectories(args: readonly string[]): Promise<string[]> {
  const { results, errors } = await processInParallel(
    [...args],
    validateDirectoryPath,
    CLI_VALIDATE_CONCURRENCY,
  );
  if (errors.length === 0) {
    return results;
  }
  let first = errors[0];
  for (const failure of errors) {
    if (first && failure.index < first.index) {
      first = failure;
    }
  }
  throw first?.error ?? new Error('Failed to validate directories');
}

function printHelpAndExit(): never {
  const help = `filesystem-mcp [options] [allowedDirs...]

MCP filesystem server. Positional directories define allowed access roots.

Options:
  -h, --help              Display command help
  -v, --version           Display server version
  --allow-cwd             Allow the current working directory as an additional root
  --port <number>         Enable HTTP transport on the given port (Node Streamable HTTP)

Examples:
  $ filesystem-mcp /path/to/allowed/dir
  $ filesystem-mcp --allow-cwd
  $ filesystem-mcp /project/src /project/tests --allow-cwd
  $ filesystem-mcp --port 3000 /path/to/allowed/dir
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
}> {
  try {
    const parsed = utilParseArgs({
      options: {
        'allow-cwd': { type: 'boolean', default: false },
        port: { type: 'string' },
        help: { type: 'boolean', short: 'h' },
        version: { type: 'boolean', short: 'v' },
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

    const allowCwd = (parsed.values as Record<string, unknown>)['allow-cwd'] as boolean;
    const port = parsePortOption(parsed.values.port);

    let allowedDirs: string[];
    try {
      allowedDirs = positionals.length > 0 ? await normalizeCliDirectories(positionals) : [];
    } catch (error: unknown) {
      throw new CliExitError(normalizeCliExitMessage(error), 1);
    }

    const deduplicatedDirs = deduplicateAllowedDirectories(allowedDirs);

    return { allowedDirs: deduplicatedDirs, allowCwd, port };
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
