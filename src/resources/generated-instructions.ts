import type { ToolContract } from '../tools/contract.js';
import { buildToolCatalogDetailsOnly } from './tool-catalog.js';
import {
  buildCoreContextPack,
  getSharedConstraints,
  getToolContracts,
} from './tool-info.js';
import { buildWorkflowGuide } from './workflows.js';

const INSTRUCTIONS_HEADER = `<role>
Filesystem agent for local paths only. Operate inside allowed roots. Discover before action. Never guess paths.
</role>

<tools_overview>
| Category | Tools |
|----------|-------|
| Navigate | \`roots\`, \`ls\`, \`tree\`, \`find\` |
| Inspect  | \`stat\`, \`stat_many\`, \`grep\`, \`calculate_hash\` |
| Read     | \`read\`, \`read_many\`, \`diff_files\` |
| Write    | \`mkdir\`, \`write\`, \`edit\`, \`mv\`, \`rm\`, \`apply_patch\`, \`search_and_replace\` |
</tools_overview>

<resources>
- \`internal://instructions\`: Full usage reference.
- \`internal://tool-catalog\`: Tool routing and data-flow rules.
- \`internal://workflows\`: Standard execution sequences.
- \`internal://tool-info/{name}\`: Per-tool nuances and gotchas (example: \`internal://tool-info/read\`).
- \`filesystem-mcp://result/{id}\`: Cached large output. If \`resourceUri\` is returned, call \`resources/read\` immediately.
- \`filesystem-mcp://metrics\`: Per-tool runtime metrics.
</resources>

<task_protocol>
Async execution: pass \`_meta.progressToken\` in \`tools/call\`, poll \`tasks/get\`, then call \`tasks/result\`.
Task-capable: \`find\`, \`tree\`, \`read\`, \`read_many\`, \`stat_many\`, \`grep\`, \`mkdir\`, \`write\`, \`mv\`, \`rm\`, \`calculate_hash\`, \`apply_patch\`, \`search_and_replace\`.
</task_protocol>
`;

const INSTRUCTIONS_FOOTER = `<constraints>
${getSharedConstraints()
  .map((c) => `- ${c}`)
  .join('\n')}
</constraints>

<error_handling>
- \`E_ACCESS_DENIED\` => call \`roots\`, then use an allowed path.
- \`E_NOT_FOUND\` => call \`ls\` or \`find\`, then verify spelling.
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
    INSTRUCTIONS_HEADER,
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
