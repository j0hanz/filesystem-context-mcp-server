import { expect, it } from 'vitest';

import { ErrorCode, McpError } from '../../lib/errors.js';

it('McpError creates error with all properties', () => {
  const error = new McpError(
    ErrorCode.E_ACCESS_DENIED,
    'Access denied',
    '/some/path',
    { extra: 'detail' }
  );

  expect(error.code).toBe(ErrorCode.E_ACCESS_DENIED);
  expect(error.message).toBe('Access denied');
  expect(error.path).toBe('/some/path');
  expect(error.details).toEqual({ extra: 'detail' });
  expect(error.name).toBe('McpError');
});

it('McpError supports cause chaining', () => {
  const cause = new Error('Original error');
  const error = new McpError(
    ErrorCode.E_NOT_FOUND,
    'File not found',
    '/path',
    undefined,
    cause
  );
  expect(error.cause).toBe(cause);
});

it('McpError is instanceof Error', () => {
  const error = new McpError(ErrorCode.E_UNKNOWN, 'Test');
  expect(error instanceof Error).toBe(true);
  expect(error instanceof McpError).toBe(true);
});

it('McpError.fromError wraps existing errors', () => {
  const original = new Error('Original');
  original.stack = 'Original stack trace';

  const mcpError = McpError.fromError(
    ErrorCode.E_NOT_FOUND,
    'Wrapped error',
    original,
    '/path'
  );

  expect(mcpError.code).toBe(ErrorCode.E_NOT_FOUND);
  expect(mcpError.cause).toBe(original);
  expect(mcpError.stack).toContain('Caused by: Original stack trace');
});
