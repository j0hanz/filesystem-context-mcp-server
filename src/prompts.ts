import {
  type GetPromptResult,
  type McpServer,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';

import { z } from 'zod';

import {
  buildToolInfo,
  getSortedToolContracts,
} from './resources/tool-info.js';
import { type IconInfo, withDefaultIcons } from './tools/shared.js';

const HELP_PROMPT_NAME = 'get-help';
const HELP_PROMPT_TITLE = 'Get Help';
const HELP_PROMPT_DESCRIPTION = 'Return filesystem-mcp usage instructions.';

const COMPARE_FILES_PROMPT_NAME = 'compare-files';
const COMPARE_FILES_PROMPT_TITLE = 'Compare Files';
const COMPARE_FILES_PROMPT_DESCRIPTION =
  'Generate a workflow for comparing two files using diff_files.';

const ANALYZE_PATH_PROMPT_NAME = 'analyze-path';
const ANALYZE_PATH_PROMPT_TITLE = 'Analyze Path';
const ANALYZE_PATH_PROMPT_DESCRIPTION =
  'Generate a workflow for analyzing a file or directory using stat, read, and tree.';

const GET_TOOL_HELP_PROMPT_NAME = 'get-tool-help';
const GET_TOOL_HELP_PROMPT_TITLE = 'Get Tool Help';
const GET_TOOL_HELP_PROMPT_DESCRIPTION =
  'Return a prompt with the authoritative contract for a specific filesystem-mcp tool.';

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

function findKnownToolName(rawName: string): string | undefined {
  const normalized = rawName.trim().toLowerCase();
  if (!normalized) return undefined;

  return getSortedToolContracts().find(
    (contract) => contract.name.toLowerCase() === normalized
  )?.name;
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
      argsSchema: z.object({
        topic: z
          .string()
          .optional()
          .describe(
            'Optional section heading prefix (example: "error handling"). Omit to return full instructions.'
          ),
      }),
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

export function registerCompareFilesPrompt(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerPrompt(
    COMPARE_FILES_PROMPT_NAME,
    {
      ...withDefaultIcons(
        {
          title: COMPARE_FILES_PROMPT_TITLE,
          description: COMPARE_FILES_PROMPT_DESCRIPTION,
        },
        iconInfo
      ),
      argsSchema: z.object({
        original: z.string().describe('Path to the original file.'),
        modified: z.string().describe('Path to the modified file.'),
      }),
    },
    ({ original, modified }): GetPromptResult => ({
      description: COMPARE_FILES_PROMPT_DESCRIPTION,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Compare files and explain differences.\n\n1. Call \`diff_files\` with:\n   - original: ${original}\n   - modified: ${modified}\n2. Summarize: additions, deletions, and semantic changes.\n3. Flag any potential issues (conflicts, regressions, breaking changes).`,
          },
        },
      ],
    })
  );
}

export function registerAnalyzePathPrompt(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerPrompt(
    ANALYZE_PATH_PROMPT_NAME,
    {
      ...withDefaultIcons(
        {
          title: ANALYZE_PATH_PROMPT_TITLE,
          description: ANALYZE_PATH_PROMPT_DESCRIPTION,
        },
        iconInfo
      ),
      argsSchema: z.object({
        path: z.string().describe('Absolute path to analyze.'),
      }),
    },
    ({ path: targetPath }): GetPromptResult => ({
      description: ANALYZE_PATH_PROMPT_DESCRIPTION,
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Analyze the path: ${targetPath}\n\n1. Call \`stat\` to determine if it is a file or directory.\n2. If file: call \`read\` with \`includeHash: true\` and summarize contents.\n3. If directory: call \`tree\` (maxDepth: 3) and \`ls\` to summarize structure.\n4. Report: type, size, permissions, key observations.`,
          },
        },
      ],
    })
  );
}

export function registerGetToolHelpPrompt(
  server: McpServer,
  iconInfo?: IconInfo
): void {
  server.registerPrompt(
    GET_TOOL_HELP_PROMPT_NAME,
    {
      ...withDefaultIcons(
        {
          title: GET_TOOL_HELP_PROMPT_TITLE,
          description: GET_TOOL_HELP_PROMPT_DESCRIPTION,
        },
        iconInfo
      ),
      argsSchema: z.object({
        name: z
          .string()
          .min(1)
          .describe(
            'Tool name from tools/list or internal://tool-info/{name}.'
          ),
      }),
    },
    ({ name }): GetPromptResult => {
      const toolName = findKnownToolName(name);
      if (!toolName) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown tool: ${name}`
        );
      }

      const toolInfo = buildToolInfo(toolName);
      if (!toolInfo) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidParams,
          `Unknown tool: ${toolName}`
        );
      }

      return {
        description: GET_TOOL_HELP_PROMPT_DESCRIPTION,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text:
                `Use the embedded contract for \`${toolName}\` as the authoritative reference. ` +
                'Summarize when to use it, its key constraints, and the safest next action.',
            },
          },
          {
            role: 'user',
            content: {
              type: 'resource',
              resource: {
                uri: `internal://tool-info/${toolName}`,
                mimeType: 'text/markdown',
                text: toolInfo,
              },
            },
          },
        ],
      };
    }
  );
}
