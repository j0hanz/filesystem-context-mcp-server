import type { ToolContract } from '../tools/contract.js';
import type { ResourceContract } from './contract.js';
import { buildToolCatalogDetailsOnly } from './tool-catalog.js';
import {
  buildCoreContextPack,
  formatToolNameList,
  getSharedConstraints,
  getToolContracts,
  pickAvailableToolNames,
} from './tool-info.js';
import { buildWorkflowGuide } from './workflows.js';

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

  return rows
    .filter(([, names]) => names.length > 0)
    .map(
      ([category, names]) => `| ${category} | ${formatToolNameList(names)} |`
    )
    .join('\n');
}

function buildResourceTable(
  contracts: ReadonlyArray<Pick<ResourceContract, 'uri' | 'uriTemplate' | 'description'>>
): string {
  const header = '| URI | Purpose |\n| --- | ------- |';
  const rows = contracts.map((r) => {
    const uri = r.uriTemplate ?? r.uri ?? '';
    return `| \`${uri}\` | ${r.description} |`;
  });
  return `${header}\n${rows.join('\n')}`;
}

function buildInstructionsHeader(
  resourceContracts: ReadonlyArray<
    Pick<ResourceContract, 'uri' | 'uriTemplate' | 'description'>
  >
): string {
  return `## Role

Secure filesystem agent. Operate strictly within allowed roots. Resolve paths before acting — never assume.

## Tools Overview

| Category | Tools |
| -------- | ----- |

${buildToolsOverview()}

## Resources

${buildResourceTable(resourceContracts)}

## Task Protocol

- Check \`execution.taskSupport\` before sending task metadata.
  - \`forbidden\` (default): Do not send \`task\`.
  - \`optional\`: Send \`task\` only when durable polling or deferred retrieval is needed.
  - \`required\`: Always send \`task\`.
- Poll status via \`tasks/get\`, retrieve final payload via \`tasks/result\`.
- Pass \`_meta.progressToken\` in \`tools/call\` to receive \`notifications/progress\`.
`;
}

const INSTRUCTIONS_FOOTER = `## Constraints

${getSharedConstraints()
  .map((c) => `- ${c}`)
  .join('\n')}

## Error Recovery

| Error Code          | Action                                                                    |
| ------------------- | ------------------------------------------------------------------------- |
| \`ACCESS_DENIED\`   | Run \`roots\` to list allowed directories, retry with a valid path.       |
| \`NOT_FOUND\`       | Run \`ls\` or \`find\` to verify the path.                                |
| \`TOO_LARGE\`       | Use \`head\`/\`tail\`, line ranges, or split across \`read_many\`.        |
| \`TIMEOUT\`         | Reduce scope, depth, or maxResults.                                       |
| \`INVALID_INPUT\`   | Re-read tool contract via \`internal://tool-info/{name}\`.                |
`;

function formatToolSection(tool: ToolContract): string {
  const parts = [`### ${tool.name}\n${tool.description}`];

  if (tool.nuances && tool.nuances.length > 0) {
    parts.push(...tool.nuances.map((n) => `- ${n}`));
  }

  if (tool.gotchas && tool.gotchas.length > 0) {
    parts.push(...tool.gotchas.map((g) => `- ⚠ ${g}`));
  }

  return parts.join('\n');
}

export function buildServerInstructions(
  resourceContracts: ReadonlyArray<
    Pick<ResourceContract, 'uri' | 'uriTemplate' | 'description'>
  >
): string {
  const toolSections = getToolContracts().map(formatToolSection).join('\n\n');
  return [
    buildInstructionsHeader(resourceContracts),
    buildCoreContextPack(),
    '',
    buildToolCatalogDetailsOnly(),
    '',
    '## Tool Reference',
    '',
    toolSections,
    '',
    buildWorkflowGuide(),
    '',
    INSTRUCTIONS_FOOTER,
  ].join('\n');
}
