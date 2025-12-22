import { expect, it } from 'vitest';

import {
  createDetailedError,
  ErrorCode,
  formatDetailedError,
  McpError,
} from '../../lib/errors.js';

it('createDetailedError creates detailed error object', () => {
  const error = new McpError(
    ErrorCode.E_NOT_FOUND,
    'File not found',
    '/some/path'
  );
  const detailed = createDetailedError(error, '/some/path');

  expect(detailed.code).toBe(ErrorCode.E_NOT_FOUND);
  expect(detailed.message).toBe('File not found');
  expect(detailed.path).toBe('/some/path');
  expect(detailed.suggestion).toBeTruthy();
});

it('createDetailedError includes additional details', () => {
  const error = new Error('Error');
  const detailed = createDetailedError(error, '/path', { extra: 'info' });
  expect(detailed.details).toEqual({ extra: 'info' });
});

it('formatDetailedError formats error for display', () => {
  const detailed = {
    code: ErrorCode.E_NOT_FOUND,
    message: 'File not found',
    path: '/some/path',
    suggestion: 'Check the path exists',
  };

  const formatted = formatDetailedError(detailed);

  expect(formatted).toContain('E_NOT_FOUND');
  expect(formatted).toContain('File not found');
  expect(formatted).toContain('/some/path');
  expect(formatted).toContain('Check the path exists');
});

it('formatDetailedError handles missing optional fields', () => {
  const detailed = {
    code: ErrorCode.E_UNKNOWN,
    message: 'Unknown error',
  };

  const formatted = formatDetailedError(detailed);

  expect(formatted).toContain('E_UNKNOWN');
  expect(formatted).toContain('Unknown error');
});
