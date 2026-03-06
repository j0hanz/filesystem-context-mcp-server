import { formatToolNameList, pickAvailableToolNames } from './tool-info.js';

export function buildWorkflowGuide(): string {
  const exploreTools = formatToolNameList(
    pickAvailableToolNames([
      'roots',
      'ls',
      'tree',
      'stat',
      'stat_many',
      'read',
      'read_many',
    ])
  );
  const searchTools = formatToolNameList(
    pickAvailableToolNames(['find', 'grep', 'read'])
  );
  const editTools = formatToolNameList(
    pickAvailableToolNames(['edit', 'search_and_replace', 'mv', 'rm', 'mkdir'])
  );

  return `<workflows>
### A: EXPLORE — directory layout or file content
1. ${exploreTools}.
   > **Strict:** Resolve paths first. Never guess.

### B: SEARCH — files by pattern or content
1. ${searchTools}.
   > **Strict:** Content search with \`grep\`, not \`find\`.

### C: EDIT — modify files or layout
1. ${editTools}.
2. Use \`edit\` for targeted changes, \`search_and_replace\` for bulk changes, and \`mv\`/\`rm\`/\`mkdir\` for layout updates.
   > **Strict:** Confirm destructive ops (\`write\`, \`mv\`, \`rm\`, bulk replace).

### D: PATCH — apply unified diffs
1. \`diff_files\` → \`apply_patch(dryRun:true)\` → \`apply_patch\`.
   > **Tip:** Feed \`diff_files\` output directly. Multi-file patches: \`path\` = base dir, results per file.
</workflows>`;
}
