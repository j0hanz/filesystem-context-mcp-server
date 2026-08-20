import type {
  CallToolResult,
  ContentBlock,
  ElicitRequestFormParams,
  ElicitResult,
  McpServer,
  Notification,
  PrimitiveSchemaDefinition,
  RequestMeta,
  ServerContext,
  StandardSchemaWithJSON,
  Tool,
  ToolAnnotations,
} from '@modelcontextprotocol/server';
import { SdkErrorCode } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { ErrorCode, hasErrorShape, Problem } from '../core/errors.js';
import type { ProgressCtx } from '../core/fmt.js';
import { plainMessage } from '../core/fmt.js';
import { GuardedFileSystem } from '../core/fs.js';
import { Logger } from '../core/observability.js';
import type { LoggingLevel } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { ResourceStore } from '../core/store.js';
import {
  McpProgressSink,
  ProgressSession,
  type ProgressSink,
  StderrProgressSink,
} from './progress.js';

// ============ Type Definitions ============

export interface ToolCtx {
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly _meta?: RequestMeta | undefined;
  readonly pathGuard: PathGuard;
  readonly fs: GuardedFileSystem;
  readonly resourceStore: ResourceStore | undefined;
  readonly log?: (level: LoggingLevel, data: unknown, logger?: string) => void;
  readonly sendNotification?: (notification: Notification) => Promise<void>;
  readonly onProgress?: (params: { current: number; total?: number }) => void;
  readonly elicitInput?: (params: ElicitRequestFormParams) => Promise<ElicitResult>;
  readonly server?: McpServer;
}

interface ToolDeps {
  readonly isInitialized: () => boolean;
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
}

interface RunResult<T> {
  readonly structured: T;
  readonly text?: string;
  readonly resources?: ContentBlock[];
}

export interface ToolDef<I extends z.ZodType, O extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: I;
  readonly output: O;
  readonly annotations: ToolAnnotations;
  readonly timeoutMs?: number;
  readonly progress?: (args: z.infer<I>) => ProgressCtx;
  readonly progressDone?: (args: z.infer<I>, result: z.infer<O>) => Partial<ProgressCtx>;
  readonly defaultErrorCode?: ErrorCode;
  readonly run: (args: z.infer<I>, ctx: ToolCtx) => Promise<RunResult<z.infer<O>>>;
}

export interface DefinedTool {
  readonly name: string;
  readonly inputSchema: Tool['inputSchema'];
  readonly outputSchema: Record<string, unknown>;

  register(deps: ToolDeps): void;
}

/**
 * True when the connection cannot answer an elicitation at all — as opposed to
 * the user seeing the prompt and declining it. Two different SDK throws mean
 * the same thing to a caller:
 *
 * - `CapabilityNotSupported` — client never advertised elicitation (or not the
 *   requested mode).
 * - `MethodNotSupportedByProtocolVersion` — the 2026-07-28 era dropped
 *   push-style server→client requests, so `elicitInput` throws locally before
 *   anything reaches the client. Migrating to `inputRequired(...)` would let
 *   these tools prompt on that era; until then they must not read the era's
 *   refusal as a "no" from the user.
 *
 * Neither is a denial, and neither is a transport failure — each caller picks
 * the fallback that is safe for its own operation.
 */
function isElicitationUnavailable(error: unknown): boolean {
  return (
    hasErrorShape(error, 'SdkError', SdkErrorCode.CapabilityNotSupported) ||
    hasErrorShape(error, 'SdkError', SdkErrorCode.MethodNotSupportedByProtocolVersion)
  );
}

/**
 * Owner of the elicit-a-boolean-then-check idiom: builds the single-field form,
 * sends it, and classifies the outcome. Returns `{ confirmed, unavailable, error }`
 * so each caller can apply its own fallback policy (proceed / fail-closed /
 * cancel) without re-implementing the form-build and error triage.
 */
export async function confirmBoolean(
  ctx: Pick<ToolCtx, 'elicitInput'>,
  field: string,
  message: string,
  title: string,
): Promise<{ confirmed: boolean; unavailable: boolean; error: unknown }> {
  const { elicitInput } = ctx;
  if (!elicitInput) return { confirmed: false, unavailable: true, error: undefined };
  const fieldSchema: PrimitiveSchemaDefinition = { type: 'boolean', title };
  try {
    const result = await elicitInput({
      mode: 'form',
      message,
      requestedSchema: {
        type: 'object',
        properties: { [field]: fieldSchema },
        required: [field],
      },
    });
    return {
      confirmed: result.action === 'accept' && result.content?.[field] === true,
      unavailable: false,
      error: undefined,
    };
  } catch (err) {
    if (isElicitationUnavailable(err))
      return { confirmed: false, unavailable: true, error: undefined };
    return { confirmed: false, unavailable: false, error: err };
  }
}

// ============ Context Builder ============

function toToolCtx(
  ctx: ServerContext | undefined,
  deps: Pick<ToolDeps, 'pathGuard' | 'resourceStore' | 'server'>,
): ToolCtx {
  if (!ctx) {
    const signal = new AbortController().signal;
    return {
      signal,
      pathGuard: deps.pathGuard,
      fs: new GuardedFileSystem(deps.pathGuard),
      resourceStore: deps.resourceStore,
      server: deps.server,
    };
  }
  return {
    signal: ctx.mcpReq.signal,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
    pathGuard: deps.pathGuard,
    fs: new GuardedFileSystem(deps.pathGuard),
    resourceStore: deps.resourceStore,
    sendNotification: async (notification) => ctx.mcpReq.notify(notification),
    // elicitInput: deprecated (SEP-2577, 2026-07-28 era) — throws there since the
    // push-style server-to-client request model is replaced by input_required.
    // Remains correct on the current default protocol version (2025-11-25); the
    // access-grant confirmation flow already treats a throw as a denial (see
    // PathGuard.requestAccessGrant). Full migration needs the new
    // multi-round-trip pattern, tracked in repo memory, not done here.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see comment above
    elicitInput: (params) => ctx.mcpReq.elicitInput(params),
    server: deps.server,
  };
}

function buildExecutionCtx(
  ctx: ToolCtx,
  signal: AbortSignal,
  onProgress: (p: { current: number; total?: number }) => void,
): ToolCtx {
  return {
    signal,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx._meta ? { _meta: ctx._meta } : {}),
    pathGuard: ctx.pathGuard,
    fs: ctx.fs,
    resourceStore: ctx.resourceStore,
    ...(ctx.server ? { server: ctx.server } : {}),
    log: (level: LoggingLevel, data: unknown) => {
      Logger.emit(level, typeof data === 'string' ? data : String(data));
    },
    ...(ctx.sendNotification ? { sendNotification: ctx.sendNotification } : {}),
    onProgress,
    ...(ctx.elicitInput ? { elicitInput: ctx.elicitInput } : {}),
  };
}

// ============ Execution Helpers ============

function resolveProgressCtx<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
  args: z.infer<I>,
): ProgressCtx {
  if (!def.progress) return { label: def.title };
  try {
    return def.progress(args);
  } catch (err: unknown) {
    Logger.warn(`resolveProgressCtx: ${def.name}.progress threw: ${String(err)}`);
    return { label: def.title };
  }
}

function composeSignal(base: AbortSignal, timeoutMs?: number): AbortSignal {
  if (!timeoutMs) return base;
  return AbortSignal.any([base, AbortSignal.timeout(timeoutMs)]);
}

function buildSuccessResponse<O>(result: RunResult<O>): CallToolResult {
  const text = result.text ?? JSON.stringify(result.structured);
  const content: ContentBlock[] = [{ type: 'text' as const, text }, ...(result.resources ?? [])];
  return {
    content,
    structuredContent: result.structured,
  };
}

// ============ Tool Execution ============

class ToolExecutor<I extends z.ZodType, O extends z.ZodType> {
  readonly signal: AbortSignal;
  private readonly def: ToolDef<I, O>;
  private readonly parsedArgs: z.infer<I>;
  private readonly toolCtx: ToolCtx;

  #progressClosed = false;
  readonly #progressCtx: ProgressCtx;
  readonly #mcpSink?: McpProgressSink;
  readonly #stderrSink: StderrProgressSink;
  readonly #progressSession: ProgressSession;

  constructor(toolName: string, ctx: ToolCtx, def: ToolDef<I, O>, parsedArgs: z.infer<I>) {
    this.def = def;
    this.parsedArgs = parsedArgs;
    this.signal = composeSignal(ctx.signal, def.timeoutMs);
    this.#progressCtx = resolveProgressCtx(def, parsedArgs);
    this.#stderrSink = new StderrProgressSink(this.#progressCtx);
    const sinks: ProgressSink[] = [this.#stderrSink];
    if (ctx._meta?.progressToken !== undefined && ctx.sendNotification !== undefined) {
      this.#mcpSink = new McpProgressSink(toolName, ctx._meta.progressToken, ctx.sendNotification);
      sinks.push(this.#mcpSink);
    }
    const isTest = process.env['NODE_ENV'] === 'test' || process.execArgv.includes('--test');
    this.#progressSession = new ProgressSession({
      label: this.#progressCtx.label,
      sinks,
      ...(isTest ? { rateLimitMs: 0 } : {}),
      dynamicRateLimit: !isTest,
    });
    this.toolCtx = buildExecutionCtx(ctx, this.signal, (p) => {
      this.#tick(p);
    });
  }

  #tick(p: { current: number; total?: number }): void {
    if (this.#progressClosed) return;
    const tickCtx: ProgressCtx = {
      ...this.#progressCtx,
      current: p.current,
      ...(p.total !== undefined ? { total: p.total } : {}),
    };
    this.#progressSession.set({ ...p, message: plainMessage('tick', tickCtx) });
  }

  async #closeWithDone(message: string): Promise<void> {
    this.#progressClosed = true;
    this.#progressSession.complete(message);
    if (this.#mcpSink) await this.#mcpSink.flush();
  }

  async #closeWithFail(error: unknown, message: string): Promise<void> {
    this.#progressClosed = true;
    this.#progressSession.fail(error, message);
    if (this.#mcpSink) await this.#mcpSink.flush();
  }

  async #flushProgress(): Promise<void> {
    if (this.#mcpSink) await this.#mcpSink.flush();
  }

  private async completeProgress(result: z.infer<O>): Promise<void> {
    const doneCtx: ProgressCtx = this.def.progressDone
      ? { ...this.#progressCtx, ...this.def.progressDone(this.parsedArgs, result) }
      : this.#progressCtx;
    await this.#closeWithDone(plainMessage('done', doneCtx));
  }

  private async failProgress(error: unknown): Promise<{ isError: true; content: ContentBlock[] }> {
    const errMsg = error instanceof Error ? error.message : String(error);
    this.#stderrSink.updateCtx({ error: errMsg });
    const message = plainMessage('fail', { ...this.#progressCtx, error: errMsg });
    await this.#closeWithFail(error, message);
    const { text: errorText } = Problem.toText(
      error,
      this.def.defaultErrorCode ?? ErrorCode.UNKNOWN,
    );
    return {
      content: [{ type: 'text' as const, text: errorText }],
      isError: true,
    };
  }

  private buildAccessDeniedHandler(): ((blockedPath: string) => Promise<boolean>) | undefined {
    if (!this.toolCtx.elicitInput) return undefined;
    const elicitInput = this.toolCtx.elicitInput;
    const mcpServer = this.toolCtx.server;
    if (mcpServer == null) return undefined;
    // getClientCapabilities(): deprecated (SEP-2577, 2026-07-28 era) in favor of
    // reading ctx.mcpReq.envelope per-request, but this runs outside a live
    // per-request context (a lazily-built access-grant handler) where no
    // envelope is available. The SDK backfills this accessor correctly for both
    // protocol eras, so behavior remains correct; tracked in repo memory.
    // eslint-disable-next-line @typescript-eslint/no-deprecated -- see comment above
    let caps: ReturnType<typeof mcpServer.server.getClientCapabilities>;
    try {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- see comment above
      caps = mcpServer.server.getClientCapabilities();
    } catch {
      return undefined;
    }
    if (!caps?.elicitation) return undefined;

    const pathGuard = this.toolCtx.pathGuard;

    const confirm = async (targetDir: string): Promise<boolean> => {
      const r = await confirmBoolean(
        { elicitInput },
        'confirm',
        `Grant filesystem access to: ${targetDir}?`,
        'Confirm',
      );
      // No grant without a user saying yes, so an unaskable connection is
      // still a denial — but a quiet one. requestAccessGrant's catch would
      // otherwise warn on every out-of-root path for the whole session.
      if (r.unavailable) return false;
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- rethrow the elicitation failure verbatim so callers see the original error
      if (r.error) throw r.error;
      return r.confirmed;
    };

    return (blockedPath: string) => pathGuard.requestAccessGrant(blockedPath, { confirm });
  }

  async execute(deps: ToolDeps): Promise<CallToolResult> {
    if (!deps.isInitialized()) {
      return {
        isError: true as const,
        content: [{ type: 'text' as const, text: 'Server not initialized. Roots unavailable.' }],
      };
    }

    const runTool = async (): Promise<CallToolResult> => {
      try {
        const result = await this.def.run(this.parsedArgs, this.toolCtx);
        await this.completeProgress(result.structured);
        return buildSuccessResponse(result);
      } catch (error) {
        return await this.failProgress(error);
      } finally {
        await this.#flushProgress();
      }
    };

    const handler = this.buildAccessDeniedHandler();
    // Scope the access-denied (elicitation) handler to this request's async
    // chain via AsyncLocalStorage so concurrent tools/call calls sharing one
    // PathGuard cannot overwrite each other's handler.
    if (handler !== undefined) {
      return this.toolCtx.pathGuard.runWithAccessDeniedHandler(handler, runTool);
    }
    return runTool();
  }
}

async function executeTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
  ctx: ToolCtx,
  deps: ToolDeps,
  args: z.infer<I>,
): Promise<CallToolResult> {
  const executor = new ToolExecutor<I, O>(def.name, ctx, def, args);
  return executor.execute(deps);
}

function createServerToolHandler<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
  deps: ToolDeps,
): (args: z.infer<I>, ctx: ServerContext) => Promise<CallToolResult> {
  return async (args, ctx) => executeTool(def, toToolCtx(ctx, deps), deps, args);
}

// ============ Tool Definition ============

// WHY THIS EXISTS: The SDK exports fromJsonSchema(rawSchema) which creates a
// StandardSchemaWithJSON from a plain JSON Schema, but it validates at runtime using
// CfWorkerJsonSchemaValidator instead of Zod. We need Zod validation (for structured
// error messages) while serving a draft-2020-12 JSON Schema to clients. This function
// keeps Zod's ~standard.validate intact while replacing ~standard.jsonSchema with the
// precomputed draft-2020-12 schema. Remove when the SDK supports separate
// validate/publication schemas in registerTool.
function withJsonSchema<T extends z.ZodType>(
  schema: T,
  precomputedJsonSchema: Record<string, unknown>,
  io: 'input' | 'output',
): StandardSchemaWithJSON<z.infer<T>, z.infer<T>> {
  const standard = (schema as unknown as { '~standard': Record<string, unknown> })['~standard'];
  const compute = (options: { target: string }): Record<string, unknown> =>
    options.target === 'draft-2020-12'
      ? precomputedJsonSchema
      : z.toJSONSchema(schema, { target: options.target as never, io });
  return {
    '~standard': {
      ...standard,
      jsonSchema: {
        input: compute,
        output: compute,
      },
    },
  } as StandardSchemaWithJSON<z.infer<T>, z.infer<T>>;
}

export function defineTool<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
): DefinedTool {
  const inputJsonSchema = z.toJSONSchema(def.input, {
    target: 'draft-2020-12',
    io: 'input',
  }) as Record<string, unknown>;
  const outputJsonSchema = z.toJSONSchema(def.output, {
    target: 'draft-2020-12',
    io: 'output',
  }) as Record<string, unknown>;

  const inputSchemaWithJson = withJsonSchema(def.input, inputJsonSchema, 'input');
  const outputSchemaWithJson = withJsonSchema(def.output, outputJsonSchema, 'output');

  const tool: DefinedTool = {
    name: def.name,
    inputSchema: inputJsonSchema as Tool['inputSchema'],
    outputSchema: outputJsonSchema,

    register(deps: ToolDeps) {
      const toolDefShape = {
        title: def.title,
        description: def.description,
        inputSchema: inputSchemaWithJson,
        outputSchema: outputSchemaWithJson,
        annotations: def.annotations,
      };

      const serverCtxHandler = createServerToolHandler(def, deps);

      deps.server.registerTool(def.name, toolDefShape, serverCtxHandler);
    },
  };

  return tool;
}
