import type { Registrar } from '../core/registrar.js';
import { CALCULATE_HASH } from './calculate-hash.js';
import { CREATE } from './create.js';
import { DELETE_FILE } from './delete-file.js';
import { EDIT } from './edit.js';
import { LIST } from './list.js';
import { MOVE } from './move.js';
import { READ_FILE } from './read.js';
import { SEARCH_AND_REPLACE } from './replace-in-files.js';
import { LIST_ALLOWED_DIRECTORIES } from './roots.js';
import { SEARCH_CONTENT } from './search-content.js';
import { SEARCH_FILES } from './search-files.js';
import { GET_FILE_INFO } from './stat.js';

const ALL_TOOLS = [
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

export const toolsRegistrar: Registrar = {
  register(deps): void {
    const toolDeps = {
      server: deps.server,
      isInitialized: deps.isInitialized,
      pathGuard: deps.pathGuard,
      resourceStore: deps.resourceStore,
    };
    for (const tool of ALL_TOOLS) {
      tool.register(toolDeps);
    }
  },
  dispose(): void {
    /* no-op */
  },
};
