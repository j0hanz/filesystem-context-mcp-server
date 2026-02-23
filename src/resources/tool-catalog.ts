import { buildCoreContextPack } from './tool-info.js';

const CATALOG_GUIDE = `## Tool Selection Guide

## Cross-Tool Data Flow

\`\`\`
find (results[].path) -> grep.paths
diff_files (patch text) -> apply_patch.patch
\`\`\`

## Search Strategy

- Use \`find\` for glob-based file discovery.
- Use \`grep\` for content-based searches.
- Use \`search_and_replace\` ONLY for bulk replacements, not for discovery.

## Write Strategy

- Use \`edit\` for precise, single-occurrence string replacements in existing files.
- Use \`write\` to create new files or completely overwrite existing content.
- Use \`search_and_replace\` for bulk regex replacements across multiple files.

## Patch Management

- Always generate a patch with \`diff_files\` first.
- Always use \`dryRun: true\` with \`apply_patch\` to verify changes.
- \`apply_patch\` works on unified diff format.
`;

export function buildToolCatalog(): string {
  return `${buildCoreContextPack()}\n\n${CATALOG_GUIDE}`;
}

export function buildToolCatalogDetailsOnly(): string {
  return CATALOG_GUIDE;
}
