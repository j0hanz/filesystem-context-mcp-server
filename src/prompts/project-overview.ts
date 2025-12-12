import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';

import { getAllowedDirectories } from '../lib/path-validation.js';

// Helper for path autocompletion
function pathCompleter(value: string): string[] {
  const dirs = getAllowedDirectories();
  const lowerValue = value.toLowerCase();
  return dirs.filter(
    (d) =>
      d.toLowerCase().includes(lowerValue) ||
      lowerValue.includes(d.toLowerCase().slice(0, 10))
  );
}

export function registerProjectOverviewPrompt(server: McpServer): void {
  server.registerPrompt(
    'project-overview',
    {
      description:
        'Quick overview of project structure, tech stack, and key files',
      argsSchema: {
        path: completable(
          z.string().min(1).describe('Project root path'),
          pathCompleter
        ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(10)
          .optional()
          .default(4)
          .describe('Tree depth (1-10, default: 4)'),
      },
    },
    ({ path, depth }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Analyze project at "${path}".

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Tools to use:**
1. \`directory_tree\` (maxDepth=${String(depth)}) → structure
2. \`analyze_directory\` → stats & largest files
3. \`read_multiple_files\` → config files (package.json, tsconfig.json, README.md, etc.)

**Provide:**
- Tech stack (languages, frameworks, build tools)
- Folder organization & conventions
- Entry points & key modules
- Dependencies overview
- Notable patterns or issues`,
          },
        },
      ],
    })
  );
}
