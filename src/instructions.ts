import {
  DEFAULT_SEARCH_CONTENT_RESULTS,
  MAX_SEARCH_RESULTS,
  MAX_TEXT_FILE_SIZE,
} from './core/util.js';
import {
  CALCULATE_HASH,
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
    ['Inspect', [GET_FILE_INFO.name, SEARCH_CONTENT.name, CALCULATE_HASH.name]],
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
  const maxFileMb = Math.floor(MAX_TEXT_FILE_SIZE / 1024 / 1024);
  return {
    guidelines: [
      'Guidelines:',
      '```',
      'root_access: When using filesystem tools, operate strictly within allowed roots.',
      'path_resolution: Always resolve paths before acting — never assume.',
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
      'allowed_roots: Operate within allowed roots only (negotiated at startup via CLI).',
      'sensitive_paths: Sensitive file paths (.env, *.pem, *id_rsa*) are denied by default.',
      `enforced_limits: max file size ${maxFileMb} MB, file search cap ${MAX_SEARCH_RESULTS} results, content search cap ${DEFAULT_SEARCH_CONTENT_RESULTS} matches.`,
      'ephemeral_results: When a tool returns resourceUri, call resources/read immediately — cached results are ephemeral and expire after ~60 seconds, eviction, or restart.',
      '```',
    ].join('\n'),
    error_recovery: [
      'Error Recovery:',
      '```',
      'ACCESS_DENIED: Run list_roots to list allowed directories, retry with a valid path.',
      'NOT_FOUND: Run list or find_files to verify the path.',
      'TOO_LARGE: Use read with head/tail or startLine/endLine, or split across several read calls.',
      'TIMEOUT: Reduce scope, depth, or maxResults.',
      'INVALID_INPUT: Re-read the tool schema in tools/list.',
      '```',
    ].join('\n'),
  };
}

export function renderSections(sections: Record<string, string>): string {
  return `\n${Object.values(sections).join('\n\n')}\n`;
}
