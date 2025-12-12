import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';

import { buildExcludes, pathCompleter } from './shared.js';

// Extended excludes for duplicate scanning (adds minified/bundled files to base excludes)
const DUPLICATE_EXCLUDES = buildExcludes('minified', 'bundled');

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
        minLines: z
          .number()
          .int()
          .min(2)
          .max(50)
          .optional()
          .default(5)
          .describe('Minimum lines to consider as duplicate (default: 5)'),
      },
    },
    ({ path, pattern, searchTerm, minLines }) => {
      const excludePatterns = JSON.stringify(DUPLICATE_EXCLUDES);

      const searchInstructions = searchTerm
        ? `\`search_content\` pattern="${searchTerm}" contextLines=2 → find all occurrences`
        : `\`search_content\` → find duplicates using these patterns:
- Function signatures: \`(export )?(async )?(function|const)\\s+\\w+\`
- Import blocks: \`^import .+ from\`
- Error handlers: \`catch\\s*\\(\` or \`\\.catch\\(\`
- Repeated utility patterns: loops, conditionals, API calls`;

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Find duplicate code in "${path}".

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Workflow:**
1. \`search_files\` pattern="${pattern}" excludePatterns=${excludePatterns}
2. \`analyze_directory\` excludePatterns=${excludePatterns} → identify similar-sized files (potential copies)
3. ${searchInstructions}
4. \`read_multiple_files\` → batch compare suspect files

**Duplicate Detection Criteria (minimum ${minLines} lines):**
- Code blocks that are character-for-character identical
- Code with only variable/parameter name differences
- Structural duplicates: same logic, different formatting

**Report Format:**
| Category | Description |
|----------|-------------|
| **Exact duplicates** | Identical code blocks with file:line locations |
| **Near duplicates** | 80%+ similar code, highlight differences |
| **Extractable patterns** | Repeated logic → shared utility/hook candidates |
| **Refactoring plan** | Priority order, files affected, breaking change risks |

**For each duplicate found, provide:**
1. File locations (all occurrences)
2. Code snippet (first occurrence)
3. Suggested abstraction (function name, module location)`,
            },
          },
        ],
      };
    }
  );
}
