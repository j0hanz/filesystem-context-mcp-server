import { ErrorCode, McpError } from './errors.js';

const ABSOLUTE_GLOB_RE = /^([/\\]|[A-Za-z]:[/\\]|\\\\)/u;
const PARENT_SEGMENT_RE = /[\\/]\.\.(?:[/\\]|$)/u;

export function isSafeGlobPattern(value: string): boolean {
  if (value.length === 0) return false;
  if (value.includes('**/**/**')) return false;
  if (ABSOLUTE_GLOB_RE.test(value)) return false;
  if (value.startsWith('..') || PARENT_SEGMENT_RE.test(value)) return false;
  return true;
}

export function assertSafeGlobPattern(
  value: string,
  message = 'Invalid glob or unsafe path (absolute/.. forbidden)'
): void {
  if (!isSafeGlobPattern(value)) {
    throw new McpError(ErrorCode.INVALID_PATTERN, message);
  }
}
