export function buildWorkflowGuide(): string {
  return `<workflows>
### A: EXPLORE
Use when: you need directory layout or file content.
1. \`roots\` (list allowed paths).
2. \`ls\` (flat view) or \`tree\` (recursive view).
3. \`stat\` or \`stat_many\` (type and size checks).
4. \`read\` or \`read_many\` (read content).
   > **Strict:** Resolve paths first. Never guess.

### B: SEARCH
Use when: you need files by pattern or content.
1. \`find\` (glob candidates).
2. \`grep\` (content matches).
3. \`read\` (verify matched context).
   > **Strict:** Do content search with \`grep\`, not \`find\`.

### C: EDIT
Use when: you need to modify files or layout.
1. \`edit\` (targeted string replacement).
2. \`search_and_replace\` (bulk replacements).
3. \`mv\` or \`rm\` (layout changes).
4. \`mkdir\` (directory creation).
   > **Strict:** Confirm destructive ops (\`write\`, \`mv\`, \`rm\`, bulk replace).

### D: PATCH
Use when: applying unified diffs from \`diff_files\`.
1. \`diff_files\` (generate).
2. \`apply_patch\` (dryRun: true).
3. \`apply_patch\` (dryRun: false).
   > **Tip:** Feed \`diff_files\` output directly to \`apply_patch\`.
</workflows>`;
}
