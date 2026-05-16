import type { McpServer } from '@modelcontextprotocol/server';

import type { ToolRegistrationOptions } from './tools/_helpers.js';
import { CALCULATE_HASH } from './tools/calculate-hash.js';
import { CREATE } from './tools/create.js';
import type { ToolDeps } from './tools/define.js';
import { DELETE_FILE } from './tools/delete-file.js';
import { EDIT } from './tools/edit.js';
import { LIST } from './tools/list.js';
import { MOVE } from './tools/move.js';
import { READ_FILE } from './tools/read.js';
import { SEARCH_AND_REPLACE } from './tools/replace-in-files.js';
import { LIST_ALLOWED_DIRECTORIES } from './tools/roots.js';
import { SEARCH_CONTENT } from './tools/search-content.js';
import { SEARCH_FILES } from './tools/search-files.js';
import { GET_FILE_INFO } from './tools/stat.js';

export const ALL_TOOLS = [
  CALCULATE_HASH,
  CREATE,
  DELETE_FILE,
  EDIT,
  LIST,
  MOVE,
  READ_FILE,
  SEARCH_AND_REPLACE,
  LIST_ALLOWED_DIRECTORIES,
  SEARCH_CONTENT,
  SEARCH_FILES,
  GET_FILE_INFO,
] as const;

export function registerAllTools(server: McpServer, options: ToolRegistrationOptions): void {
  const deps: ToolDeps = {
    server,
    isInitialized: options.isInitialized ?? (() => true),
    pathGuard: options.pathGuard,
    resourceStore: options.resourceStore,
    ...(options.orchestrator ? { orchestrator: options.orchestrator } : {}),
  };
  for (const tool of ALL_TOOLS) {
    tool.register(deps);
  }
}
