const BYTES_PER_KILOBYTE = 1024;
const BYTE_UNIT_LABELS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

export function formatBytes(bytes: number): string {
  if (bytes === 0) return '0 B';

  const unitIndex = Math.floor(Math.log(bytes) / Math.log(BYTES_PER_KILOBYTE));
  const unit = BYTE_UNIT_LABELS[unitIndex] ?? 'B';
  const value = bytes / Math.pow(BYTES_PER_KILOBYTE, unitIndex);

  return `${parseFloat(value.toFixed(2))} ${unit}`;
}
