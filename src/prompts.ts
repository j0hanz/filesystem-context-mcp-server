import type {
  GetPromptResult,
  McpServer,
  PromptMessage,
  TextContent,
} from '@modelcontextprotocol/server';
import { completable, getDisplayName, ProtocolError } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { formatUnknownErrorMessage, fsErrorCode, hasErrorShape } from './core/errors.js';
import { Logger } from './core/observability.js';
import { isBlank, SHELL_METACHAR_RE } from './core/schema.js';
import { buildSectionsRecord, INSTRUCTIONS_URI, renderSections } from './instructions.js';

// --- Types ---

interface PromptContract {
  readonly name: string;
  readonly title: string;
  readonly description: string;
}

interface PromptRegistrarDeps {
  readonly server: McpServer;
  readonly readOnly?: boolean;
}

interface PromptRegistrationOptions {
  sections: Record<string, string>;
  instructions: string;
  instructionsUri: string;
}

interface PromptEntry {
  readonly contract: PromptContract;
  readonly register: (server: McpServer, options: PromptRegistrationOptions) => void;
}

// --- Helpers ---

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
      .describe(description),
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
    const protocolError = new ProtocolError(fsErrorCode(error), message);
    protocolError.cause = error;
    throw protocolError;
  }
}

// --- Prompt entries ---

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
            `Section key to filter instructions (one of: ${topics.join(', ')}); omit to return all instructions.`,
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

const PROMPT_ENTRIES: PromptEntry[] = [GET_HELP];

export function registerPrompts(deps: PromptRegistrarDeps): void {
  const sections = buildSectionsRecord(deps.readOnly ?? false);
  const options = {
    sections,
    instructions: renderSections(sections),
    instructionsUri: INSTRUCTIONS_URI,
  };
  for (const { register } of PROMPT_ENTRIES) {
    register(deps.server, options);
  }
}

export { PROMPT_ENTRIES };
