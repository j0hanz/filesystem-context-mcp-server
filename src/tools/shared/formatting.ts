const BYTE_UNIT_LABELS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';
  const unitIndex = Math.floor(Math.log(bytes) / Math.log(1024));
  const unit = BYTE_UNIT_LABELS[unitIndex] ?? 'B';
  const value = bytes / Math.pow(1024, unitIndex);
  return `${parseFloat(value.toFixed(2))} ${unit}`;
}

export function formatDate(date: Date): string {
  return date.toISOString();
}

export function formatOperationSummary(summary: {
  truncated?: boolean;
  truncatedReason?: string;
  tip?: string;
  skippedInaccessible?: number;
  symlinksNotFollowed?: number;
  skippedTooLarge?: number;
  skippedBinary?: number;
  linesSkippedDueToRegexTimeout?: number;
}): string {
  const lines: string[] = [];
  if (summary.truncated) {
    lines.push(
      `!! PARTIAL RESULTS: ${summary.truncatedReason ?? 'results truncated'}`
    );
    if (summary.tip) lines.push(`Tip: ${summary.tip}`);
  }
  const note = (count: number | undefined, msg: string): void => {
    if (count && count > 0) lines.push(`Note: ${count} ${msg}`);
  };
  note(summary.skippedTooLarge, 'file(s) skipped (too large).');
  note(summary.skippedBinary, 'file(s) skipped (binary).');
  note(summary.skippedInaccessible, 'item(s) were inaccessible and skipped.');
  note(summary.symlinksNotFollowed, 'symlink(s) were not followed (security).');
  note(
    summary.linesSkippedDueToRegexTimeout,
    'line(s) skipped (regex timeout).'
  );
  return lines.join('\n');
}
