import type { McpServer } from '@modelcontextprotocol/server';

import type { ToolRegistrationOptions } from './tools/_helpers.js';
import './tools/apply-patch.js';
import './tools/calculate-hash.js';
import './tools/create-directory.js';
import { ALL_TOOLS as _ALL_TOOLS, registerAllTools as _registerAllTools } from './tools/define.js';
import './tools/delete-file.js';
import './tools/diff-files.js';
import './tools/edit.js';
import './tools/list-directory.js';
import './tools/move-file.js';
import './tools/read.js';
import './tools/replace-in-files.js';
import './tools/roots.js';
import './tools/search-content.js';
import './tools/search-files.js';
import './tools/stat.js';
import './tools/tree.js';
import './tools/write-file.js';

export const ALL_TOOLS = _ALL_TOOLS;

export function registerAllTools(server: McpServer, options: ToolRegistrationOptions): void {
  _registerAllTools({
    server,
    isInitialized: options.isInitialized ?? (() => true),
    pathGuard: options.pathGuard,
    resourceStore: options.resourceStore,
    ...(options.orchestrator ? { orchestrator: options.orchestrator } : {}),
  });
}
