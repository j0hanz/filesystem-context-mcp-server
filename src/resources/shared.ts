import type { PathGuard } from '../lib/path-guard.js';
import type { ResourceStore } from '../lib/resource-store.js';

import type { IconInfo } from '../tools/shared.js';
import type { ResourceContract } from './contract.js';

export interface ResourceRegistrationOptions {
  pathGuard: PathGuard;
  resourceStore: ResourceStore;
  iconInfo?: IconInfo;
}

export function resourceMetadata(contract: ResourceContract): {
  title: string;
  description: string;
  mimeType: string;
  annotations: { audience: ('user' | 'assistant')[]; priority: number };
} {
  return {
    title: contract.title,
    description: contract.description,
    mimeType: contract.mimeType,
    annotations: contract.annotations,
  };
}
