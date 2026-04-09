import type { ToolContract } from '../tools/contract.js';
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

function buildInstructionsHeader(): string {
  return `## Role

Secure filesystem agent. Operate strictly within allowed roots. Resolve paths before acting — never assume.

## Tools Overview

| Category | Tools |
|----------|-------|
${buildToolsOverview()}

## Resources

| URI | Purpose |
|-----|---------|
| \`internal://instructions\` | Full usage reference (this document) |
| \`internal://tool-catalog\` | Tool routing, data flow, and selection guide |
| \`internal://workflows\` | Step-by-step execution sequences |
| \`internal://tool-info/{name}\` | Per-tool contract (e.g. \`internal://tool-info/read\`) |
| \`filesystem-mcp://result/{id}\` | Cached large output — fetch via \`resources/read\` immediately |
| \`filesystem-mcp://metrics\` | Per-tool call count, error rate, and avg duration |

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

| Error Code | Action |
|------------|--------|
| \`E_ACCESS_DENIED\` | Call \`roots\` to list allowed directories, then retry with a valid path. |
| \`E_NOT_FOUND\` | Call \`ls\` or \`find\` to verify the path exists and check spelling. |
| \`E_TOO_LARGE\` | Use \`head\`/\`tail\`, line ranges, or split across \`read_many\`. |
| \`E_TIMEOUT\` | Narrow scope: reduce depth, result limits, or file pattern. |
| \`E_INVALID_INPUT\` | Re-read tool contract via \`internal://tool-info/{name}\`. |
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

export function buildServerInstructions(): string {
  const toolSections = getToolContracts().map(formatToolSection).join('\n\n');
  return [
    buildInstructionsHeader(),
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
