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

const PROMPT_ENTRIES: PromptEntry[] = [];

export const ALL_PROMPTS: PromptContract[] = PROMPT_ENTRIES.map((e) => e.contract);

export function registerAllPrompts(server: McpServer, options: PromptRegistrationOptions): void {
  for (const { register } of PROMPT_ENTRIES) {
    register(server, options);
  }
}
