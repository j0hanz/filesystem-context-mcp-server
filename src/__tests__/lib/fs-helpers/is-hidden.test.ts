import assert from 'node:assert/strict';
import { it } from 'node:test';

import { isHidden } from '../../../lib/fs-helpers.js';

void it('isHidden identifies hidden files', () => {
  assert.strictEqual(isHidden('.git'), true);
  assert.strictEqual(isHidden('file.txt'), false);
});
