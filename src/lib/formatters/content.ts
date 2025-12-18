import type { ContentMatch } from '../../config/types.js';

const LINE_NUMBER_PAD_WIDTH = 4;

export function formatContentMatches(matches: ContentMatch[]): string {
  if (matches.length === 0) {
    return 'No matches found';
  }

  const lines = [`Found ${matches.length} matches:`, ''];

  const byFile = new Map<string, ContentMatch[]>();
  for (const match of matches) {
    const existing = byFile.get(match.file);
    if (existing) {
      existing.push(match);
    } else {
      byFile.set(match.file, [match]);
    }
  }

  for (const [file, fileMatches] of byFile) {
    lines.push(`${file}:`);
    for (const match of fileMatches) {
      if (match.contextBefore && match.contextBefore.length > 0) {
        for (let i = 0; i < match.contextBefore.length; i++) {
          const contextLine = match.contextBefore[i];
          const lineNum = match.line - match.contextBefore.length + i;
          lines.push(
            `    ${String(lineNum).padStart(LINE_NUMBER_PAD_WIDTH)}: ${contextLine ?? ''}`
          );
        }
      }
      lines.push(
        `  > ${String(match.line).padStart(LINE_NUMBER_PAD_WIDTH)}: ${match.content}`
      );
      if (match.contextAfter && match.contextAfter.length > 0) {
        for (let i = 0; i < match.contextAfter.length; i++) {
          const contextLine = match.contextAfter[i];
          const lineNum = match.line + 1 + i;
          lines.push(
            `    ${String(lineNum).padStart(LINE_NUMBER_PAD_WIDTH)}: ${contextLine ?? ''}`
          );
        }
      }
      if (
        (match.contextBefore && match.contextBefore.length > 0) ||
        (match.contextAfter && match.contextAfter.length > 0)
      ) {
        lines.push('    ---');
      }
    }
    lines.push('');
  }

  return lines.join('\n');
}
