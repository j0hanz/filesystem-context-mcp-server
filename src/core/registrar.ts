import type { McpServer } from '@modelcontextprotocol/server';

import type { TaskOrchestrator } from '../tasks.js';
import type { IconInfo } from '../tools/define.js';
import type { PathGuard } from './path.js';
import type { ResourceStore } from './store.js';

export interface ServerDeps {
  server: McpServer;
  pathGuard: PathGuard;
  resourceStore: ResourceStore;
  orchestrator: TaskOrchestrator;
  isInitialized: () => boolean;
  iconInfo?: IconInfo;
}

export interface Registrar {
  register(deps: ServerDeps): void;
  dispose(): void;
}
