import { ErrorCode, McpError } from '../errors.js';
import { normalizePath } from '../path-utils.js';

export const RESERVED_DEVICE_NAMES = new Set([
  'CON',
  'PRN',
  'AUX',
  'NUL',
  'COM1',
  'COM2',
  'COM3',
  'COM4',
  'COM5',
  'COM6',
  'COM7',
  'COM8',
  'COM9',
  'LPT1',
  'LPT2',
  'LPT3',
  'LPT4',
  'LPT5',
  'LPT6',
  'LPT7',
  'LPT8',
  'LPT9',
]);

function ensureNonEmptyPath(requestedPath: string): void {
  if (!requestedPath || requestedPath.trim().length === 0) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Path cannot be empty or whitespace',
      requestedPath
    );
  }
}

function ensureNoNullBytes(requestedPath: string): void {
  if (requestedPath.includes('\0')) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Path contains null bytes',
      requestedPath
    );
  }
}

function getReservedDeviceName(segment: string): string | undefined {
  const trimmed = segment.replace(/[ .]+$/g, '');
  const withoutStream = trimmed.split(':')[0] ?? '';
  const baseName = withoutStream.split('.')[0]?.toUpperCase();
  if (!baseName) return undefined;
  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

function ensureNoReservedWindowsNames(requestedPath: string): void {
  if (process.platform !== 'win32') return;

  const segments = requestedPath.split(/[\\/]/);
  for (const segment of segments) {
    const reserved = getReservedDeviceName(segment);
    if (reserved) {
      throw new McpError(
        ErrorCode.E_INVALID_INPUT,
        `Windows reserved device name not allowed: ${reserved}`,
        requestedPath
      );
    }
  }
}

function ensureNoWindowsDriveRelativePath(requestedPath: string): void {
  if (process.platform !== 'win32') return;
  if (/^[a-zA-Z]:(?![\\/])/.test(requestedPath)) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Windows drive-relative paths are not allowed. Use C:\\path or C:/path instead of C:path.',
      requestedPath
    );
  }
}

export function validateRequestedPath(requestedPath: string): string {
  ensureNonEmptyPath(requestedPath);
  ensureNoNullBytes(requestedPath);
  ensureNoReservedWindowsNames(requestedPath);
  ensureNoWindowsDriveRelativePath(requestedPath);
  return normalizePath(requestedPath);
}
