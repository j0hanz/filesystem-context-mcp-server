import * as fsp from 'node:fs/promises';
import readline from 'node:readline';

import type { ContentMatch } from '../../../config/types.js';
import { makeContext, pushContext, trimContent } from './scan-helpers.js';
import type { Matcher, ScanFileOptions, ScanFileResult } from './scan-types.js';

type BinaryDetector = (
  path: string,
  handle: fsp.FileHandle,
  signal?: AbortSignal
) => Promise<boolean>;

interface ScanLoopOptions {
  matcher: Matcher;
  options: ScanFileOptions;
  maxMatches: number;
  isCancelled: () => boolean;
  isProbablyBinary: BinaryDetector;
  signal?: AbortSignal;
}

function buildReadline(
  handle: fsp.FileHandle,
  signal?: AbortSignal
): readline.Interface {
  const baseOptions = {
    input: handle.createReadStream({ encoding: 'utf-8', autoClose: false }),
    crlfDelay: Infinity,
  };
  const options = signal ? { ...baseOptions, signal } : baseOptions;
  return readline.createInterface(options);
}

function updateContext(
  line: string,
  contextLines: number,
  ctx: ReturnType<typeof makeContext>
): string | undefined {
  if (contextLines <= 0) return undefined;
  const trimmedLine = trimContent(line);
  pushContext(ctx, trimmedLine, contextLines);
  return trimmedLine;
}

function appendMatch(
  matches: ContentMatch[],
  requestedPath: string,
  line: string,
  trimmedLine: string | undefined,
  lineNo: number,
  count: number,
  contextLines: number,
  ctx: ReturnType<typeof makeContext>
): void {
  const contextAfter = contextLines > 0 ? [] : undefined;
  matches.push({
    file: requestedPath,
    line: lineNo,
    content: trimmedLine ?? trimContent(line),
    contextBefore: contextLines > 0 ? [...ctx.before] : undefined,
    contextAfter,
    matchCount: count,
  });
  if (contextAfter) {
    ctx.pendingAfter.push({
      buffer: contextAfter,
      left: contextLines,
    });
  }
}

async function readMatches(
  handle: fsp.FileHandle,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  maxMatches: number,
  isCancelled: () => boolean,
  signal?: AbortSignal
): Promise<ContentMatch[]> {
  const rl = buildReadline(handle, signal);
  const ctx = makeContext();
  const matches: ContentMatch[] = [];
  let lineNo = 0;
  try {
    for await (const line of rl) {
      if (isCancelled()) break;
      lineNo++;

      const { contextLines } = options;
      const trimmedLine = updateContext(line, contextLines, ctx);
      const count = matcher(line);
      if (count > 0) {
        appendMatch(
          matches,
          requestedPath,
          line,
          trimmedLine,
          lineNo,
          count,
          contextLines,
          ctx
        );
      }

      if (matches.length >= maxMatches) break;
    }
    return matches;
  } finally {
    rl.close();
  }
}

async function scanWithHandle(
  handle: fsp.FileHandle,
  resolvedPath: string,
  requestedPath: string,
  options: ScanLoopOptions
): Promise<ScanFileResult> {
  const scanOptions = options.options;
  const stats = await handle.stat();

  if (stats.size > scanOptions.maxFileSize) {
    return {
      matches: [],
      matched: false,
      skippedTooLarge: true,
      skippedBinary: false,
    };
  }

  if (
    scanOptions.skipBinary &&
    (await options.isProbablyBinary(resolvedPath, handle, options.signal))
  ) {
    return {
      matches: [],
      matched: false,
      skippedTooLarge: false,
      skippedBinary: true,
    };
  }

  const matches = await readMatches(
    handle,
    requestedPath,
    options.matcher,
    scanOptions,
    options.maxMatches,
    options.isCancelled,
    options.signal
  );
  return {
    matches,
    matched: matches.length > 0,
    skippedTooLarge: false,
    skippedBinary: false,
  };
}

export async function scanFileWithMatcher(
  resolvedPath: string,
  requestedPath: string,
  options: ScanLoopOptions
): Promise<ScanFileResult> {
  const handle = await fsp.open(resolvedPath, 'r');

  try {
    return await scanWithHandle(handle, resolvedPath, requestedPath, options);
  } finally {
    await handle.close();
  }
}
