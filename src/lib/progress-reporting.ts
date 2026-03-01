export interface ProgressPayload {
  current: number;
  total?: number;
}

export type ProgressCallback =
  | ((progress: ProgressPayload) => void)
  | undefined;

export interface PeriodicProgressOptions {
  total?: number;
  throttleModulo?: number;
  force?: boolean;
}

export function reportPeriodicProgress(
  onProgress: ProgressCallback,
  current: number,
  options: PeriodicProgressOptions = {}
): void {
  if (!onProgress || current === 0) return;

  const throttleModulo = options.throttleModulo ?? 1;
  const force = options.force ?? false;
  if (!force && throttleModulo > 1 && current % throttleModulo !== 0) {
    return;
  }

  onProgress({
    current,
    ...(options.total !== undefined ? { total: options.total } : {}),
  });
}
