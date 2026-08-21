import assert from 'node:assert/strict';
import test from 'node:test';

import { ALL_REGISTERED_TOOL_NAMES, MUTATING_TOOL_NAMES } from '../../src/tools/index.js';
import {
  ORACLE_ALL_TOOL_NAMES,
  ORACLE_MUTATING_TOOL_NAMES,
  ORACLE_READ_ONLY_TOOL_NAMES,
} from '../helpers.js';

test('MUTATING_TOOL_NAMES matches the declared mutating set', () => {
  assert.deepEqual(
    [...MUTATING_TOOL_NAMES].sort(),
    [...ORACLE_MUTATING_TOOL_NAMES].sort(),
    'A tool changed its readOnlyHint, or a new tool was added. If the new set is ' +
      'correct, update ORACLE_MUTATING_TOOL_NAMES in __tests__/helpers.ts.',
  );
});

test('every registered tool is classified exactly once', () => {
  assert.deepEqual(
    [...ALL_REGISTERED_TOOL_NAMES].sort(),
    [...ORACLE_ALL_TOOL_NAMES].sort(),
    'Add the new tool to ORACLE_ALL_TOOL_NAMES and to one of the two subsets.',
  );
  assert.deepEqual(
    [...ORACLE_MUTATING_TOOL_NAMES, ...ORACLE_READ_ONLY_TOOL_NAMES].sort(),
    [...ORACLE_ALL_TOOL_NAMES].sort(),
    'The mutating and read-only oracles must partition the full roster.',
  );
});

test('read-only instructions omit every mutating tool', async () => {
  const { buildServerInstructions } = await import('../../src/resources.js');
  const text = buildServerInstructions(true);
  for (const name of ORACLE_MUTATING_TOOL_NAMES) {
    assert.ok(!text.includes(name), `read-only instructions must not advertise '${name}'`);
  }
});

test('default instructions still list the mutating tools', async () => {
  const { buildServerInstructions } = await import('../../src/resources.js');
  const text = buildServerInstructions(false);
  for (const name of ORACLE_MUTATING_TOOL_NAMES) {
    assert.ok(text.includes(name), `default instructions must advertise '${name}'`);
  }
});
