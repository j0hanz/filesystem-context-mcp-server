import { ErrorCode, McpError } from '../../lib/errors.js';

export function assertNoMixedRangeOptions(
  hasHeadTail: boolean,
  hasLineRange: boolean,
  pathLabel: string
): void {
  if (!hasHeadTail || !hasLineRange) return;
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    'head/tail cannot be combined with lineStart/lineEnd',
    pathLabel
  );
}

export function assertLineRangeComplete(
  lineStart: number | undefined,
  lineEnd: number | undefined,
  pathLabel: string
): void {
  const hasLineStart = lineStart !== undefined;
  const hasLineEnd = lineEnd !== undefined;
  if (hasLineStart === hasLineEnd) return;
  const missing = hasLineStart ? 'lineEnd' : 'lineStart';
  const provided = hasLineStart ? 'lineStart' : 'lineEnd';
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    `Invalid lineRange: ${provided} requires ${missing} to also be specified`,
    pathLabel
  );
}

export function buildLineRange(
  lineStart: number | undefined,
  lineEnd: number | undefined,
  pathLabel: string
): { start: number; end: number } | undefined {
  assertLineRangeComplete(lineStart, lineEnd, pathLabel);
  if (lineStart === undefined || lineEnd === undefined) return undefined;
  return { start: lineStart, end: lineEnd };
}
