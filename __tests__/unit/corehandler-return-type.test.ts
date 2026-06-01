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

  // Verify ToolExecutor execute has explicit return type annotation
  const executeMatch =
    /async execute\(args: unknown, deps: ToolDeps\): Promise<CallToolResult>/.exec(fileContent);
  assert(
    executeMatch,
    'execute should have explicit return type annotation: Promise<CallToolResult>',
  );

  // Verify the unsafe cast has been removed
  assert(
    !fileContent.includes('as unknown as CallToolResult'),
    'Unsafe "as unknown as CallToolResult" cast should be removed',
  );

  // Verify createServerToolHandler has an explicit server-context handler return type.
  const serverCtxMatch =
    /function createServerToolHandler<[^>]+>\([\s\S]*?\): \(args: z\.infer<I>, ctx: ServerContext\) => Promise<CallToolResult>/.exec(
      fileContent,
    );
  assert(
    serverCtxMatch,
    'createServerToolHandler should have explicit return type annotation: (args: z.infer<I>, ctx: ServerContext) => Promise<CallToolResult>',
  );
});

test('CallToolResult type is correctly imported from MCP SDK', () => {
  // This is a compile-time type check; runtime passes if import succeeds
  const _: CallToolResult = {
    content: [{ type: 'text', text: 'test' }],
  };

  assert.equal(_.content[0].type, 'text', 'CallToolResult should have content property');
});
