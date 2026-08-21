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

import { ErrorCode, FsError } from '../core/errors.js';
import { Logger } from '../core/observability.js';

/** The destructive operation a pending confirmation authorizes. */
export type PendingOp = 'delete' | 'move' | 'grant';

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

/** One embedded form-mode boolean confirmation, keyed within the call. */
export interface PendingInput {
  /** Server-assigned key, unique within the `tools/call`. */
  readonly key: string;
  /** Human-readable prompt for this item. */
  readonly message: string;
}

/**
 * HMAC key for the requestState codec. Read once from
 * `FILESYSTEM_MCP_REQUEST_STATE_KEY` (UTF-8, must be >=32 bytes); a random
 * 32-byte key is generated at boot when the env var is unset or too short. A
 * per-process key is correct here because one process serves every round of a
 * flow (stdio is single-process; HTTP runs a single node with
 * `InMemoryEventStore` — decision record 11). A server restart invalidates
 * in-flight tokens; the client re-requests, which is fail-closed and safe.
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
 * Build an `input_required` result carrying one boolean confirmation per pending
 * item, plus the integrity-protected `requestState` sealing the operation kind
 * and sorted target paths. `mint` is async (HMAC + base64url).
 */
export async function buildInputRequired(
  pending: PendingState,
  inputs: readonly PendingInput[],
): Promise<InputRequiredResult> {
  const inputRequests: Record<string, InputRequest> = {};
  for (const { key, message } of inputs) {
    inputRequests[key] = inputRequired.elicit({
      message,
      requestedSchema: {
        type: 'object',
        properties: { confirm: { type: 'boolean', title: 'Confirm' } },
        required: ['confirm'],
      },
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
