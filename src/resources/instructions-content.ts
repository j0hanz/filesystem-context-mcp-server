import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';

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

export function buildSlimInstructions(): string {
  const maxFileMb = Math.floor(MAX_TEXT_FILE_SIZE / 1024 / 1024);

  return `## Role

Secure filesystem agent. Operate strictly within allowed roots.
Resolve paths before acting — never assume.

## Tools Overview

${buildToolsOverview()}

Full schemas, descriptions, and annotations are in \`tools/list\`.

## Constraints

- Operate within allowed roots only (negotiated at startup via CLI).
- Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.
- Enforced limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.
- When a tool returns \`resourceUri\`, call \`resources/read\` immediately — cached results are ephemeral and expire after 30 min, eviction, or restart.

## Error Recovery

| Error Code        | Action                                                            |
| ----------------- | ----------------------------------------------------------------- |
| \`ACCESS_DENIED\` | Run \`roots\` to list allowed directories, retry with a valid path. |
| \`NOT_FOUND\`     | Run \`ls\` or \`find\` to verify the path.                        |
| \`TOO_LARGE\`     | Use head/tail, line ranges, or split across \`read_many\`.        |
| \`TIMEOUT\`       | Reduce scope, depth, or maxResults.                               |
| \`INVALID_INPUT\` | Re-read the tool schema in \`tools/list\`.                        |
`;
}

export const SLIM_INSTRUCTIONS_CONTENT = buildSlimInstructions();
