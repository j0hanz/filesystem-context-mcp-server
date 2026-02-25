export function buildWorkflowGuide(): string {
  return `<workflows>
### A: EXPLORE
Use when: navigating an unfamiliar directory or reading file content.
1. \`roots\` (List allowed paths).
2. \`ls\` (files) | \`tree\` (structure).
3. \`stat\` | \`stat_many\` (size/type check).
4. \`read\` | \`read_many\` (content).
   > **Strict:** Never guess paths. Resolve first.

### B: SEARCH
Use when: locating files by name pattern or by content match.
1. \`find\` (glob candidates).
2. \`grep\` (content search).
3. \`read\` (verify context).
   > **Strict:** Use \`grep\` for content search, not \`find\`.

### C: EDIT
Use when: modifying existing files or reorganizing the filesystem.
1. \`edit\` (precise string match).
2. \`search_and_replace\` (bulk regex/glob).
3. \`mv\` | \`rm\` (file layout).
4. \`mkdir\` (create dirs).
   > **Strict:** Confirm destructive ops (\`write\`, \`mv\`, \`rm\`, bulk replace).

### D: PATCH
Use when: applying structured diffs produced by \`diff_files\`.
1. \`diff_files\` (generate).
2. \`apply_patch\` (dryRun: true).
3. \`apply_patch\` (dryRun: false).
   > **Tip:** Pass \`diff_files\` output directly into \`apply_patch\`.
</workflows>`;
}
