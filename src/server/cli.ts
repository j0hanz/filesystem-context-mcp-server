import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
import { parseArgs as parseNodeArgs } from 'node:util';

import { normalizePath } from '../lib/path-utils.js';
import { RESERVED_DEVICE_NAMES } from '../lib/path-validation.js';

export interface ParseArgsResult {
  allowedDirs: string[];
  allowCwd: boolean;
}

function validateCliPath(inputPath: string): void {
  if (inputPath.includes('\0')) {
    throw new Error('Path contains null bytes');
  }

  if (isWindowsDriveRelativePath(inputPath)) {
    throw new Error(
      'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.'
    );
  }

  const reserved = getReservedCliDeviceName(inputPath);
  if (reserved) {
    throw new Error(`Reserved device name not allowed: ${reserved}`);
  }
}

function isWindowsDriveRelativePath(inputPath: string): boolean {
  if (process.platform !== 'win32') return false;
  return /^[a-zA-Z]:(?![\\/])/.test(inputPath);
}

function getReservedCliDeviceName(inputPath: string): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const basename = path.basename(inputPath).split('.')[0]?.toUpperCase();
  if (!basename) return undefined;
  return RESERVED_DEVICE_NAMES.has(basename) ? basename : undefined;
}

async function validateDirectoryPath(inputPath: string): Promise<string> {
  validateCliPath(inputPath);
  const normalized = normalizePath(inputPath);

  try {
    const stats = await fs.stat(normalized);
    assertDirectory(stats, inputPath);
    return normalized;
  } catch (error) {
    throw normalizeDirectoryError(error, inputPath);
  }
}

function assertDirectory(stats: Stats, inputPath: string): void {
  if (stats.isDirectory()) return;
  throw new Error(`Error: '${inputPath}' is not a directory`);
}

function isCliError(error: unknown): error is Error {
  return error instanceof Error && error.message.startsWith('Error:');
}

function normalizeDirectoryError(error: unknown, inputPath: string): Error {
  if (isCliError(error)) return error;
  return new Error(`Error: Cannot access directory '${inputPath}'`);
}

async function normalizeCliDirectories(
  args: readonly string[]
): Promise<string[]> {
  return Promise.all(args.map(validateDirectoryPath));
}

export function normalizeAllowedDirectories(dirs: readonly string[]): string[] {
  return dirs
    .map((dir) => dir.trim())
    .filter((dir) => dir.length > 0)
    .map(normalizePath);
}

export async function parseArgs(): Promise<ParseArgsResult> {
  const { values, positionals } = parseNodeArgs({
    args: process.argv.slice(2),
    strict: true,
    allowPositionals: true,
    options: {
      'allow-cwd': {
        type: 'boolean',
        default: false,
      },
    } as const,
  });

  const allowCwd = values['allow-cwd'];
  const allowedDirs =
    positionals.length > 0 ? await normalizeCliDirectories(positionals) : [];

  return { allowedDirs, allowCwd };
}
