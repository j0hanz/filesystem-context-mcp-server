import { ALL_TOOLS } from '../tools.js';
import type { ToolContract } from '../tools/contract.js';

export function getToolContracts(): ToolContract[] {
  return ALL_TOOLS;
}

export function getSortedToolContracts(): ToolContract[] {
  return [...ALL_TOOLS].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

export function pickAvailableToolNames(names: readonly string[]): string[] {
  const nameSet = new Set(ALL_TOOLS.map((c) => c.name));
  return names.filter((name) => nameSet.has(name));
}

export function formatToolNameList(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(', ');
}
