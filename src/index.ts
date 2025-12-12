#!/usr/bin/env node
/**
 * Filesystem Context MCP Server
 *
 * A secure, read-only MCP server for filesystem scanning and searching.
 * Provides tools for listing directories, reading files, searching content,
 * and analyzing directory structures.
 *
 * Security: All operations are restricted to explicitly allowed directories,
 * with symlink escape protection and path traversal prevention.
 *
 * Usage:
 *   filesystem-context-mcp /path/to/dir1 /path/to/dir2
 *   filesystem-context-mcp --allow-cwd  # Use current working directory
 *
 * Or with MCP Roots protocol (no CLI args needed).
 */
import { setAllowedDirectories } from './lib/path-validation.js';
import { createServer, parseArgs, startServer } from './server.js';

async function main(): Promise<void> {
  const { allowedDirs, allowCwd } = await parseArgs();

  if (allowedDirs.length > 0) {
    setAllowedDirectories(allowedDirs);
    console.error('Allowed directories (from CLI):');
  } else {
    console.error(
      `No directories specified via CLI. Will use MCP Roots${allowCwd ? ' or current working directory' : ''}.`
    );
  }

  const server = createServer({ allowCwd });
  await startServer(server);
}

// Graceful shutdown handlers
process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  process.exit(0);
});

// Run main and handle fatal errors
main().catch(() => {
  process.exit(1);
});
