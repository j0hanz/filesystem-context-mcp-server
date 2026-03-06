import { buildCoreContextPack, pickAvailableToolNames } from './tool-info.js';

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
  return `<tool_selection_guide>
## Cross-Tool Data Flow

\`\`\`
${buildCrossToolDataFlow()}
\`\`\`

## Search Strategy

- \`find\`: glob file discovery.
- \`grep\`: text content search.
- \`search_and_replace\`: replacement only, not discovery.

## Write Strategy

- \`edit\`: precise first-occurrence replacements.
- \`write\`: create files or overwrite full contents.
- \`search_and_replace\`: bulk multi-file replacements.

### edit vs write vs search_and_replace Decision

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
