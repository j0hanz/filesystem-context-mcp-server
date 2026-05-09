import type { McpServer } from '@modelcontextprotocol/server';

import { APPLY_PATCH } from './tools/apply-patch.js';
import { CALCULATE_HASH } from './tools/calculate-hash.js';
import type { ToolContract } from './tools/contract.js';
import { CREATE_DIRECTORY } from './tools/create-directory.js';
import { DELETE_FILE } from './tools/delete-file.js';
import { DIFF_FILES } from './tools/diff-files.js';
import { EDIT_FILE } from './tools/edit-file.js';
import { LIST_DIRECTORY } from './tools/list-directory.js';
import { MOVE_FILE } from './tools/move-file.js';
import { READ_MANY } from './tools/read-multiple.js';
import { READ_FILE } from './tools/read.js';
import { SEARCH_AND_REPLACE } from './tools/replace-in-files.js';
import { LIST_ALLOWED_DIRECTORIES } from './tools/roots.js';
import { SEARCH_CONTENT } from './tools/search-content.js';
import { SEARCH_FILES } from './tools/search-files.js';
import type { ToolRegistrationOptions } from './tools/shared.js';
import { GET_MULTIPLE_FILE_INFO } from './tools/stat-many.js';
import { GET_FILE_INFO } from './tools/stat.js';
import { TREE } from './tools/tree.js';
import { WRITE_FILE } from './tools/write-file.js';

interface ToolEntry {
  contract: ToolContract;
  register: (server: McpServer, options: ToolRegistrationOptions) => void;
}

const TOOL_ENTRIES: ToolEntry[] = [
  LIST_ALLOWED_DIRECTORIES,
  LIST_DIRECTORY,
  SEARCH_FILES,
  TREE,
  READ_FILE,
  READ_MANY,
  GET_FILE_INFO,
  GET_MULTIPLE_FILE_INFO,
  SEARCH_CONTENT,
  CREATE_DIRECTORY,
  WRITE_FILE,
  DELETE_FILE,
  EDIT_FILE,
  MOVE_FILE,
  CALCULATE_HASH,
  DIFF_FILES,
  APPLY_PATCH,
  SEARCH_AND_REPLACE,
];

export const ALL_TOOLS: ToolContract[] = TOOL_ENTRIES.map((e) => e.contract);

export function registerAllTools(server: McpServer, options: ToolRegistrationOptions): void {
  for (const { register } of TOOL_ENTRIES) {
    register(server, options);
  }
}
