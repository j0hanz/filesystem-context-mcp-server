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

// Operation configurations for cleaner prompt generation
const OPERATIONS: Record<string, { tools: string; deliverables: string }> = {
  explore: {
    tools: `1. \`directory_tree\` → hierarchy
2. \`analyze_directory\` → stats
3. \`list_directory\` sortBy="modified" → recent activity`,
    deliverables: `- Structure overview & folder purposes
- File distribution by type
- Key config/entry files
- Notable findings`,
  },
  'find-files': {
    tools: `1. \`search_files\` → find matches
2. \`read_multiple_files\` → examine contents
3. \`get_file_info\` → metadata if needed`,
    deliverables: `- Matched files with sizes
- Content summary
- Related pattern suggestions`,
  },
  'search-code': {
    tools: `1. \`search_content\` contextLines=2 → find pattern
2. \`read_multiple_files\` → full context`,
    deliverables: `- Match count & files affected
- Key matches with context
- Pattern usage analysis`,
  },
  'analyze-size': {
    tools: `1. \`analyze_directory\` → size stats
2. \`directory_tree\` includeSize=true → visualize
3. \`search_files\` → filter by type`,
    deliverables: `- Total size & counts
- Top 10 largest files
- Size by extension
- Cleanup suggestions`,
  },
  'recent-changes': {
    tools: `1. \`analyze_directory\` → recentlyModified
2. \`list_directory\` sortBy="modified"
3. \`read_multiple_files\` → examine changes`,
    deliverables: `- Recent activity timeline
- Active areas
- Change patterns`,
  },
};

export function registerFilesystemQueryPrompt(server: McpServer): void {
  server.registerPrompt(
    'filesystem-query',
    {
      description:
        'Guided filesystem operations: explore, find, search, size, changes',
      argsSchema: {
        path: completable(
          z.string().min(1).describe('Target path'),
          pathCompleter
        ),
        operation: z
          .enum([
            'explore',
            'find-files',
            'search-code',
            'analyze-size',
            'recent-changes',
          ])
          .describe('Operation type'),
        pattern: z
          .string()
          .optional()
          .describe('Search pattern (glob or regex)'),
        depth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe('Max depth (1-20, default: 5)'),
      },
    },
    ({ path, operation, pattern, depth }) => {
      const config = OPERATIONS[operation];
      const patternInfo = pattern ? ` pattern="${pattern}"` : '';
      const depthInfo =
        operation === 'explore' ? ` maxDepth=${String(depth)}` : '';

      const promptText = config
        ? `${operation.charAt(0).toUpperCase() + operation.slice(1)} "${path}"${patternInfo}${depthInfo}.

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Tools:**
${config.tools}

**Provide:**
${config.deliverables}`
        : `Perform "${operation}" at "${path}".`;

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: promptText,
            },
          },
        ],
      };
    }
  );
}
