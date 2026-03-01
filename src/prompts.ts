import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';

import { type IconInfo, withDefaultIcons } from './tools/shared.js';

const HELP_PROMPT_NAME = 'get-help';
const HELP_PROMPT_TITLE = 'Get Help';
const HELP_PROMPT_DESCRIPTION = 'Return filesystem-mcp usage instructions.';

function filterInstructionsByTopic(
  instructions: string,
  topic: string
): string {
  const normalized = topic.trim().toLowerCase();
  if (!normalized) return instructions;
  const sections = instructions.split(/\n(?=## )/u);
  const match = sections.find((sec) =>
    sec.toLowerCase().startsWith(`## ${normalized}`)
  );
  if (match !== undefined) return match;
  const available = sections
    .filter((sec) => sec.startsWith('## '))
    .map((sec) => sec.split('\n')[0]?.replace(/^##\s*/u, '') ?? '')
    .filter(Boolean)
    .join(', ');
  return `Section '${topic}' not found. Available: ${available}\n\n${instructions}`;
}

export function registerGetHelpPrompt(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  const baseConfig = withDefaultIcons(
    { title: HELP_PROMPT_TITLE, description: HELP_PROMPT_DESCRIPTION },
    iconInfo
  );

  server.registerPrompt(
    HELP_PROMPT_NAME,
    {
      ...baseConfig,
      argsSchema: {
        topic: z
          .string()
          .optional()
          .describe(
            'Optional section heading prefix (example: "error handling"). Omit to return full instructions.'
          ),
      },
    },
    ({ topic }): GetPromptResult => {
      const text = topic
        ? filterInstructionsByTopic(instructions, topic)
        : instructions;
      return {
        description: HELP_PROMPT_DESCRIPTION,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text,
            },
          },
        ],
      };
    }
  );
}
