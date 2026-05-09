import { stat } from 'node:fs/promises';

import {
  completable,
  type GetPromptResult,
  type McpServer,
  type PromptMessage,
} from '@modelcontextprotocol/server';

import { z } from 'zod/v4';

import { Logger } from './lib/logger.js';
import { completePathCached } from './lib/path-completer.js';
import type { PathGuard } from './lib/path-guard.js';

import { INSTRUCTION_SECTIONS } from './resources/instructions.js';
import { type IconInfo, withDefaultIcons } from './tools/shared.js';

// --- Types ---

export interface PromptContract {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly requiresPathGuard: boolean;
}

export interface PromptRegistrationOptions {
  pathGuard: PathGuard;
  instructions: string;
  isInitialized: () => boolean;
  iconInfo?: IconInfo;
}

interface PromptEntry {
  readonly contract: PromptContract;
  readonly register: (server: McpServer, options: PromptRegistrationOptions) => void;
}

// --- Helpers ---

function pathArg(
  server: McpServer,
  guard: PathGuard,
  argumentName: string,
  description: string,
): ReturnType<typeof completable<z.ZodString>> {
  return completable(z.string().describe(description), (value, ctx) =>
    completePathCached(value, {
      server,
      pathGuard: guard,
      argumentName,
      ...(ctx?.arguments ? { contextArguments: ctx.arguments } : {}),
    }),
  );
}

function topicArg(
  topics: readonly string[],
  description: string,
): ReturnType<typeof completable<z.ZodString>> {
  return completable(z.string().describe(description), (value) => {
    const lower = value.toLowerCase();
    return lower ? topics.filter((t) => t.startsWith(lower)) : [...topics];
  });
}

function userText(text: string): PromptMessage {
  return {
    role: 'user',
    content: {
      type: 'text',
      text,
      annotations: { audience: ['assistant'], priority: 1 },
    },
  };
}

function linkToInstructions(): PromptMessage {
  return {
    role: 'user',
    content: {
      type: 'resource_link',
      uri: 'internal://instructions',
      name: 'filesystem-mcp-instructions',
      mimeType: 'text/markdown',
      annotations: { audience: ['assistant'], priority: 0.5 },
    },
  };
}

function linkToPath(absPath: string): PromptMessage {
  return {
    role: 'user',
    content: {
      type: 'resource_link',
      uri: `file://${absPath}`,
      name: absPath,
      annotations: { audience: ['assistant'], priority: 1 },
    },
  };
}

function wrapHandler<T>(
  name: string,
  options: PromptRegistrationOptions,
  requiresInit: boolean,
  fn: () => Promise<T> | T,
): Promise<T> | T {
  if (requiresInit && !options.isInitialized()) {
    throw new Error(`Prompt ${name} called before roots are initialized`);
  }
  const start = Date.now();
  const result = fn();
  if (result instanceof Promise) {
    return result.finally(() => {
      Logger.debug(`prompt resolved`, { name, durationMs: Date.now() - start });
    });
  }
  Logger.debug(`prompt resolved`, { name, durationMs: Date.now() - start });
  return result;
}

// --- Prompt entries (filled in by later tasks) ---

const GET_HELP: PromptEntry = {
  contract: {
    name: 'get-help',
    title: 'Get Help',
    description: 'Return filesystem-mcp usage instructions, optionally filtered to a section.',
    requiresPathGuard: false,
  },
  register(server, options) {
    const topics = Object.keys(INSTRUCTION_SECTIONS);
    server.registerPrompt(
      GET_HELP.contract.name,
      withDefaultIcons(
        {
          title: GET_HELP.contract.title,
          description: GET_HELP.contract.description,
          argsSchema: z.strictObject({
            topic: topicArg(
              topics,
              'Optional section key. Omit to return full instructions.',
            ).optional(),
          }),
        },
        options.iconInfo,
      ),
      ({ topic }): GetPromptResult | Promise<GetPromptResult> =>
        wrapHandler(GET_HELP.contract.name, options, false, () => {
          const section = topic ? INSTRUCTION_SECTIONS[topic.toLowerCase()] : undefined;
          const text =
            section ??
            (topic
              ? `Section '${topic}' not found. Available: ${topics.join(', ')}\n\n${options.instructions}`
              : options.instructions);
          return {
            description: GET_HELP.contract.description,
            messages: [userText(text)],
          };
        }),
    );
  },
};

const ANALYZE_PATH: PromptEntry = {
  contract: {
    name: 'analyze-path',
    title: 'Analyze Path',
    description: 'Workflow for analyzing a file or directory using stat, read, and tree.',
    requiresPathGuard: true,
  },
  register(server, options) {
    server.registerPrompt(
      ANALYZE_PATH.contract.name,
      withDefaultIcons(
        {
          title: ANALYZE_PATH.contract.title,
          description: ANALYZE_PATH.contract.description,
          argsSchema: z.strictObject({
            path: pathArg(server, options.pathGuard, 'path', 'Absolute path to analyze.'),
          }),
        },
        options.iconInfo,
      ),
      async ({ path: rawPath }): Promise<GetPromptResult> =>
        wrapHandler(ANALYZE_PATH.contract.name, options, true, async () => {
          const resolved = await options.pathGuard.validateExistingPath(rawPath);
          const stats = await stat(resolved);
          const kind = stats.isDirectory() ? 'directory' : 'file';
          const task =
            kind === 'file'
              ? `Analyze this file: ${resolved}\n\n- Call \`stat\` to confirm size and permissions.\n- Call \`read\` (with \`includeHash: true\`) and summarize contents.\n- Report: type, size, permissions, key observations.`
              : `Analyze this directory: ${resolved}\n\n- Call \`tree\` (maxDepth: 3) for layout.\n- Call \`ls\` for top-level entries.\n- Report: structure, notable files/subdirs, observations.`;
          return {
            description: ANALYZE_PATH.contract.description,
            messages: [userText(task), linkToPath(resolved), linkToInstructions()],
          };
        }),
    );
  },
};

const COMPARE_FILES: PromptEntry = {
  contract: {
    name: 'compare-files',
    title: 'Compare Files',
    description: 'Workflow for comparing two files using diff_files.',
    requiresPathGuard: true,
  },
  register(server, options) {
    server.registerPrompt(
      COMPARE_FILES.contract.name,
      withDefaultIcons(
        {
          title: COMPARE_FILES.contract.title,
          description: COMPARE_FILES.contract.description,
          argsSchema: z.strictObject({
            original: pathArg(server, options.pathGuard, 'original', 'Path to the original file.'),
            modified: pathArg(server, options.pathGuard, 'modified', 'Path to the modified file.'),
          }),
        },
        options.iconInfo,
      ),
      async ({ original, modified }): Promise<GetPromptResult> =>
        wrapHandler(COMPARE_FILES.contract.name, options, true, async () => {
          const [resolvedOriginal, resolvedModified] = await Promise.all([
            options.pathGuard.validateExistingPath(original),
            options.pathGuard.validateExistingPath(modified),
          ]);
          const text = [
            'Call `diff_files` with:',
            `- original: ${resolvedOriginal}`,
            `- modified: ${resolvedModified}`,
            '',
            'Then summarize: additions, deletions, and semantic changes. Flag potential conflicts, regressions, or breaking changes.',
          ].join('\n');
          return {
            description: COMPARE_FILES.contract.description,
            messages: [userText(text), linkToPath(resolvedOriginal), linkToPath(resolvedModified)],
          };
        }),
    );
  },
};

const PROMPT_ENTRIES: PromptEntry[] = [GET_HELP, ANALYZE_PATH, COMPARE_FILES];

export const ALL_PROMPTS: PromptContract[] = PROMPT_ENTRIES.map((e) => e.contract);

export function registerAllPrompts(server: McpServer, options: PromptRegistrationOptions): void {
  for (const { register } of PROMPT_ENTRIES) {
    register(server, options);
  }
}
