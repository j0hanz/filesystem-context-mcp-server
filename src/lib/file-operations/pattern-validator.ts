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

/**
 * Validates glob patterns for safety and common mistakes
 * Prevents backslashes, absolute paths, and overly complex patterns
 */
function validateGlobPattern(pattern: string): PatternValidationResult {
  // Check for empty pattern
  if (!pattern || pattern.trim().length === 0) {
    return {
      isValid: false,
      error: 'Pattern cannot be empty',
      suggestion: 'Provide at least one glob pattern like "**/*.ts"',
    };
  }

  // Check pattern length
  if (pattern.length > MAX_PATTERN_LENGTH) {
    return {
      isValid: false,
      error: `Pattern too long (${pattern.length}/${MAX_PATTERN_LENGTH} chars)`,
      suggestion: `Simplify the pattern or split into multiple searches`,
    };
  }

  // Check for backslashes (common Windows mistake)
  if (BACKSLASH_PATTERN.test(pattern)) {
    return {
      isValid: false,
      error: 'Glob patterns must use forward slashes, not backslashes',
      suggestion: `Replace \\ with /. Example: src/lib/**/*.ts instead of src\\lib\\**\\*.ts`,
    };
  }

  // Check for absolute paths and .. segments
  if (UNSAFE_PATTERN.test(pattern)) {
    return {
      isValid: false,
      error:
        'Pattern must be relative (no absolute paths, no .. segments, no leading slash)',
      suggestion:
        'Remove leading / or convert absolute path to relative from base directory',
    };
  }

  // Check for excessive brace expansion
  const braceMatches = pattern.match(/\{[^}]*\}/g) ?? [];
  for (const match of braceMatches) {
    const items = match.slice(1, -1).split(',');
    if (items.length > MAX_BRACE_EXPANSION) {
      return {
        isValid: false,
        error: `Brace expansion too large (${items.length}/${MAX_BRACE_EXPANSION} items)`,
        suggestion:
          'Use character classes [abc] instead of brace expansion {a,b,c} when possible',
      };
    }
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
