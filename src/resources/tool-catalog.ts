import { buildCoreContextPack } from './tool-info.js';

const CATALOG_GUIDE = `<tool_selection_guide>
## Cross-Tool Data Flow

\`\`\`
find (results[].path) -> grep.paths
diff_files (patch text) -> apply_patch.patch
\`\`\`

## Search Strategy

- Use \`find\` for glob file discovery.
- Use \`grep\` for text search.
- Use \`search_and_replace\` only for replacement, never discovery.

## Write Strategy

- Use \`edit\` for precise, first-occurrence replacements in existing files.
- Use \`write\` to create files or overwrite full contents.
- Use \`search_and_replace\` for bulk multi-file replacements.

## Patch Management

- Generate patches with \`diff_files\` first.
- Run \`apply_patch\` with \`dryRun: true\` before writing.
- \`apply_patch\` accepts unified diffs only.
</tool_selection_guide>
`;

export function buildToolCatalog(): string {
  return `${buildCoreContextPack()}\n\n${CATALOG_GUIDE}`;
}

export function buildToolCatalogDetailsOnly(): string {
  return CATALOG_GUIDE;
}
