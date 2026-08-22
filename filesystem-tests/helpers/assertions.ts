import { ProtocolError } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';

export interface TestContentBlock {
  type: string;
  text?: string;
  uri?: string;
  blob?: string;
  mimeType?: string;
  [key: string]: unknown;
}

export interface ToolCallResult {
  isError?: boolean;
  content: TestContentBlock[];
  structuredContent?: unknown;
  requestState?: string;
  [key: string]: unknown;
}

/** Assert that a tool call succeeded with non-empty content. */
export function assertOk(result: unknown): void {
  const r = result as ToolCallResult;
  if (r.isError === true) {
    const text = r.content?.find((b) => typeof b.text === 'string')?.text ?? 'unknown error';
    assert.fail(`Expected success, got tool error: ${text}`);
  }
  assert.ok(Array.isArray(r.content) && r.content.length > 0, 'Result must contain content blocks');
}

/** Assert that a tool call returned an application-level isError: true result. */
export function assertToolError(result: unknown, expectedCode?: string): string {
  const r = result as ToolCallResult;
  assert.equal(r.isError, true, 'Expected result.isError to be true');
  const textBlock = r.content?.find((b) => typeof b.text === 'string');
  assert.ok(textBlock?.text, 'Error result must contain a text block');
  if (expectedCode !== undefined) {
    const match = /^([A-Z][A-Z0-9_]+):/u.exec(textBlock.text);
    assert.ok(match, `Expected "${expectedCode}: ..." error code format, got:\n${textBlock.text}`);
    assert.equal(match[1], expectedCode, `Expected error code ${expectedCode}, got ${match[1]}`);
  }
  return textBlock.text;
}

/** Extract structuredContent from a successful tool result. */
export function assertStructured(result: unknown): Record<string, unknown> {
  assertOk(result);
  const r = result as ToolCallResult;
  assert.ok(
    r.structuredContent !== undefined && r.structuredContent !== null,
    'structuredContent must be present on success results',
  );
  return r.structuredContent as Record<string, unknown>;
}

/** Assert that a tool call returned an SEP-2577 input_required prompt. */
export function assertInputRequired(result: unknown): {
  requestState: string;
  content: TestContentBlock[];
} {
  const r = result as ToolCallResult;
  assert.ok(r.requestState, 'Expected input_required result to include requestState token');
  return {
    requestState: r.requestState,
    content: r.content || [],
  };
}

/** Assert that an async operation rejected with a ProtocolError matching the code. */
export async function assertProtocolError(
  action: Promise<unknown>,
  expectedCode?: number | string,
): Promise<ProtocolError> {
  try {
    await action;
    assert.fail('Expected promise to reject with ProtocolError, but it resolved');
  } catch (err) {
    if (err instanceof ProtocolError) {
      if (expectedCode !== undefined) {
        assert.equal(
          err.code,
          expectedCode,
          `Expected ProtocolError code ${String(expectedCode)}, got ${String(err.code)}`,
        );
      }
      return err;
    }
    throw err;
  }
}
