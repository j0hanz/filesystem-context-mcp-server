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
    pickAvailableToolNames([
      'edit',
      'write',
      'search_and_replace',
      'mv',
      'rm',
      'mkdir',
    ])
  );

  return `## Workflows

### A: Explore — Discover directory layout or file content

**Tools:** ${exploreTools}

1. Start with \`roots\` to identify allowed directories.
2. Use \`ls\` or \`tree\` to map structure, then \`stat\` or \`read\` for details.

> Resolve paths before acting. Never assume a path exists.

### B: Search — Find files by name or content

**Tools:** ${searchTools}

1. Use \`find\` for file name/glob matching.
2. Use \`grep\` for content search (supports regex).
3. Use \`read\` to inspect matched files.

> Use \`grep\` for content, \`find\` for filenames. Do not conflate them.

### C: Edit — Modify files or directory layout

**Tools:** ${editTools}

1. Use \`edit\` for targeted single-file changes (exact text match → replace).
2. Use \`search_and_replace\` for bulk changes across multiple files.
3. Use \`mv\`, \`rm\`, \`mkdir\` for structural changes.

> Confirm destructive operations (\`write\`, \`mv\`, \`rm\`, bulk replace) before executing.

### D: Patch — Generate and apply unified diffs

1. Generate: \`diff_files(original, modified)\`.
2. Validate: \`apply_patch(patch, dryRun: true)\`.
3. Apply: \`apply_patch(patch)\`.

> Multi-file patches: set \`path\` to the base directory. Results are reported per file.

### E: Task Mode — Deferred execution with polling

Use task mode for long-running operations when durable polling or cancellation is needed.
Only tools with \`execution.taskSupport: "optional"\` or \`"required"\` support this.

1. Send \`tools/call\` with \`task: {}\` in the request to create a task.
2. Poll \`tasks/get({ taskId })\` until status reaches \`completed\`, \`failed\`, or \`cancelled\`.
3. Retrieve the final result via \`tasks/result({ taskId })\`.
4. Cancel with \`tasks/cancel({ taskId })\` if no longer needed.

> Do not send \`task\` metadata to tools with \`taskSupport: "forbidden"\` (the default).
`;
}
