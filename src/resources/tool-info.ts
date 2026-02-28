import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';
import { ALL_TOOLS } from '../tools.js';
import type { ToolContract } from '../tools/contract.js';

interface ToolEntry {
  name: string;
  description: string;
  annotations?: string[];
  nuances?: string[];
  gotchas?: string[];
}

function toEntry(contract: ToolContract): ToolEntry {
  const annotations: string[] = [];
  if (contract.annotations?.destructiveHint) annotations.push('[Destructive]');
  if (contract.annotations?.idempotentHint) annotations.push('[Idempotent]');
  if (contract.annotations?.readOnlyHint) annotations.push('[Read-Only]');

  return {
    name: contract.name,
    description: contract.description,
    ...(annotations.length > 0 ? { annotations } : {}),
    ...(contract.nuances && contract.nuances.length > 0
      ? { nuances: contract.nuances }
      : {}),
    ...(contract.gotchas && contract.gotchas.length > 0
      ? { gotchas: contract.gotchas }
      : {}),
  };
}

const ENTRIES = Object.fromEntries(
  ALL_TOOLS.map((contract) => [contract.name, toEntry(contract)])
) as Record<string, ToolEntry>;

export function getToolContracts(): ToolContract[] {
  return ALL_TOOLS;
}

export function buildCoreContextPack(): string {
  const names = Object.keys(ENTRIES).sort((a, b) => a.localeCompare(b));
  const rows = names.map((name) => {
    const e = ENTRIES[name];
    if (!e) return '';
    const annotations = e.annotations ? ` ${e.annotations.join(' ')}` : '';
    return `| \`${e.name}\` | ${e.description}${annotations} |`;
  });
  return `<core_context>\n| Tool | Purpose |\n|------|---------|\n${rows.join('\n')}\n</core_context>`;
}

export function getSharedConstraints(): string[] {
  return [
    'Use allowed roots only (provided by CLI negotiation).',
    'Sensitive paths are denylisted by default.',
    `Limits are enforced: max file size ${Math.floor(MAX_TEXT_FILE_SIZE / 1024 / 1024)}MB; search caps ${MAX_SEARCH_RESULTS} files and ${DEFAULT_SEARCH_CONTENT_RESULTS} lines.`,
    'If a response includes `resourceUri`, call `resources/read` immediately; cached results expire on process restart.',
  ];
}

export function buildToolInfo(name: string): string | undefined {
  const entry = ENTRIES[name];
  if (!entry) return undefined;

  const lines: string[] = [`## ${entry.name}`, '', entry.description];

  if (entry.annotations && entry.annotations.length > 0) {
    lines.push('', `**Hints:** ${entry.annotations.join(', ')}`);
  }

  if (entry.nuances && entry.nuances.length > 0) {
    lines.push('', '**Nuances:**');
    for (const nuance of entry.nuances) {
      lines.push(`- ${nuance}`);
    }
  }

  if (entry.gotchas && entry.gotchas.length > 0) {
    lines.push('', '**Gotchas:**');
    for (const gotcha of entry.gotchas) {
      lines.push(`- ${gotcha}`);
    }
  }

  return lines.join('\n');
}
