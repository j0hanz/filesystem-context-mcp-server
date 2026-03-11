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

  return `<tool_selection_guide>
## Primitive Routing

- \`tools\`: model-controlled operations that inspect or mutate the allowed filesystem.
- \`resources\`: application-driven context such as \`internal://instructions\`, \`internal://tool-info/{name}\`, and cached \`filesystem-mcp://result/{id}\` output.
- \`prompts\`: user-controlled workflow templates for help, comparison, and guided inspection.
- \`completion\`: argument suggestions for prompts and resource templates; not a discovery mechanism.

## Cross-Tool Data Flow

\`\`\`
${buildCrossToolDataFlow()}
\`\`\`

## Result Contract

- Successful tools return \`content\` and \`structuredContent\` (when \`outputSchema\` is declared).
- When \`isError: true\`, \`structuredContent\` is omitted — parse the \`content\` text instead.
- Tool/business failures return \`isError: true\` inside the tool result, not a JSON-RPC protocol error.
- When a tool returns \`resourceUri\` or a \`resource_link\`, follow it with \`resources/read\` immediately.

## Task Mode Routing

- Inline first for fast operations.
- Add task mode only when the caller needs durable polling, deferred retrieval, or cancellation after the initial response.
- Task-capable tools: ${taskCapable.length > 0 ? taskCapable.map((name) => `\`${name}\``).join(', ') : 'none'}.

## Search Strategy

- \`find\`: glob file discovery.
- \`grep\`: text content search.
- \`search_and_replace\`: replacement only, not discovery.

## Write Strategy

1. **Single file, targeted change?** -> \`edit\` (match exact text, replace first occurrence)
2. **Single file, full rewrite?** -> \`write\` (overwrite entire content)
3. **Multiple files, same change?** -> \`search_and_replace\` (glob + pattern across files)
4. **Not sure what to change?** -> \`grep\` first, then decide

## Patch Management

- Generate patches with \`diff_files\` first.
- Validate with \`apply_patch(dryRun:true)\` before writing.
- \`apply_patch\` accepts unified diffs - single-file or multi-file.
- Multi-file: \`path\` is base directory; each file is best-effort with per-file \`results[]\`.
</tool_selection_guide>
`;
}

export function buildToolCatalog(): string {
  return `${buildCoreContextPack()}\n\n${buildCatalogGuide()}`;
}

export function buildToolCatalogDetailsOnly(): string {
  return buildCatalogGuide();
}
