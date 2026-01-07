/**
 * Worker-safe file scanning function.
 *
 * This module provides a file scanning function that can be used within
 * worker threads. It doesn't rely on any shared state from the main thread.
 */
import * as fsp from 'node:fs/promises';
import readline from 'node:readline';

import type { ContentMatch } from '../../../config/types.js';
import type { Matcher, ScanFileOptions } from './scan-file.js';
import { makeContext, pushContext, trimContent } from './scan-helpers.js';

type BinaryDetector = (
  path: string,
  handle: fsp.FileHandle,
  signal?: AbortSignal
) => Promise<boolean>;

export interface WorkerScanResult {
  readonly matches: readonly ContentMatch[];
  readonly matched: boolean;
  readonly skippedTooLarge: boolean;
  readonly skippedBinary: boolean;
}

/**
 * Scans a file for content matches within a worker thread.
 *
 * This function is similar to scanFileResolved but designed for worker threads:
 * - Takes a cancellation check function instead of AbortSignal
 * - Takes binary detector as a parameter to avoid module-level state
 */
export async function scanFileInWorker(
  resolvedPath: string,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  maxMatches: number,
  isCancelled: () => boolean,
  isProbablyBinary: BinaryDetector
): Promise<WorkerScanResult> {
  const handle = await fsp.open(resolvedPath, 'r');

  try {
    const stats = await handle.stat();

    if (stats.size > options.maxFileSize) {
      return {
        matches: [],
        matched: false,
        skippedTooLarge: true,
        skippedBinary: false,
      };
    }

    if (options.skipBinary) {
      const binary = await isProbablyBinary(resolvedPath, handle);
      if (binary) {
        return {
          matches: [],
          matched: false,
          skippedTooLarge: false,
          skippedBinary: true,
        };
      }
    }

    const rl = readline.createInterface({
      input: handle.createReadStream({ encoding: 'utf-8', autoClose: false }),
      crlfDelay: Infinity,
    });

    const ctx = makeContext();
    const matches: ContentMatch[] = [];
    let lineNo = 0;

    try {
      for await (const line of rl) {
        // Check cancellation periodically
        if (isCancelled()) break;

        lineNo++;
        const trimmedLine =
          options.contextLines > 0 ? trimContent(line) : undefined;
        if (trimmedLine !== undefined) {
          pushContext(ctx, trimmedLine, options.contextLines);
        }

        const count = matcher(line);
        if (count > 0) {
          const contextAfter = options.contextLines > 0 ? [] : undefined;
          const match: ContentMatch = {
            file: requestedPath,
            line: lineNo,
            content: trimmedLine ?? trimContent(line),
            contextBefore:
              options.contextLines > 0 ? [...ctx.before] : undefined,
            contextAfter,
            matchCount: count,
          };
          matches.push(match);
          if (contextAfter) {
            ctx.pendingAfter.push({
              buffer: contextAfter,
              left: options.contextLines,
            });
          }
        }

        if (matches.length >= maxMatches) {
          break;
        }
      }
    } finally {
      rl.close();
    }

    return {
      matches,
      matched: matches.length > 0,
      skippedTooLarge: false,
      skippedBinary: false,
    };
  } finally {
    await handle.close();
  }
}
