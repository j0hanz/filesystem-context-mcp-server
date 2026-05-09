import { type McpServer, ResourceTemplate, type ServerContext } from '@modelcontextprotocol/server';

import uriTemplate from 'uri-templates';

import type { ResourceContract } from './resources/contract.js';
import { createFilesystemResource } from './resources/filesystem.js';
import {
  createInstructionsResource,
  SERVER_INSTRUCTIONS_CONTENT as serverInstructionsContent,
} from './resources/instructions.js';
import { createResultResource } from './resources/result.js';
import type { ResourceRegistrationOptions, ResourcesHandle } from './resources/shared.js';
import { withDefaultIcons } from './tools/shared.js';

export { serverInstructionsContent };
export type { ResourceRegistrationOptions, ResourcesHandle };

export function registerAllResources(
  server: McpServer,
  options: ResourceRegistrationOptions,
): ResourcesHandle {
  const ALL_RESOURCES: ResourceContract[] = [
    createInstructionsResource(),
    createResultResource(options),
    createFilesystemResource(options),
  ];

  for (const contract of ALL_RESOURCES) {
    const config = withDefaultIcons(
      {
        title: contract.title,
        description: contract.description,
        mimeType: contract.mimeType,
        annotations: contract.annotations,
      },
      options.iconInfo,
    );

    if (contract.uriTemplate) {
      const template = new ResourceTemplate(contract.uriTemplate, {
        list: undefined,
        ...(contract.complete
          ? {
              complete: Object.fromEntries(
                uriTemplate(contract.uriTemplate).varNames.map((varName) => [
                  varName,
                  (value: string, ctx?: { arguments?: Record<string, string> }) => {
                    const completeFn = contract.complete;
                    return completeFn ? completeFn(varName, value, ctx) : [];
                  },
                ]),
              ),
            }
          : {}),
      });

      server.registerResource(
        contract.name,
        template,
        config,
        (uri: URL, variables: Record<string, string | string[]>, ctx: ServerContext) =>
          contract.read(uri, variables, ctx),
      );
    } else if (contract.uri) {
      server.registerResource(contract.name, contract.uri, config, (uri, ctx) =>
        contract.read(uri, {}, ctx),
      );
    }
  }

  // Hook into subscriptions routing
  server.server.setRequestHandler('resources/subscribe', (req: { params: { uri: string } }) => {
    const { uri } = req.params;
    for (const contract of ALL_RESOURCES) {
      if (contract.subscribe) {
        // Simplistic routing - normally we'd check if URI matches template or exact URI
        let matches = false;
        if (contract.uri && uri === contract.uri) matches = true;
        if (contract.uriTemplate) {
          // Check if URI matches the template prefix (e.g. filesystem-mcp://file/)
          const prefix = contract.uriTemplate.split('{')[0];
          if (prefix && uri.startsWith(prefix)) matches = true;
        }

        if (matches) {
          contract.subscribe(uri, (updatedUri) => {
            void server.server.sendResourceUpdated({ uri: updatedUri }).catch(() => {
              /* Transport may be closed */
            });
          });
          break;
        }
      }
    }
    return {};
  });

  server.server.setRequestHandler('resources/unsubscribe', (req: { params: { uri: string } }) => {
    const { uri } = req.params;
    for (const contract of ALL_RESOURCES) {
      if (contract.unsubscribe) {
        contract.unsubscribe(uri);
      }
    }
    return {};
  });

  return {
    destroy(): void {
      for (const contract of ALL_RESOURCES) {
        if (contract.destroy) {
          contract.destroy();
        }
      }
    },
  };
}
