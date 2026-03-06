import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { withDefaultIcons } from '../../tools/shared.js';

describe('tool registration shape', () => {
  it('normalizes top-level taskSupport into execution.taskSupport', () => {
    const registered = withDefaultIcons(
      {
        name: 'example',
        description: 'example',
        inputSchema: { type: 'object', additionalProperties: false },
        taskSupport: 'optional' as const,
      },
      undefined
    ) as {
      execution?: { taskSupport?: string };
      taskSupport?: string;
    };

    assert.equal(registered.taskSupport, undefined);
    assert.equal(registered.execution?.taskSupport, 'optional');
  });
});
