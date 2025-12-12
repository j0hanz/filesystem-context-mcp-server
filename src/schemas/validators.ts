import { ErrorCode, McpError } from '../lib/errors.js';

// Validates line range parameters
export function validateLineRange(params: {
  lineStart?: number;
  lineEnd?: number;
  head?: number;
  tail?: number;
  path: string;
}): void {
  const { lineStart, lineEnd, head, tail, path } = params;

  // Check for partial lineRange specification
  const hasLineStart = lineStart !== undefined;
  const hasLineEnd = lineEnd !== undefined;

  if (hasLineStart !== hasLineEnd) {
    const missing = hasLineStart ? 'lineEnd' : 'lineStart';
    const provided = hasLineStart ? 'lineStart' : 'lineEnd';
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Invalid lineRange: ${provided} requires ${missing} to also be specified`,
      path,
      { lineStart, lineEnd }
    );
  }

  // Validate lineEnd >= lineStart
  if (hasLineStart && hasLineEnd && lineEnd < lineStart) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      `Invalid lineRange: lineEnd (${lineEnd}) must be >= lineStart (${lineStart})`,
      path,
      { lineStart, lineEnd }
    );
  }

  // Check mutual exclusivity with head/tail
  const hasLineRange = hasLineStart && hasLineEnd;
  const optionsCount = [
    hasLineRange,
    head !== undefined,
    tail !== undefined,
  ].filter(Boolean).length;

  if (optionsCount > 1) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Cannot specify multiple of lineRange (lineStart + lineEnd), head, or tail simultaneously',
      path,
      { lineStart, lineEnd, head, tail }
    );
  }
}

// Validates head and tail are mutually exclusive
export function validateHeadTail(params: {
  head?: number;
  tail?: number;
}): void {
  const { head, tail } = params;

  if (head !== undefined && tail !== undefined) {
    throw new McpError(
      ErrorCode.E_INVALID_INPUT,
      'Cannot specify both head and tail simultaneously',
      undefined,
      { head, tail }
    );
  }
}
