// type-guards.ts
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

// debounce
export function debounce<Args extends unknown[]>(
  func: (...args: Args) => void,
  waitMs: number,
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
    timeoutId.unref();
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
export function mergeOptions<T extends object>(defaults: T, overrides: Partial<T>): T {
  return { ...defaults, ...overrides };
}

export function omitOptionKeys<T extends object, K extends keyof T>(
  input: T,
  keys: readonly K[],
): Omit<T, K> {
  const keySet = new Set<PropertyKey>(keys as readonly PropertyKey[]);
  const output = Object.fromEntries(Object.entries(input).filter(([key]) => !keySet.has(key)));
  return output as Omit<T, K>;
}

/**
 * Mutates `target` by copying every property from `source` whose value is not
 * `undefined`. Designed for assembling structured tool outputs under
 * `exactOptionalPropertyTypes`, where `undefined` cannot be assigned to
 * optional properties.
 */
export function assignDefined<T extends object>(
  target: T,
  source: { [K in keyof T]?: T[K] | undefined },
): T {
  for (const key of Object.keys(source) as (keyof T)[]) {
    const value = source[key];
    if (value !== undefined) {
      (target as Record<PropertyKey, unknown>)[key] = value;
    }
  }
  return target;
}
