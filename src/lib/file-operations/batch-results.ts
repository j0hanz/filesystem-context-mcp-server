export function createOutputSkeleton<T>(
  paths: string[],
  build: (filePath: string) => T
): T[] {
  return paths.map((filePath) => build(filePath));
}

interface IndexedResult<T> {
  index: number;
  value: T;
}

export function applyParallelResults<T extends { path: string }>(
  output: T[],
  results: IndexedResult<T>[],
  errors: { index: number; error: Error }[],
  paths: string[],
  buildError: (filePath: string, error: Error) => T
): void {
  applySuccessResults(output, results);
  applyErrorResults(output, errors, paths, buildError);
}

function applySuccessResults<T extends { path: string }>(
  output: T[],
  results: IndexedResult<T>[]
): void {
  for (const result of results) {
    if (output[result.index] !== undefined) {
      output[result.index] = result.value;
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
