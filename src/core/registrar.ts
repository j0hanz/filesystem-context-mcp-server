import type { McpServer } from '@modelcontextprotocol/server';

import type { PathGuard } from './path.js';
import type { IconInfo } from './primitives.js';
import type { ResourceStore } from './store.js';
import type { WatcherRegistry } from './watcher-registry.js';

export interface ServerNotifier {
  readonly toolsChanged?: () => void;
  readonly promptsChanged?: () => void;
  readonly resourcesChanged?: () => void;
  readonly resourceUpdated: (uri: string) => void;
}

export interface ServerDeps {
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore;
  readonly iconInfo?: IconInfo;
  readonly readOnly?: boolean;
  /** Shared file-watcher registry for the modern HTTP leg; omitted on stdio. */
  readonly watcherRegistry?: WatcherRegistry;
  /** Modern-leg typed notification publisher. */
  readonly notifier?: ServerNotifier;
}

export interface Registrar {
  readonly register: (deps: ServerDeps) => void;
  readonly dispose: (server?: McpServer) => void;
}
