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

export function registerSearchAndReplacePrompt(server: McpServer): void {
  server.registerPrompt(
    'search-and-replace-plan',
    {
      description:
        'Plan search & replace with impact analysis and safety categorization',
      argsSchema: {
        path: completable(
          z.string().min(1).describe('Root path to search'),
          pathCompleter
        ),
        searchPattern: z
          .string()
          .min(1)
          .describe('Search pattern (regex supported)'),
        replacement: z.string().describe('Replacement text'),
        filePattern: z
          .string()
          .optional()
          .default('**/*')
          .describe('File glob pattern'),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe('Case sensitive match'),
      },
    },
    ({ path, searchPattern, replacement, filePattern, caseSensitive }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Search & replace plan for "${path}".

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Replace:** \`${searchPattern}\` → \`${replacement}\`
**Files:** ${filePattern} | Case-sensitive: ${String(caseSensitive)}

**Workflow:**
1. \`search_content\` pattern="${searchPattern}" filePattern="${filePattern}" contextLines=2
2. \`read_file\` → examine complex matches

**Categorize matches:**
- ✅ Safe: auto-replaceable
- ⚠️ Review: needs verification
- ❌ Skip: false positives

**Deliverables:**
- Affected files with match counts
- Breaking changes (API, imports, tests, docs)
- Execution phases: safe → review → related updates
- Risk analysis & rollback strategy`,
          },
        },
      ],
    })
  );
}
