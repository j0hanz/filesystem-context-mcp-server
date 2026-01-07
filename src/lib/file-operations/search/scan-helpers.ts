/**
 * Shared utilities for file content scanning.
 *
 * These helpers are used by both main-thread (scan-file.ts) and
 * worker-thread (worker-scan.ts) scanning implementations.
 */
import { MAX_LINE_CONTENT_LENGTH } from '../../constants.js';

/**
 * Pending context lines to be added after a match.
 */
export interface PendingAfter {
  buffer: string[];
  left: number;
}

/**
 * State for managing before/after context lines around matches.
 */
export interface ContextState {
  before: string[];
  pendingAfter: PendingAfter[];
}

/**
 * Create a fresh context state for tracking match context.
 */
export function makeContext(): ContextState {
  return { before: [], pendingAfter: [] };
}

/**
 * Push a line into context buffers.
 *
 * - Adds to "before" ring buffer (capped at max)
 * - Fills pending "after" buffers for recent matches
 * - Cleans up completed "after" buffers
 *
 * @param ctx - Context state to update
 * @param line - Line content to add
 * @param max - Maximum context lines to keep
 */
export function pushContext(
  ctx: ContextState,
  line: string,
  max: number
): void {
  if (max <= 0) return;

  // Update before context (ring buffer)
  ctx.before.push(line);
  if (ctx.before.length > max) ctx.before.shift();

  // Update pending after context for previous matches
  for (const pending of ctx.pendingAfter) {
    if (pending.left <= 0) continue;
    pending.buffer.push(line);
    pending.left -= 1;
  }

  // Clean up completed pending buffers
  while (ctx.pendingAfter.length > 0 && ctx.pendingAfter[0]?.left === 0) {
    ctx.pendingAfter.shift();
  }
}

/**
 * Trim line content for output.
 *
 * - Removes trailing whitespace
 * - Truncates to MAX_LINE_CONTENT_LENGTH
 *
 * @param line - Raw line content
 * @returns Trimmed line content
 */
export function trimContent(line: string): string {
  return line.trimEnd().slice(0, MAX_LINE_CONTENT_LENGTH);
}
