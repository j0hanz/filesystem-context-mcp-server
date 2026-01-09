import * as fsp from 'node:fs/promises';
import readline from 'node:readline';

import type { ContentMatch } from '../../../config/types.js';
import { assertNotAborted, withAbort } from '../../fs-helpers/abort.js';
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
  const contextBefore =
    contextLines > 0 ? ([...ctx.before] as readonly string[]) : undefined;
  const contextAfterBuffer = contextLines > 0 ? [] : undefined;
  const match: ContentMatch = {
    file: requestedPath,
    line: lineNo,
    content: trimmedLine ?? trimContent(line),
    matchCount: count,
    ...(contextBefore ? { contextBefore } : {}),
    ...(contextAfterBuffer ? { contextAfter: contextAfterBuffer } : {}),
  };
  matches.push(match);
  if (contextAfterBuffer) {
    ctx.pendingAfter.push({
      buffer: contextAfterBuffer,
      left: contextLines,
    });
  }
}

function recordLineMatch(
  line: string,
  matcher: Matcher,
  options: ScanFileOptions,
  requestedPath: string,
  lineNo: number,
  matches: ContentMatch[],
  ctx: ReturnType<typeof makeContext>
): void {
  const trimmedLine = updateContext(line, options.contextLines, ctx);
  const count = matcher(line);
  if (count > 0) {
    appendMatch(
      matches,
      requestedPath,
      line,
      trimmedLine,
      lineNo,
      count,
      options.contextLines,
      ctx
    );
  }
}

async function readLoop(
  rl: readline.Interface,
  matcher: Matcher,
  options: ScanFileOptions,
  requestedPath: string,
  maxMatches: number,
  isCancelled: () => boolean,
  matches: ContentMatch[],
  ctx: ReturnType<typeof makeContext>
): Promise<void> {
  let lineNo = 0;
  for await (const line of rl) {
    if (isCancelled()) break;
    lineNo++;
    recordLineMatch(
      line,
      matcher,
      options,
      requestedPath,
      lineNo,
      matches,
      ctx
    );
    if (matches.length >= maxMatches) break;
  }
}

function buildSkipResult(
  skippedTooLarge: boolean,
  skippedBinary: boolean
): ScanFileResult {
  return {
    matches: [],
    matched: false,
    skippedTooLarge,
    skippedBinary,
  };
}

function buildMatchResult(matches: ContentMatch[]): ScanFileResult {
  return {
    matches,
    matched: matches.length > 0,
    skippedTooLarge: false,
    skippedBinary: false,
  };
}

async function shouldSkipBinary(
  scanOptions: ScanFileOptions,
  resolvedPath: string,
  handle: fsp.FileHandle,
  options: ScanLoopOptions
): Promise<boolean> {
  return (
    scanOptions.skipBinary &&
    (await options.isProbablyBinary(resolvedPath, handle, options.signal))
  );
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
  try {
    await readLoop(
      rl,
      matcher,
      options,
      requestedPath,
      maxMatches,
      isCancelled,
      matches,
      ctx
    );
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
  const stats = await withAbort(handle.stat(), options.signal);

  if (stats.size > scanOptions.maxFileSize) {
    return buildSkipResult(true, false);
  }

  if (await shouldSkipBinary(scanOptions, resolvedPath, handle, options)) {
    return buildSkipResult(false, true);
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
  return buildMatchResult(matches);
}

export async function scanFileWithMatcher(
  resolvedPath: string,
  requestedPath: string,
  options: ScanLoopOptions
): Promise<ScanFileResult> {
  assertNotAborted(options.signal);
  const handle = await withAbort(fsp.open(resolvedPath, 'r'), options.signal);

  try {
    return await scanWithHandle(handle, resolvedPath, requestedPath, options);
  } finally {
    await handle.close();
  }
}
