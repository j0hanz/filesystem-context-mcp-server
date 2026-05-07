import type { McpServer } from '@modelcontextprotocol/server';

import {
  APPLY_PATCH_TOOL,
  registerApplyPatchTool,
} from './tools/apply-patch.js';
import {
  CALCULATE_HASH_TOOL,
  registerCalculateHashTool,
} from './tools/calculate-hash.js';
import type { ToolContract } from './tools/contract.js';
import { CREATE_DIRECTORY } from './tools/create-directory.js';
import { DELETE_FILE } from './tools/delete-file.js';
import { DIFF_FILES_TOOL, registerDiffFilesTool } from './tools/diff-files.js';
import { EDIT_FILE } from './tools/edit-file.js';
import {
  LIST_DIRECTORY_TOOL,
  registerListDirectoryTool,
} from './tools/list-directory.js';
import { MOVE_FILE_TOOL, registerMoveFileTool } from './tools/move-file.js';
import {
  READ_MANY_TOOL,
  registerReadMultipleFilesTool,
} from './tools/read-multiple.js';
import { READ_FILE_TOOL, registerReadFileTool } from './tools/read.js';
import {
  registerSearchAndReplaceTool,
  SEARCH_AND_REPLACE_TOOL,
} from './tools/replace-in-files.js';
import { LIST_ALLOWED_DIRECTORIES } from './tools/roots.js';
import {
  registerSearchContentTool,
  SEARCH_CONTENT_TOOL,
} from './tools/search-content.js';
import {
  registerSearchFilesTool,
  SEARCH_FILES_TOOL,
} from './tools/search-files.js';
import type { ToolRegistrationOptions } from './tools/shared.js';
import { GET_MULTIPLE_FILE_INFO } from './tools/stat-many.js';
import { GET_FILE_INFO } from './tools/stat.js';
import { registerTreeTool, TREE_TOOL } from './tools/tree.js';
import { WRITE_FILE } from './tools/write-file.js';

interface ToolEntry {
  contract: ToolContract;
  register: (server: McpServer, options: ToolRegistrationOptions) => void;
}

const TOOL_ENTRIES: ToolEntry[] = [
  LIST_ALLOWED_DIRECTORIES,
  { contract: LIST_DIRECTORY_TOOL, register: registerListDirectoryTool },
  { contract: SEARCH_FILES_TOOL, register: registerSearchFilesTool },
  { contract: TREE_TOOL, register: registerTreeTool },
  { contract: READ_FILE_TOOL, register: registerReadFileTool },
  {
    contract: READ_MANY_TOOL,
    register: registerReadMultipleFilesTool,
  },
  GET_FILE_INFO,
  GET_MULTIPLE_FILE_INFO,
  { contract: SEARCH_CONTENT_TOOL, register: registerSearchContentTool },
  CREATE_DIRECTORY,
  WRITE_FILE,
  DELETE_FILE,
  EDIT_FILE,
  { contract: MOVE_FILE_TOOL, register: registerMoveFileTool },
  { contract: CALCULATE_HASH_TOOL, register: registerCalculateHashTool },
  { contract: DIFF_FILES_TOOL, register: registerDiffFilesTool },
  { contract: APPLY_PATCH_TOOL, register: registerApplyPatchTool },
  { contract: SEARCH_AND_REPLACE_TOOL, register: registerSearchAndReplaceTool },
];

export const ALL_TOOLS: ToolContract[] = TOOL_ENTRIES.map((e) => e.contract);

export function registerAllTools(
  server: McpServer,
  options: ToolRegistrationOptions
): void {
  for (const { register } of TOOL_ENTRIES) {
    register(server, options);
  }
}
