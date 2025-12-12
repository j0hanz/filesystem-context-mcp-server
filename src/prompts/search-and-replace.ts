import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';

import { buildExcludes, pathCompleter } from './shared.js';

// Extended excludes for search-and-replace (adds lock/minified files)
const SEARCH_REPLACE_EXCLUDES = buildExcludes('lockFiles', 'minified');

export function registerSearchAndReplacePrompt(server: McpServer): void {
  server.registerPrompt(
    'search-and-replace-plan',
    {
      description:
        'Plan search & replace with impact analysis and safety categorization (read-only analysis)',
      argsSchema: {
        path: completable(
          z.string().min(1).describe('Root path to search'),
          pathCompleter
        ),
        searchPattern: z
          .string()
          .min(1)
          .describe(
            'Search pattern (regex supported, use isLiteral=true for plain text)'
          ),
        replacement: z.string().describe('Replacement text'),
        filePattern: z
          .string()
          .optional()
          .default('**/*.{ts,js,tsx,jsx,py,java,go,rs,md,json}')
          .describe('File glob pattern'),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe('Case sensitive match'),
        wholeWord: z
          .boolean()
          .optional()
          .default(false)
          .describe('Match whole words only'),
        isLiteral: z
          .boolean()
          .optional()
          .default(false)
          .describe(
            'Treat search pattern as literal text (auto-escape regex chars)'
          ),
        maxResults: z
          .number()
          .int()
          .min(1)
          .max(500)
          .optional()
          .default(100)
          .describe('Maximum matches to analyze (default: 100)'),
      },
    },
    ({
      path,
      searchPattern,
      replacement,
      filePattern,
      caseSensitive,
      wholeWord,
      isLiteral,
      maxResults,
    }) => {
      const excludesJson = JSON.stringify(SEARCH_REPLACE_EXCLUDES);

      // Build search options string
      const searchOptions = [
        `pattern="${searchPattern}"`,
        `filePattern="${filePattern}"`,
        `excludePatterns=${excludesJson}`,
        'contextLines=2',
        `maxResults=${maxResults}`,
        `caseSensitive=${String(caseSensitive)}`,
        `wholeWord=${String(wholeWord)}`,
        `isLiteral=${String(isLiteral)}`,
      ].join(' ');

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `**Search & Replace Analysis** for "${path}"

⚠️ **READ-ONLY ANALYSIS** - This server cannot modify files. This prompt generates a replacement plan for manual execution or use with other tools.

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Operation:**
| Field | Value |
|-------|-------|
| Search | \`${searchPattern}\` |
| Replace | \`${replacement}\` |
| Files | \`${filePattern}\` |
| Case-sensitive | ${String(caseSensitive)} |
| Whole word | ${String(wholeWord)} |
| Literal (no regex) | ${String(isLiteral)} |
| Max results | ${maxResults} |

**Default excludes:** ${SEARCH_REPLACE_EXCLUDES.slice(0, 4).join(', ')}

**Workflow:**
1. \`search_content\` ${searchOptions}
2. \`read_multiple_files\` → batch examine files with complex matches

**Categorize each match:**
| Category | Criteria | Action |
|----------|----------|--------|
| ✅ **Safe** | Simple, isolated, no side effects | Auto-replaceable |
| ⚠️ **Review** | In comments, strings, or complex context | Manual verification needed |
| ❌ **Skip** | False positive, partial match, generated code | Do not replace |

**Impact Analysis:**
- API changes (function signatures, exports)
- Import/require statements
- Test files & assertions
- Documentation & comments
- Config files (may need special handling)

**Deliverables:**

1. **Summary Table:**
| File | Matches | Safe | Review | Skip |
|------|---------|------|--------|------|

2. **Diff Preview** (for each match):
\`\`\`diff
- {original line with match highlighted}
+ {line after replacement}
\`\`\`

3. **Execution Plan:**
- Phase 1: Safe replacements (list files)
- Phase 2: Review required (list files + concerns)
- Phase 3: Related updates (imports, tests, docs)

4. **Risk Assessment:**
- Breaking change likelihood (High/Medium/Low)
- Rollback strategy
- Files to backup first

⚠️ **If matches exceed ${maxResults}**: Report total count and recommend narrowing \`filePattern\` or \`searchPattern\`.`,
            },
          },
        ],
      };
    }
  );
}
