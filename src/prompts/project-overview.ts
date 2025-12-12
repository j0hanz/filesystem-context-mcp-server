import { completable } from '@modelcontextprotocol/sdk/server/completable.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { z } from 'zod';

import { buildExcludes, pathCompleter } from './shared.js';

// Extended excludes for project overview (adds framework-specific dirs)
const PROJECT_EXCLUDES = buildExcludes('nextjs', 'nuxtjs');

// Config files to look for by category
const CONFIG_FILES: Record<string, string[]> = {
  project: [
    'package.json',
    'pyproject.toml',
    'Cargo.toml',
    'go.mod',
    'pom.xml',
    'build.gradle',
  ],
  typescript: ['tsconfig.json', 'jsconfig.json'],
  build: [
    'vite.config.*',
    'webpack.config.*',
    'rollup.config.*',
    'next.config.*',
    'nuxt.config.*',
  ],
  lint: ['.eslintrc*', 'eslint.config.*', '.prettierrc*', 'biome.json'],
  docker: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml'],
  ci: ['.github/workflows/*.yml', '.gitlab-ci.yml'],
  docs: ['README.md', 'CHANGELOG.md', 'CONTRIBUTING.md', 'LICENSE'],
  env: ['.env.example', '.env.sample', '.env.template'],
};

// Build flat list of priority config files for the prompt
function getConfigFileList(): string {
  return Object.entries(CONFIG_FILES)
    .map(
      ([category, files]) =>
        `- **${category}**: ${files.slice(0, 3).join(', ')}`
    )
    .join('\n');
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
        includeCI: z
          .boolean()
          .optional()
          .default(false)
          .describe('Include CI/CD config analysis'),
      },
    },
    ({ path, depth, includeCI }) => {
      const excludesJson = JSON.stringify(PROJECT_EXCLUDES);
      const configList = getConfigFileList();

      // Priority files to always try reading
      const priorityFiles = [
        'package.json',
        'README.md',
        'tsconfig.json',
        ...(includeCI ? ['.github/workflows/*.yml'] : []),
      ];

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Analyze project at "${path}".

⚠️ First run \`list_allowed_directories\` to verify path is accessible.

**Default excludes:** ${PROJECT_EXCLUDES.slice(0, 4).join(', ')}

**Workflow:**
1. \`directory_tree\` maxDepth=${String(depth)} excludePatterns=${excludesJson} → structure
2. \`search_files\` pattern="*config*|*.json|*.toml|*.yml" excludePatterns=${excludesJson} → find config files
3. \`analyze_directory\` excludePatterns=${excludesJson} → stats & largest files
4. \`read_multiple_files\` → batch read found configs (priority: ${priorityFiles.join(', ')})

**Config files to look for:**
${configList}

**Deliverables:**

| Section | Details |
|---------|---------|
| **Tech Stack** | Languages, frameworks, runtime versions |
| **Package Manager** | npm/yarn/pnpm + lock file present |
| **Build System** | Bundler, compiler, scripts |
| **Folder Structure** | src/, lib/, tests/ conventions |
| **Entry Points** | main, bin, exports in package.json |
| **Dependencies** | Key deps vs devDeps, outdated indicators |
| **Code Quality** | Linting, formatting, type checking setup |
${includeCI ? '| **CI/CD** | Workflows, test/deploy pipelines |' : ''}

**Output Format:**
\`\`\`
## Project: {name}
**Type**: {monorepo|library|application|cli}
**Stack**: {languages} + {frameworks}
**Build**: {tool} → {output}

### Structure
{tree summary}

### Key Findings
- {finding 1}
- {finding 2}

### Recommendations
- {recommendation if any}
\`\`\``,
            },
          },
        ],
      };
    }
  );
}
