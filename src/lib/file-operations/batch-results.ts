export function createOutputSkeleton<T>(
  paths: string[],
  build: (filePath: string) => T
): T[] {
  return paths.map((filePath) => build(filePath));
}

export function applyParallelResults<T extends { path: string }>(
  output: T[],
  results: T[],
  errors: { index: number; error: Error }[],
  paths: string[],
  buildError: (filePath: string, error: Error) => T
): void {
  applySuccessResults(output, results, paths);
  applyErrorResults(output, errors, paths, buildError);
}

function applySuccessResults<T extends { path: string }>(
  output: T[],
  results: T[],
  paths: string[]
): void {
  for (const result of results) {
    const index = paths.indexOf(result.path);
    if (index !== -1 && output[index] !== undefined) {
      output[index] = result;
    }
  }
}

function applyErrorResults<T extends { path: string }>(
  output: T[],
  errors: { index: number; error: Error }[],
  paths: string[],
  buildError: (filePath: string, error: Error) => T
): void {
  for (const failure of errors) {
    const filePath = paths[failure.index] ?? '(unknown)';
    if (output[failure.index] !== undefined) {
      output[failure.index] = buildError(filePath, failure.error);
    }
  }
}
