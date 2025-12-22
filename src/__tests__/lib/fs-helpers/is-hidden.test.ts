import { expect, it } from 'vitest';

import { isHidden } from '../../../lib/fs-helpers.js';

it('isHidden identifies hidden files', () => {
  expect(isHidden('.git')).toBe(true);
  expect(isHidden('file.txt')).toBe(false);
});
