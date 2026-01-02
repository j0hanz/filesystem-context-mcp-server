import assert from 'node:assert/strict';
import { it } from 'node:test';

import {
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  McpError,
} from '../../lib/errors.js';

void it('createDetailedError creates detailed error object', () => {
  const error = new McpError(
    ErrorCode.E_NOT_FOUND,
    'File not found',
    '/some/path'
  );
  const detailed = createDetailedError(error, '/some/path');

  assert.strictEqual(detailed.code, ErrorCode.E_NOT_FOUND);
  assert.strictEqual(detailed.message, 'File not found');
  assert.strictEqual(detailed.path, '/some/path');
  assert.ok(detailed.suggestion);
});

void it('createDetailedError includes additional details', () => {
  const error = new Error('Error');
  const detailed = createDetailedError(error, '/path', { extra: 'info' });
  assert.deepStrictEqual(detailed.details, { extra: 'info' });
});

void it('formatDetailedError formats error for display', () => {
  const detailed = {
    code: ErrorCode.E_NOT_FOUND,
    message: 'File not found',
    path: '/some/path',
    suggestion: 'Check the path exists',
  };

  const formatted = formatDetailedError(detailed);

  assert.ok(formatted.includes('E_NOT_FOUND'));
  assert.ok(formatted.includes('File not found'));
  assert.ok(formatted.includes('/some/path'));
  assert.ok(formatted.includes('Check the path exists'));
});

void it('formatDetailedError handles missing optional fields', () => {
  const detailed = {
    code: ErrorCode.E_UNKNOWN,
    message: 'Unknown error',
  };

  const formatted = formatDetailedError(detailed);

  assert.ok(formatted.includes('E_UNKNOWN'));
  assert.ok(formatted.includes('Unknown error'));
});
