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
import { buildSectionsRecord, INSTRUCTIONS_SUMMARY, renderSections } from './instructions.js';

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

const GET_HELP: PromptContract = {
  name: 'get-help',
  title: 'Get Help',
  description: INSTRUCTIONS_SUMMARY,
};

export function registerPrompts(deps: PromptRegistrarDeps): void {
  const sections = buildSectionsRecord(deps.readOnly ?? false);
  const instructions = renderSections(sections);
  const topics = Object.keys(sections);

  deps.server.registerPrompt(
    GET_HELP.name,
    {
      title: GET_HELP.title,
      description: GET_HELP.description,
      argsSchema: z.strictObject({
        topic: topicArg(
          topics,
          `Section key to filter instructions (one of: ${topics.join(', ')}); omit to return all instructions.`,
        ).optional(),
      }),
    },
    ({ topic }: { topic?: string | undefined }): GetPromptResult | Promise<GetPromptResult> =>
      wrapHandler(GET_HELP, () => {
        const lowerTopic = topic?.toLowerCase();
        const section =
          lowerTopic && Object.hasOwn(sections, lowerTopic) ? sections[lowerTopic] : undefined;
        if (topic && !section) {
          Logger.debug('get-help: unknown topic requested', { topic });
        }
        const text =
          section ??
          (topic
            ? `Section '${topic}' not found. Available: ${topics.join(', ')}\n\n${instructions}`
            : instructions);
        return {
          description: GET_HELP.description,
          messages: [userText(text)],
        };
      }),
  );
}
