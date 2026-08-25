// Shared infrastructure for the SEP-2577 `input_required` multi-round-trip
// destructive-confirmation flows (recursive delete, move overwrite, out-of-root
// access grant). A handler returns `inputRequired(...)` instead of the deprecated
// push-style server-to-client elicitation request; the client retries the same
// `tools/call` carrying `inputResponses`, and the handler re-enters from the top
// reading the verified `requestState` and the accepted responses.
//
// `requestState` round-trips through the client (attacker-controlled on
// re-entry), so it is sealed with the SDK's HMAC-SHA256 codec. The payload binds
// each confirmation to its operation kind and sorted target-path set (spec R9,
// R10); the handler additionally rejects any retry whose decoded paths do not
// match the retried request's parameters (the codec only proves the state was
// not tampered — it cannot see the current args).
import type { InputRequest, InputRequiredResult } from '@modelcontextprotocol/server';
import {
  acceptedContent,
  createRequestStateCodec,
  inputRequired,
  inputResponse,
} from '@modelcontextprotocol/server';

import { randomBytes } from 'node:crypto';

import { ErrorCode, FsError } from './errors.js';
import { Logger } from './observability.js';

/** The destructive operation a pending confirmation authorizes. */
export type PendingOp = 'delete' | 'move' | 'copy' | 'grant';

/**
 * Integrity-protected state minted into an `input_required` result and echoed
 * back by the client on retry. `paths` is the sorted canonical set of target
 * paths the confirmation covers; the handler compares it to the retried
 * request's parameters and rejects a mismatch (R9).
 */
export interface PendingState {
  readonly op: PendingOp;
  readonly paths: readonly string[];
}

/** One embedded form-mode confirmation, keyed within the call. */
export interface PendingInput {
  /** Server-assigned key, unique within the `tools/call`. */
  readonly key: string;
  /** Human-readable prompt for this item. */
  readonly message: string;
  /**
   * When set, the form offers a titled single-select enum (`choice` field)
   * instead of a boolean `confirm`. Each entry is a `{ value, title }` pair.
   */
  readonly choices?: readonly { value: string; title: string }[];
  /** Preselected enum value (only meaningful with single-select `choices`). */
  readonly defaultValue?: string;
  /**
   * When set with `choices`, the form offers a multi-select enum: `choice` is
   * a string array (`MultiSelectEnumSchema` shape) and the caller reads the
   * accepted set with `readAcceptedMultiChoice`. Single-select otherwise.
   */
  readonly multi?: boolean;
}

/**
 * HMAC key for the requestState codec. Read once from
 * `FILESYSTEM_MCP_REQUEST_STATE_KEY` (UTF-8, must be >=32 bytes); a random
 * 32-byte key is generated at boot when the env var is unset or too short. A
 * per-process key is correct for stdio and the single-node HTTP leg (decision
 * record 11). For a multi-instance HTTP fleet behind a load balancer, a random
 * per-process key silently breaks any `input_required` round that lands on a
 * different instance — `assertFleetRequestStateKey()` is the boot-time HTTP
 * guard that refuses to start the HTTP leg in that state. It is NOT called at
 * module load (the codec is constructed at module scope, before the stdio/HTTP
 * decision in `main()`), so a stdio launch with `API_KEY` exported still boots.
 * A server restart invalidates in-flight tokens; the client re-requests, which
 * is fail-closed and safe.
 */
function resolveRequestStateKey(): Uint8Array {
  const env = process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'];
  if (env) {
    const bytes = Buffer.from(env, 'utf8');
    if (bytes.length >= 32) return bytes;
    Logger.warn(
      `FILESYSTEM_MCP_REQUEST_STATE_KEY is ${String(bytes.length)} bytes; 32 are required. Falling back to a random per-boot key — in-flight input_required rounds will not survive a restart.`,
    );
  }
  return randomBytes(32);
}

/**
 * Boot-time HTTP guard: when the HTTP leg is active (`API_KEY` set) and
 * `FILESYSTEM_MCP_REQUEST_STATE_KEY` is missing or <32 bytes, refuse to start —
 * a multi-instance fleet behind a load balancer would otherwise silently break
 * every `input_required` round that lands on a different instance (each node
 * mints tokens with its own random per-boot key). No-op when `API_KEY` is unset
 * (stdio / public HTTP) or when the env key is already strong. Called from
 * `startHttpServer`, never at module load.
 */
export function assertFleetRequestStateKey(): void {
  const apiKey = process.env['API_KEY'];
  if (!apiKey) return;
  const env = process.env['FILESYSTEM_MCP_REQUEST_STATE_KEY'];
  if (!env || Buffer.from(env, 'utf8').length < 32) {
    throw new Error(
      'FILESYSTEM_MCP_REQUEST_STATE_KEY must be >=32 bytes when API_KEY is set (multi-instance HTTP).',
    );
  }
}

/**
 * The codec: `mint` seals a `PendingState` into the opaque wire string a
 * handler returns from `inputRequired({ requestState })`; `verify` drops into
 * `ServerOptions.requestState.verify` and throws on tamper, expiry, or bind
 * mismatch (the seam answers with the frozen `-32602`).
 */
export const requestStateCodec = createRequestStateCodec<PendingState>({
  key: resolveRequestStateKey(),
});

/**
 * Build a boolean confirmation input for one pending item. The schema uses a
 * fixed `confirm` boolean field; the input request is keyed by `key` so a
 * batched call carries one request per item under a distinct key.
 */
export function confirmInput(key: string, message: string): PendingInput {
  return { key, message };
}

/**
 * Build a single-select enum confirmation input. The form renders a `choice`
 * field whose options are the titled `choices`; the caller reads the selection
 * with `readAcceptedChoice`. A `defaultValue` preselects one option.
 */
export function choiceInput(
  key: string,
  message: string,
  choices: readonly { value: string; title: string }[],
  defaultValue?: string,
): PendingInput {
  return { key, message, choices, ...(defaultValue !== undefined ? { defaultValue } : {}) };
}

/**
 * Build a multi-select enum confirmation input. Like `choiceInput` but the
 * form renders `choice` as a string array (`MultiSelectEnumSchema` shape), so
 * the client may accept a subset; the caller reads the accepted set with
 * `readAcceptedMultiChoice`.
 */
export function multiSelectInput(
  key: string,
  message: string,
  choices: readonly { value: string; title: string }[],
): PendingInput {
  return {
    key,
    message,
    choices,
    multi: true,
  };
}

/**
 * Build an `input_required` result carrying one boolean confirmation per pending
 * item, plus the integrity-protected `requestState` sealing the operation kind
 * and sorted target paths. `mint` is async (HMAC + base64url).
 */
export async function buildInputRequired(
  pending: PendingState,
  inputs: readonly PendingInput[],
): Promise<InputRequiredResult> {
  const inputRequests: Record<string, InputRequest> = {};
  for (const input of inputs) {
    const requestedSchema = input.choices
      ? input.multi
        ? {
            // Multi-select enum (matches MultiSelectEnumSchema): `choice` is a
            // string array; the client may accept a subset of the offered dirs.
            type: 'object' as const,
            properties: {
              choice: {
                type: 'array' as const,
                items: {
                  anyOf: input.choices.map((c) => ({ const: c.value, title: c.title })),
                },
              },
            },
            required: ['choice'],
          }
        : {
            type: 'object' as const,
            properties: {
              choice: {
                type: 'string' as const,
                oneOf: input.choices.map((c) => ({ const: c.value, title: c.title })),
                ...(input.defaultValue !== undefined ? { default: input.defaultValue } : {}),
              },
            },
            required: ['choice'],
          }
      : {
          type: 'object' as const,
          properties: { confirm: { type: 'boolean' as const, title: 'Confirm' } },
          required: ['confirm'],
        };
    inputRequests[input.key] = inputRequired.elicit({
      message: input.message,
      requestedSchema,
    });
  }
  const requestState = await requestStateCodec.mint({
    op: pending.op,
    paths: [...pending.paths].sort(),
  });
  return inputRequired({ inputRequests, requestState });
}

/**
 * The shared read-state → `buildInputRequired` → mismatch-throw flow used by
 * every destructive-confirmation handler (delete, move, grant). No verified
 * state, OR a verified state belonging to a different `op` (e.g. a chained
 * call's grant round already resolved and this is now that same call's own
 * delete/move confirmation round), mints a fresh `input_required` for this
 * op. A retry whose verified state matches this op but not the pending path
 * set throws `FsError(INVALID_INPUT)` (R9) — uniformly surfaced as an
 * `isError` tool result by the handler's catch. Returns `undefined` on a
 * matching same-op retry so the caller proceeds.
 *
 * One home for the R9 binding check means a future fix cannot miss two of three
 * sites. The caller supplies `buildInputs` so only the prompt text varies.
 */
export interface PendingRoundTripOpts {
  readonly op: PendingOp;
  readonly pending: readonly string[];
  readonly requestState: (() => PendingState | undefined) | undefined;
  readonly buildInputs: (pending: readonly string[]) => readonly PendingInput[];
}

export async function pendingRoundTrip(
  opts: PendingRoundTripOpts,
): Promise<InputRequiredResult | undefined> {
  const state = opts.requestState?.();
  // No verified state yet, OR the verified state belongs to a different
  // flow (e.g. an access-grant round's state is still the retried request's
  // requestState after the grant was applied, and this call is now the
  // destructive-confirmation round for the SAME tool call) — either way,
  // this op has not yet had its own round-trip, so mint a fresh
  // input_required rather than treating a foreign-but-valid state as a
  // tamper/mismatch error.
  if (state?.op !== opts.op) {
    return buildInputRequired({ op: opts.op, paths: opts.pending }, opts.buildInputs(opts.pending));
  }
  // Retry for THIS op (R9): the verified state must bind the same pending set.
  if (!pathsEqual(state.paths, opts.pending)) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      `${opts.op}: confirmation does not match the requested paths`,
    );
  }
  return undefined;
}

/**
 * Read one pending item's boolean confirmation from a retried request's
 * `inputResponses`. Returns `true` only when the client explicitly accepted AND
 * the `confirm` field is `true`; every other outcome (decline, cancel, missing
 * key, accept-without-confirm) returns `false`, which the caller reports as
 * `CANCELLED` (R3 proceed, R4/R5 cancelled).
 */
export function readAcceptedConfirm(
  responses: Record<string, unknown> | undefined,
  key: string,
): boolean {
  const view = inputResponse(responses, key);
  if (view.kind !== 'elicit' || view.action !== 'accept') return false;
  const content = acceptedContent<{ confirm?: boolean }>(responses, key);
  return content?.confirm === true;
}

/**
 * Read one pending item's enum selection from a retried request's
 * `inputResponses`. Returns the chosen `value` only when the client explicitly
 * accepted AND the `choice` field is a string; every other outcome (decline,
 * cancel, missing key, accept-without-choice) returns `undefined`, which the
 * caller reports as `CANCELLED` — same contract as the boolean reader.
 *
 * The returned value is NOT validated against the `choices` offered in the
 * request schema. Callers must compare against the expected values (e.g.
 * `choice === 'overwrite'`) before acting — never echo the string back into a
 * path or trust it as an enum member.
 */
export function readAcceptedChoice(
  responses: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const view = inputResponse(responses, key);
  if (view.kind !== 'elicit' || view.action !== 'accept') return undefined;
  const content = acceptedContent<{ choice?: string }>(responses, key);
  const choice = content?.choice;
  return typeof choice === 'string' ? choice : undefined;
}

/**
 * Read one pending item's multi-select enum selection from a retried request's
 * `inputResponses`. Returns the accepted `value`s only when the client
 * explicitly accepted AND `choice` is a string array of strings; every other
 * outcome (decline, cancel, missing key, accept-without-choice, non-array
 * `choice`, non-string elements) returns `undefined`, which the caller reports
 * as `CANCELLED` — same contract as the single-select reader.
 *
 * As with `readAcceptedChoice`, the returned values are NOT validated against
 * the offered `choices`; callers must compare against the expected set before
 * acting.
 */
export function readAcceptedMultiChoice(
  responses: Record<string, unknown> | undefined,
  key: string,
): string[] | undefined {
  const view = inputResponse(responses, key);
  if (view.kind !== 'elicit' || view.action !== 'accept') return undefined;
  const content = acceptedContent<{ choice?: unknown }>(responses, key);
  const choice = content?.choice;
  if (!Array.isArray(choice)) return undefined;
  if (!choice.every((el) => typeof el === 'string')) return undefined;
  return choice;
}

/**
 * Order-independent equality of two sorted, de-duplicated path lists. Used to
 * compare a recomputed pending set against the `requestState`-bound set (R9):
 * both are sorted by construction, so a straight element-wise compare settles
 * it without allocating.
 */
function pathsEqual(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}
