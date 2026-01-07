import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { z } from 'zod';

import packageJsonRaw from '../package.json' with { type: 'json' };
import { ErrorCode, McpError } from './lib/errors.js';
import {
  logMissingDirectoriesIfNeeded,
  recomputeAllowedDirectories,
  registerRootHandlers,
  type ServerOptions,
  setServerOptions,
} from './server/roots.js';
import { registerAllTools } from './tools/index.js';
import { buildToolErrorResponse } from './tools/tool-response.js';

export { parseArgs } from './server/cli.js';
const PackageJsonSchema = z.object({ version: z.string() });
const { version: SERVER_VERSION } = PackageJsonSchema.parse(packageJsonRaw);

const currentDir = path.dirname(fileURLToPath(import.meta.url));
let serverInstructions = `
Filesystem Context MCP Server
(Detailed instructions failed to load - check logs)
`;
try {
  serverInstructions = await fs.readFile(
    path.join(currentDir, 'instructions.md'),
    'utf-8'
  );
} catch (error) {
  console.error(
    '[WARNING] Failed to load instructions.md:',
    error instanceof Error ? error.message : String(error)
  );
}

function resolveToolErrorCode(message: string): ErrorCode {
  const lower = message.toLowerCase();
  if (lower.includes('not found')) return ErrorCode.E_NOT_FOUND;
  if (
    lower.includes('invalid arguments') ||
    lower.includes('input validation')
  ) {
    return ErrorCode.E_INVALID_INPUT;
  }
  if (lower.includes('disabled')) return ErrorCode.E_INVALID_INPUT;
  if (lower.includes('requires task augmentation')) {
    return ErrorCode.E_INVALID_INPUT;
  }
  return ErrorCode.E_UNKNOWN;
}

type ToolErrorBuilder = (errorMessage: string) => {
  content: { type: 'text'; text: string }[];
  structuredContent: Record<string, unknown>;
  isError: true;
};

function patchToolErrorHandling(server: McpServer): void {
  const mutableServer = server as unknown as {
    createToolError: ToolErrorBuilder;
  };
  mutableServer.createToolError = (errorMessage: string) => {
    const code = resolveToolErrorCode(errorMessage);
    const error = new McpError(code, errorMessage);
    return buildToolErrorResponse(error, code);
  };
}

export function createServer(options: ServerOptions = {}): McpServer {
  setServerOptions(options);

  const server = new McpServer(
    {
      name: 'filesystem-context-mcp',
      version: SERVER_VERSION,
    },
    {
      instructions: serverInstructions || undefined,
      capabilities: {
        logging: {},
      },
    }
  );

  patchToolErrorHandling(server);
  registerAllTools(server);

  return server;
}

export async function startServer(server: McpServer): Promise<void> {
  const transport = new StdioServerTransport();

  registerRootHandlers(server);

  await recomputeAllowedDirectories();

  await server.connect(transport);

  logMissingDirectoriesIfNeeded();
}
