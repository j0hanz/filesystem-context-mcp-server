import { ErrorCode, McpError } from '../errors.js';

const BACKSLASH_PATTERN = /\\/g;
const UNSAFE_PATTERN = /\.\.|^[/\\]/;
const MAX_PATTERN_LENGTH = 1000;
const MAX_BRACE_EXPANSION = 100;

interface PatternValidationResult {
  isValid: boolean;
  error?: string;
  suggestion?: string;
}

function invalidPattern(
  error: string,
  suggestion?: string
): PatternValidationResult {
  return { isValid: false, error, suggestion };
}

function validateNonEmpty(pattern: string): PatternValidationResult | null {
  if (pattern && pattern.trim().length > 0) return null;
  return invalidPattern(
    'Pattern cannot be empty',
    'Provide at least one glob pattern like "**/*.ts"'
  );
}

function validateLength(pattern: string): PatternValidationResult | null {
  if (pattern.length <= MAX_PATTERN_LENGTH) return null;
  return invalidPattern(
    `Pattern too long (${pattern.length}/${MAX_PATTERN_LENGTH} chars)`,
    'Simplify the pattern or split into multiple searches'
  );
}

function validateBackslashes(pattern: string): PatternValidationResult | null {
  if (!BACKSLASH_PATTERN.test(pattern)) return null;
  return invalidPattern(
    'Glob patterns must use forward slashes, not backslashes',
    'Replace \\ with /. Example: src/lib/**/*.ts instead of src\\lib\\**\\*.ts'
  );
}

function validateUnsafePattern(
  pattern: string
): PatternValidationResult | null {
  if (!UNSAFE_PATTERN.test(pattern)) return null;
  return invalidPattern(
    'Pattern must be relative (no absolute paths, no .. segments, no leading slash)',
    'Remove leading / or convert absolute path to relative from base directory'
  );
}

function validateBraceExpansion(
  pattern: string
): PatternValidationResult | null {
  const braceMatches = pattern.match(/\{[^}]*\}/g) ?? [];
  for (const match of braceMatches) {
    const items = match.slice(1, -1).split(',');
    if (items.length > MAX_BRACE_EXPANSION) {
      return invalidPattern(
        `Brace expansion too large (${items.length}/${MAX_BRACE_EXPANSION} items)`,
        'Use character classes [abc] instead of brace expansion {a,b,c} when possible'
      );
    }
  }
  return null;
}

/**
 * Validates glob patterns for safety and common mistakes
 * Prevents backslashes, absolute paths, and overly complex patterns
 */
function validateGlobPattern(pattern: string): PatternValidationResult {
  const validators = [
    validateNonEmpty,
    validateLength,
    validateBackslashes,
    validateUnsafePattern,
    validateBraceExpansion,
  ];

  for (const validator of validators) {
    const result = validator(pattern);
    if (result) return result;
  }

  return { isValid: true };
}

/**
 * Throws McpError if pattern is invalid
 */
export function validateGlobPatternOrThrow(
  pattern: string,
  basePath: string
): void {
  const result = validateGlobPattern(pattern);
  if (!result.isValid) {
    throw new McpError(
      ErrorCode.E_INVALID_PATTERN,
      result.error ?? 'Invalid glob pattern',
      basePath,
      {
        pattern,
        suggestion: result.suggestion,
      }
    );
  }
}
