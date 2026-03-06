export function buildWorkflowGuide(): string {
  return `<workflows>
### A: EXPLORE — directory layout or file content
1. \`roots\` → \`ls\` or \`tree\` → \`stat\`/\`stat_many\` → \`read\`/\`read_many\`.
   > **Strict:** Resolve paths first. Never guess.

### B: SEARCH — files by pattern or content
1. \`find\` (glob) → \`grep\` (content) → \`read\` (verify).
   > **Strict:** Content search with \`grep\`, not \`find\`.

### C: EDIT — modify files or layout
1. \`edit\` (targeted replacement) or \`search_and_replace\` (bulk).
2. \`mv\`/\`rm\` (layout) or \`mkdir\` (create dirs).
   > **Strict:** Confirm destructive ops (\`write\`, \`mv\`, \`rm\`, bulk replace).

### D: PATCH — apply unified diffs
1. \`diff_files\` → \`apply_patch(dryRun:true)\` → \`apply_patch\`.
   > **Tip:** Feed \`diff_files\` output directly. Multi-file patches: \`path\` = base dir, results per file.
</workflows>`;
}
