interface TraversalSummaryInput {
  totalFiles: number;
  totalDirectories: number;
  maxDepthReached?: number;
  truncated: boolean;
  skippedInaccessible: number;
  symlinksNotFollowed: number;
}

export function buildTraversalSummary(
  summary: TraversalSummaryInput
): TraversalSummaryInput {
  return {
    totalFiles: summary.totalFiles,
    totalDirectories: summary.totalDirectories,
    maxDepthReached: summary.maxDepthReached,
    truncated: summary.truncated,
    skippedInaccessible: summary.skippedInaccessible,
    symlinksNotFollowed: summary.symlinksNotFollowed,
  };
}
