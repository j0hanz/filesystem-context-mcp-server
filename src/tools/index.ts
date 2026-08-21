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

// A tool is mutating unless it declares itself read-only. Defaulting an
// unannotated tool to mutating is the safe direction: `--read-only` omits it.
export const MUTATING_TOOL_NAMES = new Set(
  ALL_TOOLS.filter((t) => t.annotations.readOnlyHint !== true).map((t) => t.name),
);

export const ALL_REGISTERED_TOOL_NAMES: readonly string[] = ALL_TOOLS.map((t) => t.name);

// Re-exported so documentation surfaces quote `.name` off the definition rather
// than repeating the string. This module is the only owner of the inventory.
// Only the read-only tools are named individually: the mutating five are no
// longer listed by hand anywhere, so their names reach callers through
// MUTATING_TOOL_NAMES and ALL_TOOLS instead.
export {
  CALCULATE_HASH,
  LIST,
  LIST_ALLOWED_DIRECTORIES,
  READ_FILE,
  SEARCH_CONTENT,
  SEARCH_FILES,
  GET_FILE_INFO,
};

export const toolsRegistrar: Registrar = {
  register(deps): void {
    const toolDeps = {
      server: deps.server,
      isInitialized: deps.isInitialized,
      pathGuard: deps.pathGuard,
      resourceStore: deps.resourceStore,
    };
    for (const tool of ALL_TOOLS) {
      if (deps.readOnly && MUTATING_TOOL_NAMES.has(tool.name)) continue;
      tool.register(toolDeps);
    }
  },
  dispose(): void {
    /* no-op */
  },
};
