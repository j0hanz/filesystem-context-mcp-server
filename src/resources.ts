import type { McpServer } from '@modelcontextprotocol/server';

import type { ResourceContract } from './resources/contract.js';
import {
  FILESYSTEM_FILE_RESOURCE,
  registerFilesystemFileResource,
} from './resources/filesystem-file.js';
import { buildServerInstructions } from './resources/generated-instructions.js';
import {
  INSTRUCTIONS_RESOURCE,
  registerInstructionResource,
} from './resources/instructions.js';
import {
  METRICS_RESOURCE,
  registerMetricsResource,
} from './resources/metrics.js';
import { registerResultResource, RESULT_RESOURCE } from './resources/result.js';
import type { ResourceRegistrationOptions } from './resources/shared.js';
import {
  registerToolCatalogResource,
  TOOL_CATALOG_RESOURCE,
} from './resources/tool-catalog-resource.js';
import {
  registerToolInfoResource,
  TOOL_INFO_RESOURCE,
} from './resources/tool-info-resource.js';
import {
  registerWorkflowGuideResource,
  WORKFLOW_GUIDE_RESOURCE,
} from './resources/workflows-resource.js';

export type { ResourceRegistrationOptions };

interface ResourceEntry {
  contract: ResourceContract;
  register: (server: McpServer, options: ResourceRegistrationOptions) => void;
}

// Build instructions content with all resource contracts so the
// resource table in the instructions doc is auto-derived.
const ALL_RESOURCE_CONTRACTS: ResourceContract[] = [
  INSTRUCTIONS_RESOURCE,
  TOOL_CATALOG_RESOURCE,
  WORKFLOW_GUIDE_RESOURCE,
  TOOL_INFO_RESOURCE,
  RESULT_RESOURCE,
  METRICS_RESOURCE,
  FILESYSTEM_FILE_RESOURCE,
];

const SERVER_INSTRUCTIONS_CONTENT = buildServerInstructions(
  ALL_RESOURCE_CONTRACTS
);

const ALL_RESOURCES: ResourceContract[] = ALL_RESOURCE_CONTRACTS;

const RESOURCE_ENTRIES: ResourceEntry[] = [
  {
    contract: INSTRUCTIONS_RESOURCE,
    register: (server, options) => {
      registerInstructionResource(server, SERVER_INSTRUCTIONS_CONTENT, options);
    },
  },
  { contract: TOOL_CATALOG_RESOURCE, register: registerToolCatalogResource },
  {
    contract: WORKFLOW_GUIDE_RESOURCE,
    register: registerWorkflowGuideResource,
  },
  { contract: TOOL_INFO_RESOURCE, register: registerToolInfoResource },
  { contract: RESULT_RESOURCE, register: registerResultResource },
  { contract: METRICS_RESOURCE, register: registerMetricsResource },
  {
    contract: FILESYSTEM_FILE_RESOURCE,
    register: registerFilesystemFileResource,
  },
];

export interface ResourcesHandle {
  destroy(): void;
}

export function registerAllResources(
  server: McpServer,
  options: ResourceRegistrationOptions
): ResourcesHandle {
  const notify = (uri: string): void => {
    void server.server.sendResourceUpdated({ uri }).catch(() => {
      // Transport may already be closed — best effort.
    });
  };

  const lifecycles = RESOURCE_ENTRIES.flatMap(({ contract, register }) => {
    register(server, options);
    return contract.createSubscription
      ? [contract.createSubscription(notify)]
      : [];
  });

  // Single subscription router for all resources.
  // Each lifecycle's onSubscribe/onUnsubscribe ignores URIs that don't belong to it.
  server.server.setRequestHandler(
    'resources/subscribe',
    (req: { params: { uri: string } }) => {
      for (const lc of lifecycles) lc.onSubscribe(req.params.uri);
      return {};
    }
  );

  server.server.setRequestHandler(
    'resources/unsubscribe',
    (req: { params: { uri: string } }) => {
      for (const lc of lifecycles) lc.onUnsubscribe(req.params.uri);
      return {};
    }
  );

  return {
    destroy: () => {
      for (const lc of lifecycles) lc.destroy();
    },
  };
}

export { SERVER_INSTRUCTIONS_CONTENT as serverInstructionsContent };
