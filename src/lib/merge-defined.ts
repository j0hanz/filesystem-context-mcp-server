export function mergeDefined<T extends object>(
  defaults: T,
  overrides: Partial<T>
): T {
  const entries = Object.entries(overrides).filter(
    ([, value]) => value !== undefined
  );
  return {
    ...defaults,
    ...(Object.fromEntries(entries) as Partial<T>),
  };
}
