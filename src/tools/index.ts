import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { registerAnalyzeDirectoryTool } from './analyze-directory.js';
import { registerDirectoryTreeTool } from './directory-tree.js';
import { registerGetFileInfoTool } from './get-file-info.js';
import { registerListAllowedDirectoriesTool } from './list-allowed-dirs.js';
import { registerListDirectoryTool } from './list-directory.js';
import { registerReadFileTool } from './read-file.js';
import { registerReadMediaFileTool } from './read-media-file.js';
import { registerReadMultipleFilesTool } from './read-multiple-files.js';
import { registerSearchContentTool } from './search-content.js';
import { registerSearchDefinitionsTool } from './search-definitions.js';
import { registerSearchFilesTool } from './search-files.js';

export function registerAllTools(server: McpServer): void {
  registerListAllowedDirectoriesTool(server);
  registerListDirectoryTool(server);
  registerSearchFilesTool(server);
  registerReadFileTool(server);
  registerReadMultipleFilesTool(server);
  registerGetFileInfoTool(server);
  registerSearchContentTool(server);
  registerSearchDefinitionsTool(server);
  registerAnalyzeDirectoryTool(server);
  registerDirectoryTreeTool(server);
  registerReadMediaFileTool(server);
}
