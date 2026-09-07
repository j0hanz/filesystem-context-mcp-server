import { createTwoFilesPatch, diffLines } from 'diff';

// Unified-diff computation over two text buffers. Kept out of `fmt.ts`, which
// formats terminal output and has no business pulling in the `diff` package.

export function computeDiffStats(
  original: string,
  modified: string,
): { linesAdded: number; linesRemoved: number } {
  // diffLines returns the change list synchronously on diff v9.
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const part of diffLines(original, modified)) {
    if (part.added) linesAdded += part.count;
    else if (part.removed) linesRemoved += part.count;
  }
  return { linesAdded, linesRemoved };
}

// createTwoFilesPatch returns the unified diff string synchronously on diff v9
// (the { callback } option fires via setTimeout and returns undefined).
export function unifiedPatch(label: string, original: string, modified: string): string {
  return createTwoFilesPatch(label, label, original, modified, 'Original', 'Modified');
}
