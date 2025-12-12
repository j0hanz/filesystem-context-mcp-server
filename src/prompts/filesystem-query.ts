import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';

import { DEFAULT_EXCLUDES, pathCompleter } from './shared.js';

// Operation configurations for cleaner prompt generation
interface OperationConfig {
  tools: string;
  deliverables: string;
  requiresPattern: boolean;
  usesDepth: boolean;
  maxResults?: number;
}

const OPERATIONS: Record<string, OperationConfig> = {
  explore: {
    tools: `1. \`directory_tree\` maxDepth={depth} excludePatterns={excludes} → hierarchy
2. \`analyze_directory\` excludePatterns={excludes} → stats
3. \`list_directory\` sortBy="modified" → recent activity`,
    deliverables: `- Structure overview & folder purposes
- File distribution by type
- Key config/entry files
- Notable findings`,
    requiresPattern: false,
    usesDepth: true,
  },
  'find-files': {
    tools: `1. \`search_files\` pattern="{pattern}" excludePatterns={excludes} maxResults=100 → find matches
2. \`read_multiple_files\` → batch examine contents
3. \`get_file_info\` → metadata if needed`,
    deliverables: `- Matched files with sizes (up to 100 results)
- Content summary of key files
- Related pattern suggestions`,
    requiresPattern: true,
    usesDepth: true,
    maxResults: 100,
  },
  'search-code': {
    tools: `1. \`search_content\` pattern="{pattern}" contextLines=2 maxResults=50 excludePatterns={excludes} → find matches
2. \`read_multiple_files\` → batch read for full context`,
    deliverables: `- Match count & files affected (up to 50 matches)
- Key matches with surrounding context
- Pattern usage analysis
- Suggested refactoring if duplicates found`,
    requiresPattern: true,
    usesDepth: false,
    maxResults: 50,
  },
  'analyze-size': {
    tools: `1. \`analyze_directory\` maxDepth={depth} excludePatterns={excludes} → size stats
2. \`directory_tree\` includeSize=true maxDepth={depth} excludePatterns={excludes} → visualize
3. \`search_files\` sortBy="size" maxResults=20 → largest files`,
    deliverables: `- Total size & file counts
- Top 10 largest files with paths
- Size breakdown by extension
- Cleanup suggestions (large/unused files)`,
    requiresPattern: false,
    usesDepth: true,
  },
  'recent-changes': {
    tools: `1. \`analyze_directory\` maxDepth={depth} excludePatterns={excludes} → recentlyModified
2. \`list_directory\` sortBy="modified" recursive=true maxDepth={depth}
3. \`read_multiple_files\` → batch examine recent files`,
    deliverables: `- Recent activity timeline (last 24h, 7d, 30d)
- Most active directories
- Change patterns & hot spots
- Files to review`,
    requiresPattern: false,
    usesDepth: true,
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
          .describe(
            'Search pattern (glob for find-files, regex for search-code)'
          ),
        depth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(5)
          .describe('Max depth (1-20, default: 5)'),
        caseSensitive: z
          .boolean()
          .optional()
          .default(false)
          .describe('Case-sensitive search (search-code only)'),
      },
    },
    ({ path, operation, pattern, depth, caseSensitive }) => {
      const config = OPERATIONS[operation];

      // Type guard - should never happen with enum validation, but TypeScript needs this
      if (!config) {
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `Unknown operation: "${operation}". Valid operations: ${Object.keys(OPERATIONS).join(', ')}`,
              },
            },
          ],
        };
      }

      const excludesJson = JSON.stringify(DEFAULT_EXCLUDES);

      // Validate pattern requirement
      if (config.requiresPattern && !pattern) {
        return {
          messages: [
            {
              role: 'user',
              content: {
                type: 'text',
                text: `⚠️ The "${operation}" operation requires a pattern.

Please provide:
- For **find-files**: a glob pattern (e.g., "**/*.ts", "src/**/*.json")
- For **search-code**: a regex pattern (e.g., "TODO|FIXME", "function\\s+\\w+")`,
              },
            },
          ],
        };
      }

      // Build tools section with substitutions
      const tools = config.tools
        .replace(/{depth}/g, String(depth))
        .replace(/{excludes}/g, excludesJson)
        .replace(/{pattern}/g, pattern ?? '*');

      // Build search options for search-code
      const searchOptions =
        operation === 'search-code'
          ? ` caseSensitive=${String(caseSensitive)}`
          : '';

      const patternInfo = pattern ? ` pattern="${pattern}"` : '';
      const depthInfo = config.usesDepth ? ` maxDepth=${String(depth)}` : '';

      const promptText = `**${operation.charAt(0).toUpperCase() + operation.slice(1)}** "${path}"${patternInfo}${depthInfo}${searchOptions}

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Default excludes:** ${DEFAULT_EXCLUDES.join(', ')}

**Tools:**
${tools}

**Deliverables:**
${config.deliverables}

**Best Practices:**
- Use \`read_multiple_files\` to batch read (more efficient than sequential reads)
- Stop early if results are sufficient
- Report any inaccessible paths encountered`;

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
