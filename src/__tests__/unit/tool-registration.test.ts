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

  it('strips invalid top-level taskSupport without disturbing execution metadata', () => {
    const registered = withDefaultIcons(
      {
        name: 'example',
        description: 'example',
        inputSchema: { type: 'object', additionalProperties: false },
        taskSupport: 'sometimes',
        execution: {
          taskSupport: 'required' as const,
          mode: 'background',
        },
      },
      undefined
    ) as {
      execution?: { taskSupport?: string; mode?: string };
      taskSupport?: string;
    };

    assert.equal(registered.taskSupport, undefined);
    assert.equal(registered.execution?.taskSupport, 'required');
    assert.equal(registered.execution?.mode, 'background');
  });
});
