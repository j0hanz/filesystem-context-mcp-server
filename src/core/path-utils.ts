import { isAlpha, isSlash } from './primitives.js';

const CHAR_COLON = 58;

const RESERVED_DEVICE_NAMES = new Set<string>([
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

function getReservedDeviceName(segment: string): string | undefined {
  const trimmed = segment.replace(/[. ]+$/, '');
  const withoutStream = trimmed.split(':')[0] ?? '';
  const baseName = (withoutStream.split('.')[0] ?? '').toUpperCase();
  return RESERVED_DEVICE_NAMES.has(baseName) ? baseName : undefined;
}

export function getReservedDeviceNameForPath(requestedPath: string): string | undefined {
  const segments = requestedPath.split(/[\\/]/u);
  for (const segment of segments) {
    const reserved = getReservedDeviceName(segment);
    if (reserved) {
      return reserved;
    }
  }
  return undefined;
}

export function isWindowsDriveRelativePath(requestedPath: string): boolean {
  // Check on all platforms so cross-platform clients cannot smuggle drive-relative
  // inputs (e.g. C:relative) to a POSIX-hosted server where path.resolve would
  // silently expand them relative to CWD.
  if (requestedPath.length < 2) {
    return false;
  }
  if (requestedPath.charCodeAt(1) !== CHAR_COLON) {
    return false;
  }
  if (!isAlpha(requestedPath.charCodeAt(0))) {
    return false;
  }

  if (requestedPath.length === 2) {
    return true;
  }
  return !isSlash(requestedPath.charCodeAt(2));
}
