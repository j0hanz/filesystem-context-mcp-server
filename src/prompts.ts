import {
  completable,
  getDisplayName,
  type GetPromptResult,
  type McpServer,
  type PromptMessage,
  ProtocolError,
  ProtocolErrorCode,
  type ResourceLink,
  type TextContent,
} from '@modelcontextprotocol/server';

import { stat } from 'node:fs/promises';

import { z } from 'zod/v4';

import { Logger, withTelemetry } from './core/observability.js';
import { PathCompleter } from './core/path.js';
import type { PathGuard } from './core/path.js';
import { INSTRUCTION_SECTIONS } from './resources.js';
import { type IconInfo, withDefaultIcons } from './tools/define.js';

// --- Types ---

interface PromptContract {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly requiresPathGuard: boolean;
}

interface PromptRegistrationOptions {
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
  guard: PathGuard,
  argumentName: string,
  description: string,
): ReturnType<typeof completable<z.ZodString>> {
  const completer = new PathCompleter(guard);
  return completable(z.string().describe(description), (value, ctx) =>
    completer.suggest(value, argumentName, ctx?.arguments ?? undefined),
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
  const content: TextContent = {
    type: 'text',
    text,
    annotations: { audience: ['assistant'], priority: 1 },
  };
  return { role: 'user', content };
}

function linkToInstructions(): PromptMessage {
  const content: ResourceLink = {
    type: 'resource_link',
    uri: 'internal://instructions',
    name: 'filesystem-mcp-instructions',
    mimeType: 'text/markdown',
    annotations: { audience: ['assistant'], priority: 0.5 },
  };
  return { role: 'user', content };
}

function linkToPath(absPath: string): PromptMessage {
  const content: ResourceLink = {
    type: 'resource_link',
    uri: `file://${absPath}`,
    name: absPath,
    annotations: { audience: ['assistant'], priority: 1 },
  };
  return { role: 'user', content };
}

function wrapHandler<T>(
  contract: PromptContract,
  options: PromptRegistrationOptions,
  requiresInit: boolean,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (requiresInit && !options.isInitialized()) {
    throw new ProtocolError(
      ProtocolErrorCode.InvalidRequest,
      `Prompt ${contract.name} called before roots are initialized`,
    );
  }
  const displayName = getDisplayName(contract);

  return withTelemetry(
    {
      event: 'prompt_complete',
      prompt_name: contract.name,
      display_name: displayName,
    },
    async () => {
      try {
        const result = await fn();
        Logger.debug(`prompt resolved`, {
          name: contract.name,
          displayName,
        });
        return result;
      } catch (error) {
        throw new ProtocolError(
          ProtocolErrorCode.InvalidRequest,
          error instanceof Error ? error.message : String(error),
        );
      }
    },
  );
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
      ({ topic }: { topic?: string | undefined }): GetPromptResult | Promise<GetPromptResult> =>
        wrapHandler(GET_HELP.contract, options, false, () => {
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
            path: pathArg(options.pathGuard, 'path', 'Path to explore'),
          }),
        },
        options.iconInfo,
      ),
      async ({ path: rawPath }: { path: string }): Promise<GetPromptResult> =>
        wrapHandler(ANALYZE_PATH.contract, options, true, async () => {
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

const FIND_IN_TREE_MODE = z.enum(['name', 'content', 'both']);

const FIND_IN_TREE: PromptEntry = {
  contract: {
    name: 'find-in-tree',
    title: 'Find in Tree',
    description: 'Locate files and matches by name and content under a directory.',
    requiresPathGuard: true,
  },
  register(server, options) {
    server.registerPrompt(
      FIND_IN_TREE.contract.name,
      withDefaultIcons(
        {
          title: FIND_IN_TREE.contract.title,
          description: FIND_IN_TREE.contract.description,
          argsSchema: z.strictObject({
            query: z.string().min(1).describe('Search term (name pattern or content regex).'),
            root: pathArg(
              options.pathGuard,
              'root',
              'Directory to search under. Defaults to first allowed root.',
            ).optional(),
            mode: FIND_IN_TREE_MODE.default('both').describe('Search by name, content, or both.'),
          }),
        },
        options.iconInfo,
      ),
      async ({
        query,
        root,
        mode,
      }: {
        query: string;
        root?: string | undefined;
        mode: 'name' | 'content' | 'both';
      }): Promise<GetPromptResult> =>
        wrapHandler(FIND_IN_TREE.contract, options, true, async () => {
          const allowed = options.pathGuard.getAllowedDirectories();
          const candidate = root ?? allowed[0];
          if (!candidate) {
            throw new Error('find-in-tree: no root provided and no allowed directories');
          }
          const resolved = await options.pathGuard.validateExistingDirectory(candidate);
          const steps: string[] = [];
          if (mode === 'name' || mode === 'both') {
            steps.push(`- Call \`find\` with pattern "${query}" under "${resolved}".`);
          }
          if (mode === 'content' || mode === 'both') {
            steps.push(
              `- Call \`grep\` with pattern "${query}" under "${resolved}". Report relative paths, line numbers, and a 1-line context for each match.`,
            );
          }
          const text = [`Find "${query}" in ${resolved} (mode=${mode}):`, '', ...steps].join('\n');
          return {
            description: FIND_IN_TREE.contract.description,
            messages: [userText(text), linkToInstructions()],
          };
        }),
    );
  },
};

const SUMMARIZE_DIRECTORY: PromptEntry = {
  contract: {
    name: 'summarize-directory',
    title: 'Summarize Directory',
    description: 'Onboarding summary: purpose, tech stack, entry points, structure.',
    requiresPathGuard: true,
  },
  register(server, options) {
    server.registerPrompt(
      SUMMARIZE_DIRECTORY.contract.name,
      withDefaultIcons(
        {
          title: SUMMARIZE_DIRECTORY.contract.title,
          description: SUMMARIZE_DIRECTORY.contract.description,
          argsSchema: z.strictObject({
            path: pathArg(options.pathGuard, 'path', 'Directory to summarize.'),
            depth: z.coerce
              .number<number>()
              .pipe(z.int32().min(1).max(6))
              .default(3)
              .describe('Tree depth (1-6).'),
          }),
        },
        options.iconInfo,
      ),
      async ({ path: rawPath, depth }: { path: string; depth: number }): Promise<GetPromptResult> =>
        wrapHandler(SUMMARIZE_DIRECTORY.contract, options, true, async () => {
          const resolved = await options.pathGuard.validateExistingDirectory(rawPath);
          const text = [
            `Summarize this project at ${resolved}:`,
            '',
            `- Call \`tree\` with maxDepth=${depth}.`,
            '- Call `read_many` for top-level manifests when present: README.md, package.json, Cargo.toml, pyproject.toml, go.mod, build.gradle, pom.xml, Dockerfile.',
            '- Produce: purpose, tech stack, entry points, notable directories.',
          ].join('\n');
          return {
            description: SUMMARIZE_DIRECTORY.contract.description,
            messages: [userText(text), linkToPath(resolved)],
          };
        }),
    );
  },
};

const PROMPT_ENTRIES: PromptEntry[] = [GET_HELP, ANALYZE_PATH, FIND_IN_TREE, SUMMARIZE_DIRECTORY];

export { PROMPT_ENTRIES };
