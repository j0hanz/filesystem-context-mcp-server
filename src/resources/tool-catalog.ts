import {
  buildCoreContextPack,
  getTaskCapableToolNames,
  pickAvailableToolNames,
} from './tool-info.js';

function buildCrossToolDataFlow(): string {
  const flows: string[] = [];

  if (pickAvailableToolNames(['find', 'read']).length === 2) {
    flows.push('find.results[].path -> read.path');
  }
  if (pickAvailableToolNames(['grep', 'read']).length === 2) {
    flows.push('grep.matches[].file -> read.path');
  }
  if (pickAvailableToolNames(['diff_files', 'apply_patch']).length === 2) {
    flows.push('diff_files.diff -> apply_patch.patch');
  }
  flows.push('toolResult.resourceUri -> resources/read.uri');

  return flows.join('\n');
}

function buildCatalogGuide(): string {
  const taskCapable = getTaskCapableToolNames();

  return `# Tool Selection Guide

## Primitive Routing

| Primitive | Purpose |
|-----------|---------|
| \`tools\` | Model-controlled operations that inspect or mutate the filesystem within allowed roots. |
| \`resources\` | Application-driven context: \`internal://instructions\`, \`internal://tool-info/{name}\`, cached \`filesystem-mcp://result/{id}\`. |
| \`prompts\` | User-controlled workflow templates for help, comparison, and guided inspection. |
| \`completion\` | Argument suggestions for prompts and resource templates (not a discovery mechanism). |

## Cross-Tool Data Flow

\`\`\`
${buildCrossToolDataFlow()}
\`\`\`

## Result Contract

- Success: returns both \`content\` (JSON text) and \`structuredContent\` (when \`outputSchema\` is declared).
- Error: \`isError: true\` in tool result, \`structuredContent\` omitted. Parse \`content\` text for error details.
- Tool/business failures use \`isError: true\` inside the tool result, not JSON-RPC protocol errors.
- When a response includes \`resourceUri\` or \`resource_link\`, follow up with \`resources/read\` immediately.

## Task Mode

Use inline execution by default. Add task mode only when the caller needs durable polling, deferred retrieval, or cancellation.

Task-capable tools: ${taskCapable.length > 0 ? taskCapable.map((name) => `\`${name}\``).join(', ') : 'none'}.

## Search Strategy

| Goal | Tool |
|------|------|
| Find files by name/glob | \`find\` |
| Search file contents | \`grep\` |
| Replace across files | \`search_and_replace\` (not for discovery) |

## Write Strategy

| Scenario | Tool |
|----------|------|
| Single file, targeted edit | \`edit\` — match exact text, replace first occurrence |
| Single file, full rewrite | \`write\` — overwrite entire content |
| Multiple files, same change | \`search_and_replace\` — glob + pattern across files |
| Unsure what to change | \`grep\` first, then decide |

## Patch Strategy

1. Generate with \`diff_files\`.
2. Validate with \`apply_patch(dryRun: true)\` before writing.
3. Apply with \`apply_patch\`.
4. Multi-file patches: set \`path\` to the base directory; results are per-file.
`;
}

export function buildToolCatalog(): string {
  return `${buildCoreContextPack()}\n\n${buildCatalogGuide()}`;
}

export function buildToolCatalogDetailsOnly(): string {
  return buildCatalogGuide();
}
