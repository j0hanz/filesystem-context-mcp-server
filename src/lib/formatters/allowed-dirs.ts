export function formatAllowedDirectories(dirs: string[]): string {
  if (dirs.length === 0) {
    return 'No directories are currently allowed.';
  }

  const lines = ['Allowed Directories:', ''];
  for (const dir of dirs) {
    lines.push(`  - ${dir}`);
  }

  return lines.join('\n');
}
