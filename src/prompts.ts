import {
  completable,
  type GetPromptResult,
  type McpServer,
} from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { completePathCached } from './lib/path-completer.js';

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

function extractTopics(instructions: string): string[] {
  const headers: string[] = [];
  for (const line of instructions.split('\n')) {
    if (line.startsWith('## ')) {
      const header = line.slice(3).trim().toLowerCase();
      if (header) headers.push(header);
    }
  }
  return headers;
}

function filterByPrefix(values: string[], prefix: string): string[] {
  const lower = prefix.toLowerCase();
  return lower ? values.filter((v) => v.startsWith(lower)) : [...values];
}

export function registerGetHelpPrompt(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  const topics = extractTopics(instructions);
  const baseConfig = withDefaultIcons(
    { title: HELP_PROMPT_TITLE, description: HELP_PROMPT_DESCRIPTION },
    iconInfo
  );

  server.registerPrompt(
    HELP_PROMPT_NAME,
    {
      ...baseConfig,
      argsSchema: z.strictObject({
        topic: completable(
          z
            .string()
            .describe(
              'Optional section heading prefix (example: "error handling"). Omit to return full instructions.'
            ),
          (value) => filterByPrefix(topics, value)
        ).optional(),
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
              annotations: { audience: ['assistant'], priority: 1 },
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
      argsSchema: z.strictObject({
        original: completable(
          z.string().describe('Path to the original file.'),
          (value, ctx) => {
            const opts: Parameters<typeof completePathCached>[1] = {
              server,
              argumentName: 'original',
            };
            if (ctx?.arguments) opts.contextArguments = ctx.arguments;
            return completePathCached(value, opts);
          }
        ),
        modified: completable(
          z.string().describe('Path to the modified file.'),
          (value, ctx) => {
            const opts: Parameters<typeof completePathCached>[1] = {
              server,
              argumentName: 'modified',
            };
            if (ctx?.arguments) opts.contextArguments = ctx.arguments;
            return completePathCached(value, opts);
          }
        ),
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
            annotations: { audience: ['assistant'], priority: 1 },
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
      argsSchema: z.strictObject({
        path: completable(
          z.string().describe('Absolute path to analyze.'),
          (value, ctx) => {
            const opts: Parameters<typeof completePathCached>[1] = {
              server,
              argumentName: 'path',
            };
            if (ctx?.arguments) opts.contextArguments = ctx.arguments;
            return completePathCached(value, opts);
          }
        ),
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
            annotations: { audience: ['assistant'], priority: 1 },
          },
        },
      ],
    })
  );
}
