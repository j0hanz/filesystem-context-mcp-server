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

// Focus-specific search patterns and deliverables
const FOCUS_CONFIG: Record<
  string,
  { searches: string[]; deliverables: string[] }
> = {
  architecture: {
    searches: [
      'class/interface definitions',
      'exports/imports',
      'module boundaries',
    ],
    deliverables: [
      'Module organization',
      'Dependency flow',
      'Layering patterns',
    ],
  },
  patterns: {
    searches: ['Factory', 'Singleton', 'Observer', 'common design patterns'],
    deliverables: ['Identified patterns', 'Usage analysis', 'Effectiveness'],
  },
  quality: {
    searches: ['TODO', 'FIXME', 'HACK', '@deprecated'],
    deliverables: [
      'Technical debt',
      'Documentation coverage',
      'Code consistency',
    ],
  },
  security: {
    searches: ['eval', 'exec', 'password', 'secret', 'token', 'api_key'],
    deliverables: [
      'Vulnerabilities',
      'Hardcoded secrets',
      'Input validation gaps',
    ],
  },
};

export function registerAnalyzeCodebasePrompt(server: McpServer): void {
  server.registerPrompt(
    'analyze-codebase',
    {
      description:
        'Deep code analysis: architecture, patterns, quality, or security',
      argsSchema: {
        path: completable(
          z.string().min(1).describe('Codebase root path'),
          pathCompleter
        ),
        focus: z
          .enum(['architecture', 'patterns', 'quality', 'security', 'all'])
          .optional()
          .default('all')
          .describe('Focus: architecture, patterns, quality, security, or all'),
        filePattern: z
          .string()
          .optional()
          .default('**/*.{ts,js,py,java,go,rs}')
          .describe('Source file glob pattern'),
      },
    },
    ({ path, focus, filePattern }) => {
      const focusAreas = focus === 'all' ? Object.keys(FOCUS_CONFIG) : [focus];
      const searches = focusAreas.flatMap(
        (f) => FOCUS_CONFIG[f]?.searches ?? []
      );
      const deliverables = focusAreas.flatMap(
        (f) => FOCUS_CONFIG[f]?.deliverables ?? []
      );

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Analyze codebase at "${path}" (focus: ${focus}).

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Workflow:**
1. \`directory_tree\` → structure overview
2. \`search_files\` pattern="${filePattern}" → find source files
3. \`analyze_directory\` → stats & hotspots
4. \`search_content\` → find: ${searches.join(', ')}
5. \`read_multiple_files\` → examine key files

**Deliverables:**
${deliverables.map((d) => `- ${d}`).join('\n')}
- Prioritized recommendations`,
            },
          },
        ],
      };
    }
  );
}
