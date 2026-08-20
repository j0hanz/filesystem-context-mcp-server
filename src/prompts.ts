import type {
  GetPromptResult,
  McpServer,
  PromptMessage,
  ResourceLink,
  TextContent,
} from '@modelcontextprotocol/server';
import {
  completable,
  getDisplayName,
  ProtocolError,
  ProtocolErrorCode,
} from '@modelcontextprotocol/server';

import { lstat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import * as z from 'zod/v4';

import { hasErrorShape } from './core/errors.js';
import { Logger } from './core/observability.js';
import { PathCompleter } from './core/path-completer.js';
import type { PathGuard } from './core/path.js';
import type { IconInfo } from './core/primitives.js';
import { withDefaultIcons } from './core/primitives.js';
import type { Registrar } from './core/registrar.js';
import { isBlank, RequiredPath, SHELL_METACHAR_RE } from './core/schema.js';
import { INSTRUCTION_SECTIONS, serverInstructionsContent } from './resources.js';

// --- Types ---

interface PromptContract {
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

interface PromptRegistrationOptions {
  pathGuard: PathGuard;
  instructions: string;
  instructionsUri: string;
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
  return completable(
    RequiredPath.describe(
      `${description}. Must not contain directory traversal sequences (e.g. "..") or shell metacharacters, and cannot be empty or whitespace-only.`,
    ),
    (value, ctx) => completer.suggest(value, argumentName, ctx?.arguments ?? undefined),
  );
}

function topicArg(
  topics: readonly string[],
  description: string,
): ReturnType<typeof completable<z.ZodString>> {
  return completable(
    z
      .string()
      .min(1, { message: 'Topic required' })
      .refine((val) => !isBlank(val), {
        message: 'Topic cannot be empty or whitespace-only',
      })
      .refine((val) => !SHELL_METACHAR_RE.test(val), {
        message: 'Topic contains prohibited characters (newlines or shell metacharacters)',
      })
      .describe(
        `${description} Must not contain shell metacharacters and cannot be empty or whitespace-only.`,
      ),
    (value) => {
      const lower = value.toLowerCase();
      return lower ? topics.filter((t) => t.startsWith(lower)) : [...topics];
    },
  );
}

function userText(text: string): PromptMessage {
  const content: TextContent = {
    type: 'text',
    text,
    annotations: { audience: ['assistant'], priority: 1 },
  };
  return { role: 'user', content };
}

function linkToInstructions(uri: string): PromptMessage {
  const content: ResourceLink = {
    type: 'resource_link',
    uri,
    name: 'filesystem-mcp-instructions',
    mimeType: 'text/markdown',
    annotations: { audience: ['assistant'], priority: 0.5 },
  };
  return { role: 'user', content };
}

function linkToPath(absPath: string): PromptMessage {
  const content: ResourceLink = {
    type: 'resource_link',
    uri: pathToFileURL(absPath).href,
    name: absPath,
    annotations: { audience: ['assistant'], priority: 1 },
  };
  return { role: 'user', content };
}

async function wrapHandler<T>(
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

  try {
    const result = await fn();
    Logger.debug(`prompt resolved`, { name: contract.name, displayName });
    return result;
  } catch (error) {
    if (hasErrorShape(error, 'ProtocolError')) throw error;
    const message = error instanceof Error ? error.message : String(error);
    Logger.error(`Prompt handler failed: ${message}`, {
      promptName: contract.name,
      error,
    });
    const protocolError = new ProtocolError(ProtocolErrorCode.InvalidRequest, message);
    protocolError.cause = error;
    throw protocolError;
  }
}

// --- Prompt entries (filled in by later tasks) ---

const GET_HELP: PromptEntry = {
  contract: {
    name: 'get-help',
    title: 'Get Help',
    description:
      'Return filesystem-mcp server usage instructions, optionally filtered to a named section.',
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
              'Section key to filter instructions (e.g. "tools", "paths"); omit to return all instructions.',
            ).optional(),
          }),
        },
        options.iconInfo,
      ),
      ({ topic }: { topic?: string | undefined }): GetPromptResult | Promise<GetPromptResult> =>
        wrapHandler(GET_HELP.contract, options, false, () => {
          const lowerTopic = topic?.toLowerCase();
          const section =
            lowerTopic && Object.hasOwn(INSTRUCTION_SECTIONS, lowerTopic)
              ? INSTRUCTION_SECTIONS[lowerTopic]
              : undefined;
          if (topic && !section) {
            Logger.debug('get-help: unknown topic requested', { topic });
          }
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
    description:
      'Guided workflow to analyze a file or directory: runs stat, read, and tree, then reports type, size, permissions, and key observations.',
  },
  register(server, options) {
    server.registerPrompt(
      ANALYZE_PATH.contract.name,
      withDefaultIcons(
        {
          title: ANALYZE_PATH.contract.title,
          description: ANALYZE_PATH.contract.description,
          argsSchema: z.strictObject({
            path: pathArg(
              options.pathGuard,
              'path',
              'Absolute or relative path of the file or directory to analyze',
            ),
          }),
        },
        options.iconInfo,
      ),
      async ({ path: rawPath }: { path: string }): Promise<GetPromptResult> =>
        wrapHandler(ANALYZE_PATH.contract, options, true, async () => {
          const resolved = await options.pathGuard.validateExistingPath(rawPath);
          const stats = await lstat(resolved);
          const kind = stats.isDirectory() ? 'directory' : 'file';
          const task =
            kind === 'file'
              ? `Analyze this file: ${resolved}\n\n- Call \`stat\` to confirm size and permissions.\n- Call \`read\` (with \`includeHash: true\`) and summarize contents.\n- Report: type, size, permissions, key observations.`
              : `Analyze this directory: ${resolved}\n\n- Call \`list\` (maxDepth: 3) for the layout and its top-level entries.\n- Report: structure, notable files/subdirs, observations.`;
          return {
            description: ANALYZE_PATH.contract.description,
            messages: [
              userText(task),
              linkToPath(resolved),
              linkToInstructions(options.instructionsUri),
            ],
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
    description:
      'Locate files by name pattern or content match under a directory; combines find_files and search_text.',
  },
  register(server, options) {
    server.registerPrompt(
      FIND_IN_TREE.contract.name,
      withDefaultIcons(
        {
          title: FIND_IN_TREE.contract.title,
          description: FIND_IN_TREE.contract.description,
          argsSchema: z.strictObject({
            query: z
              .string()
              .min(1)
              .refine((val) => !isBlank(val), {
                message: 'Query cannot be empty or whitespace-only',
              })
              .refine((val) => !SHELL_METACHAR_RE.test(val), {
                message: 'Query contains prohibited characters (newlines or shell metacharacters)',
              })
              .describe(
                'Search term. Glob pattern for name mode or RE2 regex pattern for content/both modes. Cannot be empty or whitespace-only, and must not contain shell metacharacters.',
              ),
            root: pathArg(
              options.pathGuard,
              'root',
              'Directory to search under (must be within an allowed root); defaults to the first allowed root.',
            ).optional(),
            mode: FIND_IN_TREE_MODE.default('both').describe(
              'Search scope: name = filename patterns only, content = file content only, both = all.',
            ),
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
          if (candidate === undefined) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidRequest,
              'find-in-tree: no root provided and no allowed directories',
            );
          }
          const resolved = await options.pathGuard.validateExistingDirectory(candidate);
          const steps: string[] = [];
          if (mode === 'name' || mode === 'both') {
            steps.push(`- Call \`find_files\` with pattern "${query}" under "${resolved}".`);
          }
          if (mode === 'content' || mode === 'both') {
            steps.push(
              `- Call \`search_text\` with pattern "${query}" under "${resolved}". Report relative paths, line numbers, and a 1-line context for each match.`,
            );
          }
          const text = [`Find "${query}" in ${resolved} (mode=${mode}):`, '', ...steps].join('\n');
          return {
            description: FIND_IN_TREE.contract.description,
            messages: [userText(text), linkToInstructions(options.instructionsUri)],
          };
        }),
    );
  },
};

const SUMMARIZE_DIRECTORY: PromptEntry = {
  contract: {
    name: 'summarize-directory',
    title: 'Summarize Directory',
    description:
      'Generate an onboarding summary for a project directory: purpose, tech stack, entry points, and directory structure.',
  },
  register(server, options) {
    server.registerPrompt(
      SUMMARIZE_DIRECTORY.contract.name,
      withDefaultIcons(
        {
          title: SUMMARIZE_DIRECTORY.contract.title,
          description: SUMMARIZE_DIRECTORY.contract.description,
          argsSchema: z.strictObject({
            path: pathArg(
              options.pathGuard,
              'path',
              'Absolute or relative path of the directory to summarize',
            ),
            depth: z.coerce
              .number()
              .pipe(z.int32().min(1).max(6))
              .default(3)
              .describe(
                'Maximum tree depth for directory listing (1 = top-level only, 6 = deep; default 3).',
              ),
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
            `- Call \`list\` with maxDepth=${depth}.`,
            '- Call `read` with paths[] for top-level manifests when present: README.md, package.json, Cargo.toml, pyproject.toml, go.mod, build.gradle, pom.xml, Dockerfile.',
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

export const promptsRegistrar: Registrar = {
  register(deps): void {
    const options = {
      pathGuard: deps.pathGuard,
      instructions: serverInstructionsContent,
      instructionsUri: 'internal://instructions',
      isInitialized: deps.isInitialized,
      ...(deps.iconInfo ? { iconInfo: deps.iconInfo } : {}),
    };
    for (const { register } of PROMPT_ENTRIES) {
      register(deps.server, options);
    }
  },
  dispose(): void {
    /* no-op */
  },
};

export { PROMPT_ENTRIES };
