import type { PathGuard } from '../lib/path-guard.js';
import type { ResourceStore } from '../lib/resource-store.js';

import type { IconInfo } from '../tools/shared.js';

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
  pathGuard?: PathGuard;
}

export interface ResourcesHandle {
  destroy(): void;
}
