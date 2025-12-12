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

export function registerFindDuplicatesPrompt(server: McpServer): void {
  server.registerPrompt(
    'find-duplicates',
    {
      description:
        'Find duplicate code, similar patterns, and refactoring opportunities',
      argsSchema: {
        path: completable(
          z.string().min(1).describe('Root path to search'),
          pathCompleter
        ),
        pattern: z
          .string()
          .optional()
          .default('**/*.{ts,js,tsx,jsx,py,java}')
          .describe('Source file glob pattern'),
        searchTerm: z
          .string()
          .optional()
          .describe('Specific function/pattern to find duplicates of'),
      },
    },
    ({ path, pattern, searchTerm }) => {
      const searchInstructions = searchTerm
        ? `\`search_content\` → find all "${searchTerm}" occurrences`
        : `\`search_content\` → find duplicates: function signatures, imports, utility patterns`;

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Find duplicates in "${path}".

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Workflow:**
1. \`search_files\` pattern="${pattern}" → list files
2. \`analyze_directory\` → find similar-sized files
3. ${searchInstructions}
4. \`read_multiple_files\` → compare suspects

**Report:**
- **Exact duplicates**: identical code blocks
- **Near duplicates**: similar code with variations
- **Patterns to abstract**: repeated logic → utilities
- **Refactoring plan**: files affected, proposed changes, risks`,
            },
          },
        ],
      };
    }
  );
}
