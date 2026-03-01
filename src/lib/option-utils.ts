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
