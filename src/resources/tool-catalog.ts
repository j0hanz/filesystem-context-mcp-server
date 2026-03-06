import { buildCoreContextPack } from './tool-info.js';

const CATALOG_GUIDE = `<tool_selection_guide>
## Cross-Tool Data Flow

\`\`\`
find(results[].path) -> grep.paths
diff_files(patch) -> apply_patch.patch
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

1. **Single file, targeted change?** → \`edit\` (match exact text, replace first occurrence)
2. **Single file, full rewrite?** → \`write\` (overwrite entire content)
3. **Multiple files, same change?** → \`search_and_replace\` (glob + pattern across files)
4. **Not sure what to change?** → \`grep\` first, then decide

## Patch Management

- Generate patches with \`diff_files\` first.
- Validate with \`apply_patch(dryRun:true)\` before writing.
- \`apply_patch\` accepts unified diffs — single-file or multi-file.
- Multi-file: \`path\` is base directory; each file is best-effort with per-file \`results[]\`.
</tool_selection_guide>
`;

export function buildToolCatalog(): string {
  return `${buildCoreContextPack()}\n\n${CATALOG_GUIDE}`;
}

export function buildToolCatalogDetailsOnly(): string {
  return CATALOG_GUIDE;
}
