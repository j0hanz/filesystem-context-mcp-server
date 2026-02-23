import type { ToolContract } from '../tools/contract.js';
import { buildToolCatalogDetailsOnly } from './tool-catalog.js';
import {
  buildCoreContextPack,
  getSharedConstraints,
  getToolContracts,
} from './tool-info.js';
import { buildWorkflowGuide } from './workflows.js';

const INSTRUCTIONS_HEADER = `# FILESYSTEM-MCP INSTRUCTIONS

> Resource: \`internal://instructions\` | Prompt: \`get-help\`

## CORE CAPABILITY

- **Domain:** Safe local filesystem operations (read/write/diff/patch) within allowed roots.
- **Tools:**
  - READ: \`roots\`, \`ls\`, \`find\`, \`tree\`, \`read\`, \`read_many\`, \`stat\`, \`stat_many\`, \`grep\`, \`calculate_hash\`, \`diff_files\`.
  - WRITE: \`mkdir\`, \`write\`, \`edit\`, \`mv\`, \`rm\`, \`apply_patch\`, \`search_and_replace\`.

## RESOURCES

- \`filesystem-mcp://result/{id}\`: Ephemeral cached output.
- \`filesystem-mcp://metrics\`: Live tool stats.
- **Tip:** If response has \`resourceUri\`, call \`resources/read\` to fetch full content.

## PROGRESS & TASKS

- Support \`_meta.progressToken\` for updates.
- Task tools: \`find\`, \`tree\`, \`read\`, \`read_many\`, \`stat_many\`, \`grep\`, \`mkdir\`, \`write\`, \`mv\`, \`rm\`, \`calculate_hash\`, \`apply_patch\`, \`search_and_replace\`.
- Flow: \`tools/call\` (task) → \`tasks/get\` → \`tasks/result\`.

## GOLDEN PATH WORKFLOWS

See "Workflow Reference" below for detailed execution sequences.

`;

const INSTRUCTIONS_FOOTER = `
## CONSTRAINTS

${getSharedConstraints()
  .map((c) => `- ${c}`)
  .join('\n')}

## ERROR HANDLING

- \`E_ACCESS_DENIED\` → Call \`roots\`; use allowed path.
- \`E_NOT_FOUND\`     → Call \`ls\`/\`find\`; verify spelling.
- \`E_TOO_LARGE\`     → Use range/head or \`read_many\`.
- \`E_TIMEOUT\`       → Reduce scope or result limits.
`;

function formatToolSection(tool: ToolContract): string {
  const parts = [`${tool.name}: ${tool.description}`];

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
    '## TOOL REFERENCE',
    '',
    toolSections,
    '',
    buildWorkflowGuide(),
    '',
    '---',
    INSTRUCTIONS_FOOTER,
  ].join('\n');
}
