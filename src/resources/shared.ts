import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';

import type { IconInfo } from '../tools/shared.js';

export interface ResourceRegistrationOptions {
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
  pathGuard?: PathGuard;
}

export interface ResourcesHandle {
  destroy(): void;
}

