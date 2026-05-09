import { ALL_TOOLS } from '../tools.js';

export function pickAvailableToolNames(names: readonly string[]): string[] {
  const nameSet = new Set(ALL_TOOLS.map((c) => c.name));
  return names.filter((name) => nameSet.has(name));
}
