import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, expect, it } from 'vitest';

import { ErrorCode } from '../../lib/errors.js';
import { normalizePath } from '../../lib/path-utils.js';
import { setAllowedDirectories } from '../../lib/path-validation.js';
import {
  toAccessDeniedWithHint,
  toMcpError,
} from '../../lib/path-validation/errors.js';

afterEach(() => {
  setAllowedDirectories([]);
});

it('toMcpError maps known Node error codes', () => {
  const error = Object.assign(new Error('Missing'), { code: 'ENOENT' });

  const result = toMcpError('/missing', error);

  expect(result.code).toBe(ErrorCode.E_NOT_FOUND);
  expect(result.message).toContain('/missing');
  expect(result.details?.originalCode).toBe('ENOENT');
});

it('toMcpError falls back for unknown codes', () => {
  const error = Object.assign(new Error('Boom'), { code: 'EUNKNOWN' });

  const result = toMcpError('/path', error);

  expect(result.code).toBe(ErrorCode.E_NOT_FOUND);
  expect(result.details?.originalCode).toBe('EUNKNOWN');
  expect(result.details?.originalMessage).toBe('Boom');
});

it('toAccessDeniedWithHint includes allowed directories', () => {
  const allowed = normalizePath(path.join(os.tmpdir(), 'allowed'));
  setAllowedDirectories([allowed]);

  const result = toAccessDeniedWithHint('/requested', '/resolved', allowed);

  expect(result.code).toBe(ErrorCode.E_ACCESS_DENIED);
  expect(result.message).toContain('Allowed directories');
  expect(result.message).toContain(allowed);
  expect(result.details?.resolvedPath).toBe('/resolved');
  expect(result.details?.normalizedResolvedPath).toBe(allowed);
});
