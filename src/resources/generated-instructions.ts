import type { ToolContract } from '../tools/contract.js';
import { buildToolCatalogDetailsOnly } from './tool-catalog.js';
import {
  buildCoreContextPack,
  getSharedConstraints,
  getToolContracts,
} from './tool-info.js';
import { buildWorkflowGuide } from './workflows.js';

const INSTRUCTIONS_HEADER = `<role>
Expert filesystem agent. Operate ONLY within allowed roots. Always discover before acting — never guess paths.
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
- \`filesystem-mcp://result/{id}\`: Large output cache. Call \`resources/read\` immediately if \`resourceUri\` is returned.
- \`filesystem-mcp://metrics\`: Live per-tool stats.
</resources>

<task_protocol>
Async execution: provide \`_meta.progressToken\` in \`tools/call\`, poll \`tasks/get\`, call \`tasks/result\`.
Task-capable: \`find\`, \`tree\`, \`read\`, \`read_many\`, \`stat_many\`, \`grep\`, \`mkdir\`, \`write\`, \`mv\`, \`rm\`, \`calculate_hash\`, \`apply_patch\`, \`search_and_replace\`.
</task_protocol>
`;

const INSTRUCTIONS_FOOTER = `<constraints>
${getSharedConstraints()
  .map((c) => `- ${c}`)
  .join('\n')}
</constraints>

<error_handling>
- \`E_ACCESS_DENIED\` → Call \`roots\`; use allowed path.
- \`E_NOT_FOUND\`     → Call \`ls\`/\`find\`; verify spelling.
- \`E_TOO_LARGE\`     → Use range/head or \`read_many\`.
- \`E_TIMEOUT\`       → Reduce scope or result limits.
</error_handling>
`;

function formatToolSection(tool: ToolContract): string {
  const parts = [`### ${tool.name}\n${tool.description}`];

  if (tool.nuances && tool.nuances.length > 0) {
    parts.push(...tool.nuances.map((n) => `» ${n}`));
  }

  if (tool.gotchas && tool.gotchas.length > 0) {
    parts.push(...tool.gotchas.map((g) => `⚠ ${g}`));
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
