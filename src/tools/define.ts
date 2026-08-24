import type {
  CallToolResult,
  ContentBlock,
  InputRequiredResult,
  McpServer,
  Notification,
  RegisteredTool,
  RequestMeta,
  RequestStateAccessor,
  ServerContext,
  StandardSchemaWithJSON,
  Tool,
  ToolAnnotations,
  ToolExecution,
} from '@modelcontextprotocol/server';
import { isInputRequiredResult } from '@modelcontextprotocol/server';

import * as z from 'zod/v4';

import { ErrorCode, formatUnknownErrorMessage, Problem } from '../core/errors.js';
import type { ProgressCtx } from '../core/fmt.js';
import { plainMessage } from '../core/fmt.js';
import { GuardedFileSystem } from '../core/fs.js';
import { confirmInput, pendingRoundTrip, readAcceptedConfirm } from '../core/input-required.js';
import { Logger } from '../core/observability.js';
import type { LoggingLevel } from '../core/observability.js';
import type { PathGuard } from '../core/path.js';
import type { IconInfo } from '../core/primitives.js';
import { withDefaultIcons } from '../core/primitives.js';
import type { ResourceStore } from '../core/store.js';
import type { ServerNotifier } from '../server.js';
import type { ProgressSink } from './progress.js';
import { McpProgressSink, ProgressSession, StderrProgressSink } from './progress.js';

export interface ToolCtx {
  readonly signal: AbortSignal;
  readonly sessionId?: string;
  readonly _meta?: RequestMeta | undefined;
  readonly fs: GuardedFileSystem;
  readonly resourceStore: ResourceStore | undefined;
  readonly log?: (level: LoggingLevel, data: unknown, logger?: string) => void;
  readonly sendNotification?: (notification: Notification) => Promise<void>;
  readonly onProgress?: (params: { current: number; total?: number }) => void;
  /**
   * Multi-round-trip `inputResponses` carried by a retried `tools/call`
   * (protocol revision 2026-07-28); `undefined` on the first round. Bare,
   * unvalidated client values — handlers read them through
   * `readAcceptedConfirm`.
   */
  readonly inputResponses?: Record<string, unknown> | undefined;
  /**
   * Reads the verified multi-round-trip `requestState` for the current round:
   * the decoded `PendingState` the `requestStateCodec` verified, or `undefined`
   * when the round carried no state (the first round). `undefined` when no
   * live request context is available.
   */
  readonly requestState?: RequestStateAccessor | undefined;
  readonly server?: McpServer;
  readonly notifier?: ServerNotifier | undefined;
}

interface ToolDeps {
  readonly server: McpServer;
  readonly pathGuard: PathGuard;
  readonly resourceStore: ResourceStore | undefined;
  readonly iconInfo?: IconInfo | undefined;
  readonly notifier?: ServerNotifier | undefined;
}

interface RunResult<T> {
  readonly structured: T;
  readonly text?: string;
  readonly resources?: ContentBlock[];
}

/**
 * `ToolAnnotations` with `readOnlyHint` required. It is optional in the SDK, but
 * MUTATING_TOOL_NAMES derives the `--read-only` gate from it, so a tool that
 * forgets it must be a compile error rather than a silent reclassification.
 */
type DeclaredAnnotations = ToolAnnotations & { readonly readOnlyHint: boolean };

export interface ToolDef<I extends z.ZodType, O extends z.ZodType> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly input: I;
  readonly buildInput?: (guard: PathGuard) => I;
  readonly output: O;
  readonly annotations: DeclaredAnnotations;
  readonly execution?: ToolExecution;
  readonly timeoutMs?: number;
  readonly progress?: (args: z.infer<I>) => ProgressCtx;
  readonly progressDone?: (args: z.infer<I>, result: z.infer<O>) => Partial<ProgressCtx>;
  readonly defaultErrorCode?: ErrorCode;
  /**
   * The filesystem paths this tool will operate on, extracted from its parsed
   * args. The executor runs an access-grant pre-check over these BEFORE `run`
   * (R7): any path outside the granted roots yields an `input_required`
   * round-trip requesting a grant, and nothing is touched until the client
   * retries with an accepted grant (R8). Omit for tools that do not operate on
   * caller-supplied filesystem paths.
   */
  readonly accessPaths?: (args: z.infer<I>) => readonly string[];
  readonly run: (
    args: z.infer<I>,
    ctx: ToolCtx,
  ) => Promise<RunResult<z.infer<O>> | InputRequiredResult>;
}

export interface DefinedTool {
  readonly name: string;
  readonly annotations: DeclaredAnnotations;
  readonly execution?: ToolExecution;
  readonly inputSchema: Tool['inputSchema'];
  readonly outputSchema: Record<string, unknown>;

  register(deps: ToolDeps): RegisteredTool;
}

function toToolCtx(
  ctx: ServerContext | undefined,
  deps: Pick<ToolDeps, 'pathGuard' | 'resourceStore' | 'server' | 'notifier'>,
): ToolCtx {
  if (!ctx) {
    const signal = new AbortController().signal;
    return {
      signal,
      fs: new GuardedFileSystem(deps.pathGuard),
      resourceStore: deps.resourceStore,
      server: deps.server,
      ...(deps.notifier ? { notifier: deps.notifier } : {}),
    };
  }
  return {
    signal: ctx.mcpReq.signal,
    ...(ctx.sessionId ? { sessionId: ctx.sessionId } : {}),
    ...(ctx.mcpReq._meta ? { _meta: ctx.mcpReq._meta } : {}),
    fs: new GuardedFileSystem(deps.pathGuard),
    resourceStore: deps.resourceStore,
    sendNotification: async (notification) => ctx.mcpReq.notify(notification),
    inputResponses: ctx.mcpReq.inputResponses,
    requestState: ctx.mcpReq.requestState,
    server: deps.server,
    ...(deps.notifier ? { notifier: deps.notifier } : {}),
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
    fs: ctx.fs,
    resourceStore: ctx.resourceStore,
    ...(ctx.server ? { server: ctx.server } : {}),
    ...(ctx.notifier ? { notifier: ctx.notifier } : {}),
    log: (level: LoggingLevel, data: unknown, logger?: string) => {
      const msg = typeof data === 'string' ? data : String(data);
      const prefix = logger ? `[${logger}] ` : '';
      Logger.emit(level, `${prefix}${msg}`);
    },
    ...(ctx.sendNotification ? { sendNotification: ctx.sendNotification } : {}),
    onProgress,
    inputResponses: ctx.inputResponses,
    requestState: ctx.requestState,
  };
}

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
    this.#stderrSink.updateCtx(doneCtx);
    await this.#closeWithDone(plainMessage('done', doneCtx));
  }

  private async failProgress(error: unknown): Promise<{ isError: true; content: ContentBlock[] }> {
    const errMsg = formatUnknownErrorMessage(error);
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

  /**
   * Access-grant pre-check (R7/R8/R9). Before `run` touches the filesystem,
   * ask PathGuard which of the tool's declared paths are out-of-root and
   * grantable. If any are and this round carries no verified `requestState`,
   * return `input_required` (nothing is read or written — R7). On retry, the
   * verified state must bind this grant set (R9); apply each accepted grant for
   * the session (R8) and proceed. A declined or ungrantable path is left for
   * `validateAccess` to fail closed during the operation. Returns `undefined`
   * when no round-trip is needed and any applicable grants have been applied.
   */
  private async precheckGrant(): Promise<InputRequiredResult | undefined> {
    const extract = this.def.accessPaths;
    if (!extract) return undefined;
    const paths = extract(this.parsedArgs);
    if (paths.length === 0) return undefined;
    const grantDirs = await this.toolCtx.fs.pathGuard.precheckAccess(paths);
    if (grantDirs.length === 0) return undefined;

    const round = await pendingRoundTrip({
      op: 'grant',
      pending: grantDirs,
      requestState: this.toolCtx.requestState,
      buildInputs: (dirs) =>
        dirs.map((dir, i) => confirmInput(`confirm_${i}`, `Grant filesystem access to "${dir}"?`)),
    });
    if (round !== undefined) return round;
    // Apply accepted grants for the session (R8). Declined/missing dirs are
    // skipped here; their paths fail with ACCESS_DENIED during the operation.
    let appliedAny = false;
    for (let i = 0; i < grantDirs.length; i++) {
      const dir = grantDirs[i];
      if (dir && readAcceptedConfirm(this.toolCtx.inputResponses, `confirm_${i}`)) {
        await this.toolCtx.fs.pathGuard.applyGrant(dir);
        appliedAny = true;
      }
    }
    if (appliedAny) {
      if (this.toolCtx.notifier?.resourcesChanged) {
        try {
          this.toolCtx.notifier.resourcesChanged();
        } catch (err) {
          Logger.debug('notifier.resourcesChanged error on grant', { error: String(err) });
        }
      } else {
        try {
          await this.toolCtx.server?.server.sendResourceListChanged();
        } catch (err) {
          Logger.debug('sendResourceListChanged error on grant', { error: String(err) });
        }
      }
    }
    return undefined;
  }

  async execute(): Promise<CallToolResult | InputRequiredResult> {
    const runTool = async (): Promise<CallToolResult | InputRequiredResult> => {
      try {
        // Access-grant pre-check before any filesystem touch (R7/R8/R9). A
        // grant input_required short-circuits here (progress paused, not
        // finished); an R9 mismatch throws, which this catch surfaces as an
        // isError tool result like every other handler failure — not a raw
        // JSON-RPC error (GRANT-1 impact #2).
        const grantRequired = await this.precheckGrant();
        if (grantRequired !== undefined) return grantRequired;
        const result = await this.def.run(this.parsedArgs, this.toolCtx);
        // input_required is a return value, not a completed call: the client
        // retries the same tools/call carrying inputResponses, and this
        // handler re-enters from the top. Skip the progress "done" close and
        // return it verbatim — progress is paused, not finished.
        if (isInputRequiredResult(result)) {
          return result;
        }
        await this.completeProgress(result.structured);
        return buildSuccessResponse(result);
      } catch (error) {
        return await this.failProgress(error);
      } finally {
        await this.#flushProgress();
      }
    };

    return runTool();
  }
}

function createServerToolHandler<I extends z.ZodType, O extends z.ZodType>(
  def: ToolDef<I, O>,
  deps: ToolDeps,
): (args: z.infer<I>, ctx: ServerContext) => Promise<CallToolResult | InputRequiredResult> {
  return async (args, ctx) =>
    new ToolExecutor<I, O>(def.name, toToolCtx(ctx, deps), def, args).execute();
}

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
  const standard = (schema as unknown as { '~standard'?: Record<string, unknown> })['~standard'];
  const compute = (options: { target: string }): Record<string, unknown> =>
    options.target === 'draft-2020-12'
      ? precomputedJsonSchema
      : z.toJSONSchema(schema, { target: options.target as never, io });
  return {
    '~standard': {
      ...(standard ?? {}),
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

  const outputSchemaWithJson = withJsonSchema(def.output, outputJsonSchema, 'output');

  const tool: DefinedTool = {
    name: def.name,
    annotations: def.annotations,
    ...(def.execution !== undefined ? { execution: def.execution } : {}),
    inputSchema: inputJsonSchema as Tool['inputSchema'],
    outputSchema: outputJsonSchema,

    register(deps: ToolDeps): RegisteredTool {
      const resolvedInput = def.buildInput ? def.buildInput(deps.pathGuard) : def.input;
      const toolDefShape = withDefaultIcons(
        {
          title: def.title,
          description: def.description,
          inputSchema: withJsonSchema(resolvedInput, inputJsonSchema, 'input'),
          outputSchema: outputSchemaWithJson,
          annotations: def.annotations,
          ...(def.execution !== undefined ? { execution: def.execution } : {}),
        },
        deps.iconInfo,
      );

      const serverCtxHandler = createServerToolHandler(def, deps);

      return deps.server.registerTool(def.name, toolDefShape, serverCtxHandler);
    },
  };

  return tool;
}
