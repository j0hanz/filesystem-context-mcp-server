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

import * as z from 'zod/v4';

import { formatUnknownErrorMessage, hasErrorShape } from './core/errors.js';
import { buildFileResourceUri } from './core/file-uri.js';
import { Logger } from './core/observability.js';
import { PathCompleter } from './core/path-completer.js';
import type { PathGuard } from './core/path.js';
import { isBlank, RequiredPath, SHELL_METACHAR_RE } from './core/schema.js';
import {
  buildSectionsRecord,
  INSTRUCTIONS_URI,
  linkToInstructions,
  renderSections,
} from './instructions.js';
import type { ServerDeps } from './server.js';

// --- Types ---

interface PromptContract {
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

interface PromptRegistrationOptions {
  pathGuard: PathGuard;
  sections: Record<string, string>;
  instructions: string;
  instructionsUri: string;
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

function linkToPath(absPath: string): PromptMessage {
  const content: ResourceLink = {
    type: 'resource_link',
    uri: buildFileResourceUri(absPath),
    name: absPath,
    annotations: { audience: ['assistant'], priority: 1 },
  };
  return { role: 'user', content };
}

async function wrapHandler<T>(contract: PromptContract, fn: () => Promise<T> | T): Promise<T> {
  const displayName = getDisplayName(contract);

  try {
    const result = await fn();
    Logger.debug(`prompt resolved`, { name: contract.name, displayName });
    return result;
  } catch (error) {
    if (hasErrorShape(error, 'ProtocolError')) throw error;
    const message = formatUnknownErrorMessage(error);
    Logger.error(`Prompt handler failed: ${message}`, {
      promptName: contract.name,
      error,
    });
    const protocolError = new ProtocolError(ProtocolErrorCode.InvalidParams, message);
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
    const topics = Object.keys(options.sections);
    server.registerPrompt(
      GET_HELP.contract.name,
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
      ({ topic }: { topic?: string | undefined }): GetPromptResult | Promise<GetPromptResult> =>
        wrapHandler(GET_HELP.contract, () => {
          const lowerTopic = topic?.toLowerCase();
          const section =
            lowerTopic && Object.hasOwn(options.sections, lowerTopic)
              ? options.sections[lowerTopic]
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
      async ({ path: rawPath }: { path: string }): Promise<GetPromptResult> =>
        wrapHandler(ANALYZE_PATH.contract, async () => {
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
      async ({
        query,
        root,
        mode,
      }: {
        query: string;
        root?: string | undefined;
        mode: 'name' | 'content' | 'both';
      }): Promise<GetPromptResult> =>
        wrapHandler(FIND_IN_TREE.contract, async () => {
          const allowed = options.pathGuard.getAllowedDirectories();
          const candidate = root ?? allowed[0];
          if (candidate === undefined) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
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
              `- Call \`search_text\` with searchPattern "${query}" under "${resolved}". Report relative paths, line numbers, and a 1-line context for each match.`,
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
      async ({ path: rawPath, depth }: { path: string; depth: number }): Promise<GetPromptResult> =>
        wrapHandler(SUMMARIZE_DIRECTORY.contract, async () => {
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

const AUDIT_WORKSPACE_SECURITY: PromptEntry = {
  contract: {
    name: 'audit-workspace-security',
    title: 'Audit Workspace Security',
    description:
      'Scan workspace for sensitive files, credential leaks, and review directory access permissions.',
  },
  register(server, options) {
    server.registerPrompt(
      AUDIT_WORKSPACE_SECURITY.contract.name,
      {
        title: AUDIT_WORKSPACE_SECURITY.contract.title,
        description: AUDIT_WORKSPACE_SECURITY.contract.description,
        argsSchema: z.strictObject({
          root: pathArg(
            options.pathGuard,
            'root',
            'Directory to audit (defaults to first allowed root)',
          ).optional(),
        }),
      },
      async ({ root }: { root?: string | undefined }): Promise<GetPromptResult> =>
        wrapHandler(AUDIT_WORKSPACE_SECURITY.contract, async () => {
          const candidate = root ?? options.pathGuard.getAllowedDirectories()[0];
          if (candidate === undefined) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              'audit-workspace-security: no root provided and no allowed directories',
            );
          }
          const resolved = await options.pathGuard.validateExistingDirectory(candidate);
          const text = [
            `Security audit for workspace at ${resolved}:`,
            '',
            '- Call `list_roots` to confirm active workspace root boundaries.',
            '- Call `find_files` with patterns for sensitive files: `.env*`, `*.pem`, `*.key`, `*id_rsa*`, `credentials.json`.',
            '- Call `stat` on discovered candidate paths to inspect permissions and ownership.',
            '- Call `search_text` for high-risk pattern markers (e.g. `API_KEY`, `PASSWORD`, `SECRET`, `BEGIN PRIVATE KEY`).',
            '- Report: found sensitive files, exposure risks, and recommended remediations.',
          ].join('\n');
          return {
            description: AUDIT_WORKSPACE_SECURITY.contract.description,
            messages: [
              userText(text),
              linkToPath(resolved),
              linkToInstructions(options.instructionsUri),
            ],
          };
        }),
    );
  },
};

const REFACTOR_WORKFLOW: PromptEntry = {
  contract: {
    name: 'refactor-workflow',
    title: 'Refactor Workflow',
    description:
      'Guided multi-step refactoring workflow: locate occurrences, preview diffs via dryRun, and verify edits.',
  },
  register(server, options) {
    server.registerPrompt(
      REFACTOR_WORKFLOW.contract.name,
      {
        title: REFACTOR_WORKFLOW.contract.title,
        description: REFACTOR_WORKFLOW.contract.description,
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
            .describe('Symbol, function, or string pattern to refactor across the workspace.'),
          root: pathArg(
            options.pathGuard,
            'root',
            'Root directory to scope the refactoring within (defaults to first allowed root)',
          ).optional(),
          dryRun: z
            .stringbool()
            .default(true)
            .describe('Preview changes as unified diffs first before applying (default: true).'),
        }),
      },
      async ({
        query,
        root,
        dryRun,
      }: {
        query: string;
        root?: string | undefined;
        dryRun: boolean;
      }): Promise<GetPromptResult> =>
        wrapHandler(REFACTOR_WORKFLOW.contract, async () => {
          const candidate = root ?? options.pathGuard.getAllowedDirectories()[0];
          if (candidate === undefined) {
            throw new ProtocolError(
              ProtocolErrorCode.InvalidParams,
              'refactor-workflow: no root provided and no allowed directories',
            );
          }
          const resolved = await options.pathGuard.validateExistingDirectory(candidate);
          const dryLabel = dryRun ? ' (dryRun=true)' : '';
          const text = [
            `Refactor workflow for "${query}" under ${resolved}${dryLabel}:`,
            '',
            `1. Discover: Call \`search_text\` with searchPattern "${query}" to list all affected files and line occurrences.`,
            '2. Read Context: Call `read` on each matching file to inspect surrounding block context (3-5 lines).',
            `3. Preview: Call \`edit\` with dryRun=true (or \`replace_text\` with dryRun=true and returnDiff=true) to inspect unified diffs without modifying files.`,
            '4. Apply & Verify: Once confirmed, re-run `edit` with dryRun=false, run validation checks, and verify behavior.',
          ].join('\n');
          return {
            description: REFACTOR_WORKFLOW.contract.description,
            messages: [
              userText(text),
              linkToPath(resolved),
              linkToInstructions(options.instructionsUri),
            ],
          };
        }),
    );
  },
};

const PROMPT_ENTRIES: PromptEntry[] = [
  GET_HELP,
  ANALYZE_PATH,
  FIND_IN_TREE,
  SUMMARIZE_DIRECTORY,
  AUDIT_WORKSPACE_SECURITY,
  REFACTOR_WORKFLOW,
];

export function registerPrompts(deps: ServerDeps): void {
  const sections = buildSectionsRecord(deps.readOnly ?? false);
  const options = {
    pathGuard: deps.pathGuard,
    sections,
    instructions: renderSections(sections),
    instructionsUri: INSTRUCTIONS_URI,
  };
  for (const { register } of PROMPT_ENTRIES) {
    register(deps.server, options);
  }
}

export { PROMPT_ENTRIES };
