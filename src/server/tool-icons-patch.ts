/**
 * Patches the tools/list response to inject icons from ToolContract definitions.
 *
 * The MCP SDK (v1.29.0) does not pass the `icons` property through
 * `registerTool` or include it in the `tools/list` response, even though the
 * MCP specification supports icons on tools. This module wraps the SDK's
 * internal handler to inject icons after the response is built.
 *
 * Remove this patch when the SDK adds native icon support for tools.
 */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Icon } from '@modelcontextprotocol/sdk/types.js';

import type { ToolContract } from '../tools/contract.js';
import type { IconInfo } from '../tools/shared.js';

const TOOLS_LIST_METHOD = 'tools/list';

interface ToolDefinition {
  name: string;
  icons?: Icon[];
  [key: string]: unknown;
}

interface ToolsListResult {
  tools: ToolDefinition[];
  [key: string]: unknown;
}

type RequestHandler = (
  request: unknown,
  extra: unknown
) => Promise<ToolsListResult>;

function getRequestHandlersMap(
  server: McpServer
): Map<string, RequestHandler> | undefined {
  const lowLevel = server.server as unknown as {
    _requestHandlers?: Map<string, RequestHandler>;
  };
  return lowLevel._requestHandlers;
}

function buildIconMap(
  tools: readonly ToolContract[],
  fallback: IconInfo | undefined
): Map<string, Icon[]> {
  const map = new Map<string, Icon[]>();
  const fallbackIcons: Icon[] | undefined = fallback
    ? [{ src: fallback.src, mimeType: fallback.mimeType }]
    : undefined;

  for (const tool of tools) {
    const icons =
      tool.icons && tool.icons.length > 0 ? tool.icons : fallbackIcons;
    if (icons) {
      map.set(tool.name, icons);
    }
  }

  return map;
}

export function patchToolListWithIcons(
  server: McpServer,
  tools: readonly ToolContract[],
  fallbackIcon: IconInfo | undefined
): boolean {
  const handlers = getRequestHandlersMap(server);
  if (!handlers) return false;

  const original = handlers.get(TOOLS_LIST_METHOD);
  if (!original) return false;

  const iconMap = buildIconMap(tools, fallbackIcon);
  if (iconMap.size === 0) return false;

  handlers.set(
    TOOLS_LIST_METHOD,
    async (request: unknown, extra: unknown): Promise<ToolsListResult> => {
      const result = await original(request, extra);

      for (const tool of result.tools) {
        if (tool.icons && tool.icons.length > 0) continue;
        const icons = iconMap.get(tool.name);
        if (icons) {
          tool.icons = icons;
        }
      }

      return result;
    }
  );

  return true;
}
