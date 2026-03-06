import type { ToolContract } from '../tools/contract.js';
import { buildToolCatalogDetailsOnly } from './tool-catalog.js';
import {
  buildCoreContextPack,
  formatToolNameList,
  getSharedConstraints,
  getTaskCapableToolNames,
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
  const taskCapable = formatToolNameList(getTaskCapableToolNames());

  return `<role>
Filesystem agent. Scope: allowed roots only. Discover paths before acting — never guess.
</role>

<tools_overview>
| Category | Tools |
|----------|-------|
${buildToolsOverview()}
</tools_overview>

<resources>
- \`internal://instructions\`: Full usage reference.
- \`internal://tool-catalog\`: Tool routing and data flow.
- \`internal://workflows\`: Standard execution sequences.
- \`internal://tool-info/{name}\`: Per-tool nuances (e.g. \`internal://tool-info/read\`).
- \`filesystem-mcp://result/{id}\`: Cached large output — call \`resources/read\` immediately when \`resourceUri\` is returned.
- \`filesystem-mcp://metrics\`: Per-tool runtime metrics.
</resources>

<task_protocol>
Task execution: Tools returning a task ID must be polled via \`tasks/get\`, then retrieved via \`tasks/result\`.
Progress: Pass \`_meta.progressToken\` in \`tools/call\` to receive \`notifications/progress\`.
Task-capable: ${taskCapable}.
</task_protocol>
`;
}

const INSTRUCTIONS_FOOTER = `<constraints>
${getSharedConstraints()
  .map((c) => `- ${c}`)
  .join('\n')}
</constraints>

<error_handling>
- \`E_ACCESS_DENIED\` => call \`roots\`, use an allowed path.
- \`E_NOT_FOUND\` => call \`ls\` or \`find\`, verify spelling.
- \`E_TOO_LARGE\` => use \`head\`, line ranges, or \`read_many\`.
- \`E_TIMEOUT\` => reduce scope or result limits.
</error_handling>
`;

function formatToolSection(tool: ToolContract): string {
  const parts = [`### ${tool.name}\n${tool.description}`];

  if (tool.nuances && tool.nuances.length > 0) {
    parts.push(...tool.nuances.map((n) => `- Nuance: ${n}`));
  }

  if (tool.gotchas && tool.gotchas.length > 0) {
    parts.push(...tool.gotchas.map((g) => `- Gotcha: ${g}`));
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
    '<tool_reference>',
    toolSections,
    '</tool_reference>',
    '',
    buildWorkflowGuide(),
    '',
    INSTRUCTIONS_FOOTER,
  ].join('\n');
}
