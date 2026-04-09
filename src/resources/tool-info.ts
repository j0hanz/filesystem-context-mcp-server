import { z } from 'zod';

import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
} from '../lib/constants.js';

import { ALL_TOOLS } from '../tools.js';
import type { ToolContract } from '../tools/contract.js';

interface ToolEntry {
  name: string;
  title: string;
  description: string;
  annotations?: string[];
  nuances?: string[];
  gotchas?: string[];
}

interface JsonSchemaObject {
  type?: unknown;
  properties?: Record<string, JsonSchemaObject>;
  required?: string[];
  description?: unknown;
  enum?: unknown[];
  const?: unknown;
  anyOf?: JsonSchemaObject[];
  oneOf?: JsonSchemaObject[];
  prefixItems?: JsonSchemaObject[];
  items?: JsonSchemaObject;
  additionalProperties?: unknown;
}

function getTaskSupportLabel(
  taskSupport: ToolContract['taskSupport']
): string | undefined {
  switch (taskSupport) {
    case 'optional':
      return '[Task: Optional]';
    case 'required':
      return '[Task: Required]';
    default:
      return undefined;
  }
}

function toEntry(contract: ToolContract): ToolEntry {
  const annotations: string[] = [];
  if (contract.annotations?.destructiveHint) annotations.push('[Destructive]');
  if (contract.annotations?.idempotentHint) annotations.push('[Idempotent]');
  if (contract.annotations?.readOnlyHint) annotations.push('[Read-Only]');
  const taskLabel = getTaskSupportLabel(contract.taskSupport);
  if (taskLabel) annotations.push(taskLabel);

  return {
    name: contract.name,
    title: contract.title,
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

const CONTRACTS_BY_NAME = new Map(
  ALL_TOOLS.map((contract) => [contract.name, contract] as const)
);

export function getToolContracts(): ToolContract[] {
  return ALL_TOOLS;
}

export function getSortedToolContracts(): ToolContract[] {
  return [...ALL_TOOLS].sort((left, right) =>
    left.name.localeCompare(right.name)
  );
}

export function pickAvailableToolNames(names: readonly string[]): string[] {
  return names.filter((name) => CONTRACTS_BY_NAME.has(name));
}

export function formatToolNameList(names: readonly string[]): string {
  return names.map((name) => `\`${name}\``).join(', ');
}

export function getTaskCapableToolNames(): string[] {
  return getSortedToolContracts()
    .filter(
      (contract) =>
        contract.taskSupport === 'optional' ||
        contract.taskSupport === 'required'
    )
    .map((contract) => contract.name);
}

export function buildCoreContextPack(): string {
  const rows = getSortedToolContracts().map((contract) => {
    const e = ENTRIES[contract.name];
    if (!e) return '';
    const annotations = e.annotations ? ` ${e.annotations.join(' ')}` : '';
    return `| \`${e.name}\` | ${e.description}${annotations} |`;
  });
  return `<core_context>\n| Tool | Purpose |\n|------|---------|\n${rows.join('\n')}\n</core_context>`;
}

export function getSharedConstraints(): string[] {
  return [
    'Use allowed roots only (from CLI negotiation).',
    'Sensitive paths are denylisted by default.',
    `Limits enforced: max file size ${Math.floor(MAX_TEXT_FILE_SIZE / 1024 / 1024)}MB; search caps ${MAX_SEARCH_RESULTS} files, ${DEFAULT_SEARCH_CONTENT_RESULTS} content matches.`,
    'If response includes `resourceUri`, call `resources/read` immediately — cached results expire on restart.',
  ];
}

function formatTaskSupportLabel(
  taskSupport: ToolContract['taskSupport']
): string {
  switch (taskSupport) {
    case 'optional':
      return 'optional';
    case 'required':
      return 'required';
    default:
      return 'forbidden';
  }
}

function toJsonSchemaObject(
  schema: NonNullable<
    ToolContract['inputSchema'] | ToolContract['outputSchema']
  >,
  io: 'input' | 'output' = 'output'
): JsonSchemaObject {
  return z.toJSONSchema(schema, { io }) as JsonSchemaObject;
}

function summarizeArrayType(schema: JsonSchemaObject): string {
  if (Array.isArray(schema.prefixItems) && schema.prefixItems.length > 0) {
    const itemTypes = schema.prefixItems.map(summarizeSchemaType).join(', ');
    return `tuple<${itemTypes}>`;
  }

  const itemType = schema.items ? summarizeSchemaType(schema.items) : 'unknown';
  return `array<${itemType}>`;
}

function summarizeSchemaType(schema: JsonSchemaObject): string {
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    return `enum(${schema.enum.map((value) => JSON.stringify(value)).join(', ')})`;
  }

  if (schema.const !== undefined) {
    return `const(${JSON.stringify(schema.const)})`;
  }

  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.map(summarizeSchemaType).join(' | ');
  }

  if (Array.isArray(schema.oneOf) && schema.oneOf.length > 0) {
    return schema.oneOf.map(summarizeSchemaType).join(' | ');
  }

  if (schema.type === 'array') {
    return summarizeArrayType(schema);
  }

  if (schema.type === 'object' && schema.additionalProperties === false) {
    return 'object (strict)';
  }

  if (typeof schema.type === 'string' && schema.type.length > 0) {
    return schema.type;
  }

  return 'unknown';
}

function buildSchemaFieldLines(
  label: string,
  schema: ToolContract['inputSchema'] | ToolContract['outputSchema']
): string[] {
  if (!schema) {
    return [`<${label}>`, '- none', `</${label}>`];
  }

  const io = label === 'input_fields' ? 'input' : 'output';
  const jsonSchema = toJsonSchemaObject(schema, io);
  const properties = jsonSchema.properties ?? {};
  const required = new Set(jsonSchema.required ?? []);
  const fieldNames = Object.keys(properties);
  const lines = [`<${label}>`];

  if (
    typeof jsonSchema.description === 'string' &&
    jsonSchema.description.length > 0
  ) {
    lines.push(`- Schema constraints: ${jsonSchema.description}`);
  }

  if (jsonSchema.additionalProperties === false) {
    lines.push(
      '- Unknown fields are rejected (`additionalProperties: false`).'
    );
  }

  if (fieldNames.length === 0) {
    lines.push('- object with no fields', `</${label}>`);
    return lines;
  }

  lines.push(
    ...fieldNames.map((fieldName) => {
      const fieldSchema = properties[fieldName] ?? {};
      const type = summarizeSchemaType(fieldSchema);
      const requiredLabel = required.has(fieldName) ? 'required' : 'optional';
      const description =
        typeof fieldSchema.description === 'string' &&
        fieldSchema.description.length > 0
          ? fieldSchema.description
          : 'No description.';
      return `- ${fieldName} (${type}, ${requiredLabel}): ${description}`;
    }),
    `</${label}>`
  );

  return lines;
}

export function buildToolInfo(name: string): string | undefined {
  const contract = CONTRACTS_BY_NAME.get(name);
  const entry = ENTRIES[name];
  if (!entry || !contract) return undefined;

  const annotationLines: string[] = [];
  if (contract.annotations?.readOnlyHint)
    annotationLines.push('- readOnlyHint: true');
  if (contract.annotations?.idempotentHint)
    annotationLines.push('- idempotentHint: true');
  if (contract.annotations?.destructiveHint)
    annotationLines.push('- destructiveHint: true');
  if (contract.annotations?.openWorldHint)
    annotationLines.push('- openWorldHint: true');

  const lines: string[] = [
    `<tool_info name="${entry.name}">`,
    `## ${entry.name}`,
    '',
    `Title: ${entry.title}`,
    `Description: ${entry.description}`,
    '',
    '<execution>',
    `- taskSupport: ${formatTaskSupportLabel(contract.taskSupport)}`,
    '</execution>',
    '',
    ...buildSchemaFieldLines('input_fields', contract.inputSchema),
    '',
    ...buildSchemaFieldLines('output_fields', contract.outputSchema),
  ];

  if (annotationLines.length > 0) {
    lines.push('', '<annotations>', ...annotationLines, '</annotations>');
  }

  if (entry.nuances && entry.nuances.length > 0) {
    lines.push('', '<nuances>');
    for (const nuance of entry.nuances) {
      lines.push(`- ${nuance}`);
    }
    lines.push('</nuances>');
  }

  if (entry.gotchas && entry.gotchas.length > 0) {
    lines.push('', '<gotchas>');
    for (const gotcha of entry.gotchas) {
      lines.push(`- ${gotcha}`);
    }
    lines.push('</gotchas>');
  }

  lines.push('</tool_info>');
  return lines.join('\n');
}
