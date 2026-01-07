import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ErrorCode, McpError } from '../../lib/errors.js';
import { assertLineRangeOptions } from '../../lib/line-range.js';

function expectMcpError(
  fn: () => void,
  options: { code: ErrorCode; messageIncludes: string }
): void {
  try {
    fn();
    assert.fail('Expected McpError to be thrown');
  } catch (error) {
    assert.ok(error instanceof McpError);
    const mcpError = error;
    assert.strictEqual(mcpError.code, options.code);
    assert.ok(mcpError.message.includes(options.messageIncludes));
  }
}

function validateLineRange(params: {
  lineStart?: number;
  lineEnd?: number;
  head?: number;
  tail?: number;
  path: string;
}): void {
  const { path, ...options } = params;
  assertLineRangeOptions(options, path);
}

function validateHeadTail(head?: number, tail?: number): void {
  assertLineRangeOptions({ head, tail }, '/test/file.txt');
}

void describe('validators', () => {
  void it('validateLineRange accepts valid lineRange with both lineStart and lineEnd', () => {
    assert.doesNotThrow(() => {
      validateLineRange({
        lineStart: 1,
        lineEnd: 10,
        path: '/test/file.txt',
      });
    });
  });

  void it('validateLineRange accepts no line options', () => {
    assert.doesNotThrow(() => {
      validateLineRange({ path: '/test/file.txt' });
    });
  });

  void it('validateLineRange accepts head option alone', () => {
    assert.doesNotThrow(() => {
      validateLineRange({ head: 10, path: '/test/file.txt' });
    });
  });

  void it('validateLineRange accepts tail option alone', () => {
    assert.doesNotThrow(() => {
      validateLineRange({ tail: 10, path: '/test/file.txt' });
    });
  });

  void it('validateLineRange accepts lineEnd equal to lineStart', () => {
    assert.doesNotThrow(() => {
      validateLineRange({ lineStart: 5, lineEnd: 5, path: '/test/file.txt' });
    });
  });

  void it('validateLineRange rejects lineStart without lineEnd', () => {
    expectMcpError(
      () => {
        validateLineRange({ lineStart: 5, path: '/test/file.txt' });
      },
      {
        code: ErrorCode.E_INVALID_INPUT,
        messageIncludes: 'lineStart requires lineEnd',
      }
    );
  });

  void it('validateLineRange rejects lineEnd without lineStart', () => {
    expectMcpError(
      () => {
        validateLineRange({ lineEnd: 10, path: '/test/file.txt' });
      },
      {
        code: ErrorCode.E_INVALID_INPUT,
        messageIncludes: 'lineEnd requires lineStart',
      }
    );
  });

  void it('validateLineRange rejects lineEnd < lineStart', () => {
    expectMcpError(
      () => {
        validateLineRange({
          lineStart: 10,
          lineEnd: 5,
          path: '/test/file.txt',
        });
      },
      {
        code: ErrorCode.E_INVALID_INPUT,
        messageIncludes: 'lineEnd (5) must be >= lineStart (10)',
      }
    );
  });

  void it('validateLineRange rejects lineRange with head', () => {
    expectMcpError(
      () => {
        validateLineRange({
          lineStart: 1,
          lineEnd: 10,
          head: 5,
          path: '/test/file.txt',
        });
      },
      {
        code: ErrorCode.E_INVALID_INPUT,
        messageIncludes: 'Cannot specify multiple',
      }
    );
  });

  void it('validateLineRange rejects lineRange with tail', () => {
    expectMcpError(
      () => {
        validateLineRange({
          lineStart: 1,
          lineEnd: 10,
          tail: 5,
          path: '/test/file.txt',
        });
      },
      {
        code: ErrorCode.E_INVALID_INPUT,
        messageIncludes: 'Cannot specify multiple',
      }
    );
  });

  void it('validateLineRange rejects head with tail', () => {
    expectMcpError(
      () => {
        validateLineRange({ head: 5, tail: 5, path: '/test/file.txt' });
      },
      {
        code: ErrorCode.E_INVALID_INPUT,
        messageIncludes: 'Cannot specify multiple',
      }
    );
  });

  void it('validateHeadTail accepts head only', () => {
    assert.doesNotThrow(() => {
      validateHeadTail(10);
    });
  });

  void it('validateHeadTail accepts tail only', () => {
    assert.doesNotThrow(() => {
      validateHeadTail(undefined, 10);
    });
  });

  void it('validateHeadTail accepts neither head nor tail', () => {
    assert.doesNotThrow(() => {
      validateHeadTail();
    });
  });

  void it('validateHeadTail rejects both head and tail', () => {
    expectMcpError(
      () => {
        validateHeadTail(5, 5);
      },
      {
        code: ErrorCode.E_INVALID_INPUT,
        messageIncludes: 'Cannot specify multiple',
      }
    );
  });
});
