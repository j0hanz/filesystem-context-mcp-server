import type { PromptMessage, ResourceLink } from '@modelcontextprotocol/server';

import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  getMaxTextFileSize,
  MAX_SEARCH_RESULTS,
} from './core/util.js';
import {
  GET_FILE_INFO,
  LIST,
  LIST_ALLOWED_DIRECTORIES,
  MUTATING_TOOL_NAMES,
  READ_FILE,
  SEARCH_CONTENT,
  SEARCH_FILES,
} from './tools/index.js';

function buildToolsOverview(readOnly: boolean): string {
  const rows: [string, string[]][] = [
    ['Navigate', [LIST_ALLOWED_DIRECTORIES.name, LIST.name, SEARCH_FILES.name]],
    ['Inspect', [GET_FILE_INFO.name, SEARCH_CONTENT.name]],
    ['Read', [READ_FILE.name]],
  ];

  // Under --read-only the mutating tools are never registered, so advertising
  // them here would point the model at tools that are not there. Drop the row
  // rather than emit an empty one.
  if (!readOnly) {
    rows.push(['Write', [...MUTATING_TOOL_NAMES]]);
  }

  const rowLines = rows.map(([cat, names]) => `${cat}: ${names.join(', ')}`);
  return `\`\`\`\n${rowLines.join('\n')}\n\`\`\``;
}

export const INSTRUCTIONS_URI = 'internal://instructions';

export function buildSectionsRecord(readOnly: boolean): Record<string, string> {
  const maxFileMb = Math.floor(getMaxTextFileSize() / 1024 / 1024);
  return {
    guidelines: [
      'Guidelines:',
      '```',
      `root_access: Call ${LIST_ALLOWED_DIRECTORIES.name} first; every other tool is scoped to those roots.`,
      `path_resolution: Confirm a path with ${LIST.name} or ${SEARCH_FILES.name} before acting on it.`,
      '```',
    ].join('\n'),
    tools_overview: [
      'Tools Overview:',
      buildToolsOverview(readOnly),
      '',
      'Full schemas, descriptions, and annotations are in `tools/list`.',
    ].join('\n'),
    constraints: [
      'Constraints:',
      '```',
      `allowed_roots: Operate within allowed roots only (from the client roots capability, CLI paths, or FS_ALLOWED_DIRS). Call ${LIST_ALLOWED_DIRECTORIES.name} to read them.`,
      'sensitive_paths: Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.',
      `enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.`,
      'ephemeral_results: When a tool returns resourceUri, call resources/read immediately — cached results are ephemeral and expire after ~60 seconds, eviction, or restart.',
      '```',
    ].join('\n'),
    error_recovery: [
      'Error Recovery:',
      '```',
      `ACCESS_DENIED: Run ${LIST_ALLOWED_DIRECTORIES.name} to list allowed directories, retry with a valid path.`,
      `NOT_FOUND: Run ${LIST.name} or ${SEARCH_FILES.name} to verify the path.`,
      `TOO_LARGE: Use ${READ_FILE.name} with head/tail or startLine/endLine, or split across several calls.`,
      'TIMEOUT: Reduce scope, depth, or maxResults.',
      'INVALID_INPUT: Re-read the tool schema in tools/list.',
      '```',
    ].join('\n'),
  };
}

export function renderSections(sections: Record<string, string>): string {
  return `\n${Object.values(sections).join('\n\n')}\n`;
}

export function linkToInstructions(uri: string = INSTRUCTIONS_URI): PromptMessage {
  const content: ResourceLink = {
    type: 'resource_link',
    uri,
    name: 'filesystem-mcp-instructions',
    mimeType: 'text/markdown',
    annotations: { audience: ['assistant'], priority: 0.5 },
  };
  return { role: 'user', content };
}
