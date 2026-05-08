import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';

import type { ResourceContract } from './contract.js';
import { formatToolNameList, pickAvailableToolNames } from './tool-info.js';

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

  const header = '| Category | Tools |\n| -------- | ----- |';
  const rowLines = rows
    .filter(([, names]) => names.length > 0)
    .map(([cat, names]) => `| ${cat} | ${formatToolNameList(names)} |`);
  return `${header}\n${rowLines.join('\n')}`;
}

export function buildServerInstructions(): string {
  const maxFileMb = Math.floor(MAX_TEXT_FILE_SIZE / 1024 / 1024);

  return `<guidelines>
When using filesystem tools, operate strictly within allowed roots.
Always resolve paths before acting — never assume.
</guidelines>

<tools_overview>
${buildToolsOverview()}

Full schemas, descriptions, and annotations are in \`tools/list\`.
</tools_overview>

<constraints>
- Operate within allowed roots only (negotiated at startup via CLI).
- Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.
- Enforced limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.
- When a tool returns \`resourceUri\`, call \`resources/read\` immediately — cached results are ephemeral and expire after 30 min, eviction, or restart.
</constraints>

<error_recovery>
| Error Code | Action |
| --- | --- |
| \`ACCESS_DENIED\` | Run \`roots\` to list allowed directories, retry with a valid path. |
| \`NOT_FOUND\` | Run \`ls\` or \`find\` to verify the path. |
| \`TOO_LARGE\` | Use head/tail, line ranges, or split across \`read_many\`. |
| \`TIMEOUT\` | Reduce scope, depth, or maxResults. |
| \`INVALID_INPUT\` | Re-read the tool schema in \`tools/list\`. |
</error_recovery>`;
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
