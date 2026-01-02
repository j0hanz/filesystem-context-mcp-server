import assert from 'node:assert/strict';
import { it } from 'node:test';

import { ErrorCode, McpError } from '../../lib/errors.js';

void it('McpError creates error with all properties', () => {
  const error = new McpError(
    ErrorCode.E_ACCESS_DENIED,
    'Access denied',
    '/some/path',
    { extra: 'detail' }
  );

  assert.strictEqual(error.code, ErrorCode.E_ACCESS_DENIED);
  assert.strictEqual(error.message, 'Access denied');
  assert.strictEqual(error.path, '/some/path');
  assert.deepStrictEqual(error.details, { extra: 'detail' });
  assert.strictEqual(error.name, 'McpError');
});

void it('McpError supports cause chaining', () => {
  const cause = new Error('Original error');
  const error = new McpError(
    ErrorCode.E_NOT_FOUND,
    'File not found',
    '/path',
    undefined,
    cause
  );
  assert.strictEqual(error.cause, cause);
});

void it('McpError is instanceof Error', () => {
  const error = new McpError(ErrorCode.E_UNKNOWN, 'Test');
  assert.strictEqual(error instanceof Error, true);
  assert.strictEqual(error instanceof McpError, true);
});

void it('McpError.fromError wraps existing errors', () => {
  const original = new Error('Original');
  original.stack = 'Original stack trace';

  const mcpError = McpError.fromError(
    ErrorCode.E_NOT_FOUND,
    'Wrapped error',
    original,
    '/path'
  );

  assert.strictEqual(mcpError.code, ErrorCode.E_NOT_FOUND);
  assert.strictEqual(mcpError.cause, original);
  assert.ok(mcpError.stack?.includes('Caused by: Original stack trace'));
});
