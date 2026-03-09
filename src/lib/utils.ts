// type-guards.ts
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

// debounce
export function debounce<Args extends unknown[]>(
  func: (...args: Args) => void,
  waitMs: number
): { (...args: Args): void; cancel: () => void } {
  let timeoutId: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: Args): void => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }
    timeoutId = setTimeout(() => {
      timeoutId = undefined;
      func(...args);
    }, waitMs);
    // Unref if in Node environment to not block process exit
    const nodeTimeout = timeoutId as unknown as { unref?: () => void } | number;
    if (
      typeof nodeTimeout === 'object' &&
      typeof nodeTimeout.unref === 'function'
    ) {
      nodeTimeout.unref();
    }
  };
  debounced.cancel = () => {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
      timeoutId = undefined;
    }
  };
  return debounced;
}

// option-utils.ts
export function mergeOptions<T extends object>(
  defaults: T,
  overrides: Partial<T>
): T {
  return { ...defaults, ...overrides };
}

export function omitOptionKeys<T extends object, K extends keyof T>(
  input: T,
  keys: readonly K[]
): Omit<T, K> {
  const output = { ...input };
  for (const key of keys) {
    Reflect.deleteProperty(output, key);
  }
  return output as Omit<T, K>;
}

export function setIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

// progress-reporting.ts
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
