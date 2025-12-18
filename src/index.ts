#!/usr/bin/env node
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

process.on('SIGTERM', () => {
  process.exit(0);
});

process.on('SIGINT', () => {
  process.exit(0);
});

main().catch((error: unknown) => {
  console.error(
    'Fatal error:',
    error instanceof Error ? error.message : String(error)
  );
  process.exit(1);
});
