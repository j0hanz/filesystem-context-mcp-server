// Verify CallToolResult is available from MCP SDK
import type { CallToolResult } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

const __dirname = import.meta.dirname;

test('coreHandler has explicit Promise<CallToolResult> return type annotation', async () => {
  const defineFilePath = join(__dirname, '../../src/tools/define.ts');
  const fileContent = readFileSync(defineFilePath, 'utf-8');

  // Verify that CallToolResult is imported
  assert(
    fileContent.includes('CallToolResult'),
    'CallToolResult should be imported from @modelcontextprotocol/server',
  );

  // Verify coreHandler has explicit return type annotation
  const coreHandlerMatch =
    /const coreHandler = async \(args: unknown, ctx: ToolContext\): Promise<CallToolResult>/.exec(
      fileContent,
    );
  assert(
    coreHandlerMatch,
    'coreHandler should have explicit return type annotation: Promise<CallToolResult>',
  );

  // Verify the unsafe cast has been removed
  assert(
    !fileContent.includes('as unknown as CallToolResult'),
    'Unsafe "as unknown as CallToolResult" cast should be removed',
  );

  // Verify serverCtxHandler has proper return type (allow multi-line declarations with newlines before =>)
  const serverCtxMatch =
    /const serverCtxHandler = async[\s\S]*?\): Promise<CallToolResult> =>/.exec(fileContent);
  assert(
    serverCtxMatch,
    'serverCtxHandler should have return type annotation: Promise<CallToolResult> before =>',
  );
});

test('CallToolResult type is correctly imported from MCP SDK', () => {
  // This is a compile-time type check; runtime passes if import succeeds
  const _: CallToolResult = {
    content: [{ type: 'text', text: 'test' }],
  };

  assert.equal(_.content[0].type, 'text', 'CallToolResult should have content property');
});
