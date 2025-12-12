import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';

import { DEFAULT_EXCLUDES, pathCompleter } from './shared.js';

// Extended excludes for codebase analysis (adds minified files)
const ANALYZE_EXCLUDES = [...DEFAULT_EXCLUDES, '*.min.js'];

// Focus-specific search patterns and deliverables
interface FocusConfig {
  patterns: string[];
  deliverables: string[];
  maxResults: number;
}

const FOCUS_CONFIG: Record<string, FocusConfig> = {
  architecture: {
    patterns: [
      'export (class|interface|type|function) \\w+',
      '^import .+ from',
      '@module|@package|@namespace',
    ],
    deliverables: [
      'Module organization & boundaries',
      'Dependency graph (imports/exports)',
      'Layer violations & circular deps',
      'Entry points & public API surface',
    ],
    maxResults: 100,
  },
  patterns: {
    patterns: [
      'class \\w+Factory|create\\w+\\(',
      'getInstance\\(|private constructor',
      'subscribe\\(|addEventListener\\(|on[A-Z]\\w+\\(',
      'implements \\w+(Strategy|Handler|Provider)',
    ],
    deliverables: [
      'Design patterns identified (Factory, Singleton, Observer, Strategy)',
      'Pattern usage frequency & locations',
      'Anti-patterns & code smells',
      'Refactoring opportunities',
    ],
    maxResults: 50,
  },
  quality: {
    patterns: [
      'TODO|FIXME|HACK|XXX|BUG',
      '@deprecated|@obsolete|@legacy',
      'console\\.(log|warn|error|debug)',
      'eslint-disable|@ts-ignore|@ts-expect-error',
    ],
    deliverables: [
      'Technical debt inventory with severity',
      'Debug/console statements left behind',
      'Suppressed linting rules',
      'Documentation coverage gaps',
    ],
    maxResults: 100,
  },
  security: {
    patterns: [
      'eval\\(|new Function\\(|exec\\(',
      'password|secret|api_?key|token|credential',
      'innerHTML|dangerouslySetInnerHTML|outerHTML',
      'process\\.env\\.|\\$\\{.*SECRET|\\$\\{.*KEY',
    ],
    deliverables: [
      'Potential code injection vulnerabilities',
      'Hardcoded secrets & credentials',
      'Unsafe DOM manipulation',
      'Environment variable exposure',
    ],
    maxResults: 50,
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
          .default('**/*.{ts,js,tsx,jsx,py,java,go,rs}')
          .describe('Source file glob pattern'),
        maxDepth: z
          .number()
          .int()
          .min(1)
          .max(20)
          .optional()
          .default(10)
          .describe('Maximum directory depth (default: 10)'),
      },
    },
    ({ path, focus, filePattern, maxDepth }) => {
      const focusAreas = focus === 'all' ? Object.keys(FOCUS_CONFIG) : [focus];
      const allPatterns = focusAreas.flatMap(
        (f) => FOCUS_CONFIG[f]?.patterns ?? []
      );
      const allDeliverables = focusAreas.flatMap(
        (f) => FOCUS_CONFIG[f]?.deliverables ?? []
      );
      const maxResults = Math.min(
        ...focusAreas.map((f) => FOCUS_CONFIG[f]?.maxResults ?? 100)
      );

      const excludesJson = JSON.stringify(ANALYZE_EXCLUDES);

      // Build search instructions for each focus area
      const searchInstructions = focusAreas
        .map((f) => {
          const config = FOCUS_CONFIG[f];
          if (!config) return '';
          return `   - **${f}**: \`${config.patterns.slice(0, 2).join('` or `')}\``;
        })
        .filter(Boolean)
        .join('\n');

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Analyze codebase at "${path}" (focus: **${focus}**).

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Default excludes:** ${ANALYZE_EXCLUDES.slice(0, 4).join(', ')}

**Workflow:**
1. \`directory_tree\` maxDepth=${maxDepth} excludePatterns=${excludesJson} → structure overview
2. \`search_files\` pattern="${filePattern}" excludePatterns=${excludesJson} → find source files
3. \`analyze_directory\` maxDepth=${maxDepth} excludePatterns=${excludesJson} → stats & hotspots
4. \`search_content\` contextLines=2 maxResults=${maxResults} excludePatterns=${excludesJson} → search for:
${searchInstructions}
5. \`read_multiple_files\` → batch examine key files (most efficient)

**Regex patterns to search:**
${allPatterns.map((p) => `- \`${p}\``).join('\n')}

**Deliverables:**
${allDeliverables.map((d) => `- ${d}`).join('\n')}

**Final Report:**
- Executive summary (1-2 paragraphs)
- Findings by category with file:line references
- Prioritized recommendations (High/Medium/Low)
- Quick wins vs long-term improvements`,
            },
          },
        ],
      };
    }
  );
}
