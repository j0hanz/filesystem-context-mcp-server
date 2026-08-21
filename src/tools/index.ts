import type { Registrar } from '../core/registrar.js';
import { CALCULATE_HASH } from './calculate-hash.js';
import { CREATE } from './create.js';
import type { DefinedTool } from './define.js';
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

export const MUTATING_TOOL_NAMES = new Set(
  ALL_TOOLS.filter((t) => !t.annotations.readOnlyHint).map((t) => t.name),
);

export const ALL_REGISTERED_TOOL_NAMES: readonly string[] = ALL_TOOLS.map((t) => t.name);

/** The tools a server registers at this setting — the one owner of the `--read-only` gate. */
export function registeredTools(readOnly: boolean): readonly DefinedTool[] {
  return readOnly ? ALL_TOOLS.filter((t) => !MUTATING_TOOL_NAMES.has(t.name)) : ALL_TOOLS;
}

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
    for (const tool of registeredTools(deps.readOnly ?? false)) {
      tool.register(toolDeps);
    }
  },
  dispose(): void {
    /* no-op */
  },
};
