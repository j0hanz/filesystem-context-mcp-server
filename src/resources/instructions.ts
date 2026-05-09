import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';

import { ALL_TOOLS } from '../tools.js';
import type { ResourceContract } from './contract.js';

function pickAvailableToolNames(names: readonly string[]): string[] {
  const nameSet = new Set(ALL_TOOLS.map((c) => c.name));
  return names.filter((name) => nameSet.has(name));
}

function buildToolsOverview(): string {
  const rows: [string, string[]][] = [
    ['Navigate', pickAvailableToolNames(['roots', 'ls', 'tree', 'find'])],
    [
      'Inspect',
      pickAvailableToolNames(['stat', 'stat_many', 'grep', 'calculate_hash']),
    ],
    ['Read', pickAvailableToolNames(['read', 'read_many', 'diff_files'])],
    [
      'Write',
      pickAvailableToolNames([
        'mkdir',
        'write',
        'edit',
        'mv',
        'rm',
        'apply_patch',
        'search_and_replace',
      ]),
    ],
  ];

  const rowLines = rows
    .filter(([, names]) => names.length > 0)
    .map(([cat, names]) => `${cat}: ${names.join(', ')}`);
  return `\`\`\`\n${rowLines.join('\n')}\n\`\`\``;
}

export function buildServerInstructions(): string {
  const maxFileMb = Math.floor(MAX_TEXT_FILE_SIZE / 1024 / 1024);

  return `
    Guidelines:
    \`\`\`
    root_access: When using filesystem tools, operate strictly within allowed roots.
    path_resolution: Always resolve paths before acting — never assume.
    \`\`\`

    Tools Overview:
    ${buildToolsOverview()}

    Full schemas, descriptions, and annotations are in \`tools/list\`.

    Constraints:
    \`\`\`
    allowed_roots: Operate within allowed roots only (negotiated at startup via CLI).
    sensitive_paths: Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.
    enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.
    ephemeral_results: When a tool returns resourceUri, call resources/read immediately — cached results are ephemeral and expire after 30 min, eviction, or restart.
    \`\`\`

    Error Recovery:
    \`\`\`
    ACCESS_DENIED: Run roots to list allowed directories, retry with a valid path.
    NOT_FOUND: Run ls or find to verify the path.
    TOO_LARGE: Use head/tail, line ranges, or split across read_many.
    TIMEOUT: Reduce scope, depth, or maxResults.
    INVALID_INPUT: Re-read the tool schema in tools/list.
    \`\`\`
`;
}

export const SERVER_INSTRUCTIONS_CONTENT = buildServerInstructions();

export function createInstructionsResource(): ResourceContract {
  return {
    name: 'filesystem-mcp-instructions',
    title: 'Server Instructions',
    description: 'Navigation guide for filesystem-mcp tools and constraints.',
    mimeType: 'text/markdown',
    uri: 'internal://instructions',
    annotations: { audience: ['assistant'], priority: 0.8 },
    read(uri) {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'text/markdown',
            text: SERVER_INSTRUCTIONS_CONTENT,
          },
        ],
      };
    },
  };
}
