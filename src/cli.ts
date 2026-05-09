import type { Stats } from 'node:fs';
import { stat } from 'node:fs/promises';
import { getSystemErrorMessage, getSystemErrorName } from 'node:util';

import { Command, CommanderError, InvalidArgumentError } from 'commander';

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
    throw new InvalidArgumentError('Path contains null bytes.');
  }

  if (isWindowsDriveRelativePath(inputPath)) {
    throw new InvalidArgumentError(
      'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
    );
  }

  const reserved = getReservedDeviceNameForPath(inputPath);
  if (reserved) {
    throw new InvalidArgumentError(`Windows reserved device name not allowed: ${reserved}.`);
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

function collectStringValues(values: readonly unknown[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    if (typeof value === 'string') {
      result.push(value);
    }
  }
  return result;
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

function parseAllowedDirArgument(value: string, previous: unknown): string[] {
  validateCliPath(value);
  const values = Array.isArray(previous) ? collectStringValues(previous) : [];
  return [...values, value];
}

function getParsedAllowedDirs(cli: Command): string[] {
  const [allowedDirs] = cli.processedArgs as unknown[];
  if (!Array.isArray(allowedDirs)) return [];
  return collectStringValues(allowedDirs);
}

function createCliProgram(output: string[]): Command {
  const cli = new Command();
  cli
    .name('filesystem-mcp')
    .usage('[options] [allowedDirs...]')
    .description('MCP filesystem server. Positional directories define allowed access roots.')
    .argument(
      '[allowedDirs...]',
      'Directories the MCP server can access on disk',
      parseAllowedDirArgument,
    )
    .option('--allow_cwd, --allow-cwd', 'Allow the current working directory as an additional root')
    .option('--port <number>', 'Enable HTTP transport on the given port (Node Streamable HTTP)')
    .helpOption('-h, --help', 'Display command help')
    .version(SERVER_VERSION, '-v, --version', 'Display server version')
    .addHelpText(
      'after',
      `
Examples:
  $ filesystem-mcp /path/to/allowed/dir
  $ filesystem-mcp --allow-cwd
  $ filesystem-mcp /project/src /project/tests --allow-cwd
  $ filesystem-mcp --port 3000 /path/to/allowed/dir
`,
    );

  cli.allowUnknownOption(false);
  cli.allowExcessArguments(false);
  cli.showHelpAfterError('(run with --help for usage)');
  cli.showSuggestionAfterError(true);
  cli.exitOverride();
  cli.configureOutput({
    writeOut(text: string): void {
      output.push(text);
    },
    writeErr(text: string): void {
      output.push(text);
    },
    outputError(text: string, write: (str: string) => void): void {
      write(text);
    },
  });

  return cli;
}

function formatCliOutput(output: readonly string[], fallback: string): string {
  const joined = output.join('').trimEnd();
  if (joined.length > 0) return joined;
  return fallback.trimEnd();
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
  const output: string[] = [];
  const cli = createCliProgram(output);
  try {
    cli.parse(process.argv, { from: 'node' });
  } catch (error: unknown) {
    if (error instanceof CommanderError) {
      throw new CliExitError(formatCliOutput(output, error.message), error.exitCode);
    }
    throw error;
  }

  const options = cli.opts<{ allowCwd?: boolean; port?: string }>();
  const allowCwd = Boolean(options.allowCwd);
  const port = parsePortOption(options.port);
  const positionals = getParsedAllowedDirs(cli);

  let allowedDirs: string[];
  try {
    allowedDirs = positionals.length > 0 ? await normalizeCliDirectories(positionals) : [];
  } catch (error: unknown) {
    throw new CliExitError(normalizeCliExitMessage(error), 1);
  }

  const deduplicatedDirs = deduplicateAllowedDirectories(allowedDirs);

  return { allowedDirs: deduplicatedDirs, allowCwd, port };
}
