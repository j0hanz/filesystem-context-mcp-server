export interface OperationSummary {
  truncated?: boolean;
  truncatedReason?: string;
  tip?: string;
  skippedInaccessible?: number;
  symlinksNotFollowed?: number;
  skippedTooLarge?: number;
  skippedBinary?: number;
  linesSkippedDueToRegexTimeout?: number;
}

export function formatOperationSummary(summary: OperationSummary): string {
  const lines: string[] = [];

  if (summary.truncated) {
    lines.push(
      `\n\n!! PARTIAL RESULTS: ${summary.truncatedReason ?? 'results truncated'}`
    );
    if (summary.tip) {
      lines.push(`Tip: ${summary.tip}`);
    }
  }

  if (summary.skippedTooLarge && summary.skippedTooLarge > 0) {
    lines.push(`Note: ${summary.skippedTooLarge} file(s) skipped (too large).`);
  }

  if (summary.skippedBinary && summary.skippedBinary > 0) {
    lines.push(`Note: ${summary.skippedBinary} file(s) skipped (binary).`);
  }

  if (summary.skippedInaccessible && summary.skippedInaccessible > 0) {
    lines.push(
      `Note: ${summary.skippedInaccessible} item(s) were inaccessible and skipped.`
    );
  }

  if (summary.symlinksNotFollowed && summary.symlinksNotFollowed > 0) {
    lines.push(
      `Note: ${summary.symlinksNotFollowed} symlink(s) were not followed (security).`
    );
  }

  if (
    summary.linesSkippedDueToRegexTimeout &&
    summary.linesSkippedDueToRegexTimeout > 0
  ) {
    lines.push(
      `Note: ${summary.linesSkippedDueToRegexTimeout} line(s) skipped (regex timeout).`
    );
  }

  return lines.join('\n');
}
