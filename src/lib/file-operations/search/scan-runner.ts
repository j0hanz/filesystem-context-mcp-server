import * as fsp from 'node:fs/promises';
import readline from 'node:readline';

import type { ContentMatch } from '../../../config/types.js';
import { makeContext, pushContext, trimContent } from './scan-helpers.js';
import type { Matcher, ScanFileOptions, ScanFileResult } from './scan-types.js';

export type BinaryDetector = (
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
  const trimmedLine = contextLines > 0 ? trimContent(line) : undefined;
  if (trimmedLine !== undefined) {
    pushContext(ctx, trimmedLine, contextLines);
  }
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
  matches.push(
    buildMatch(
      requestedPath,
      line,
      trimmedLine,
      lineNo,
      count,
      contextLines,
      ctx
    )
  );
}

function buildMatch(
  requestedPath: string,
  line: string,
  trimmedLine: string | undefined,
  lineNo: number,
  count: number,
  contextLines: number,
  ctx: ReturnType<typeof makeContext>
): ContentMatch {
  const contextAfter = contextLines > 0 ? [] : undefined;
  const match: ContentMatch = {
    file: requestedPath,
    line: lineNo,
    content: trimmedLine ?? trimContent(line),
    contextBefore: contextLines > 0 ? [...ctx.before] : undefined,
    contextAfter,
    matchCount: count,
  };
  if (contextAfter) {
    ctx.pendingAfter.push({
      buffer: contextAfter,
      left: contextLines,
    });
  }
  return match;
}

function handleLine(
  line: string,
  lineNo: number,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  ctx: ReturnType<typeof makeContext>,
  matches: ContentMatch[]
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

async function scanLines(
  rl: readline.Interface,
  requestedPath: string,
  matcher: Matcher,
  options: ScanFileOptions,
  maxMatches: number,
  isCancelled: () => boolean
): Promise<ContentMatch[]> {
  const ctx = makeContext();
  const matches: ContentMatch[] = [];
  let lineNo = 0;

  for await (const line of rl) {
    if (isCancelled()) break;
    lineNo++;
    handleLine(line, lineNo, requestedPath, matcher, options, ctx, matches);

    if (matches.length >= maxMatches) {
      break;
    }
  }

  return matches;
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
  try {
    return await scanLines(
      rl,
      requestedPath,
      matcher,
      options,
      maxMatches,
      isCancelled
    );
  } finally {
    rl.close();
  }
}

async function shouldSkipBinaryFile(
  resolvedPath: string,
  handle: fsp.FileHandle,
  options: ScanLoopOptions
): Promise<boolean> {
  if (!options.options.skipBinary) return false;
  return await options.isProbablyBinary(resolvedPath, handle, options.signal);
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
    return buildSkipResult(true, false);
  }

  if (await shouldSkipBinaryFile(resolvedPath, handle, options)) {
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
  const handle = await fsp.open(resolvedPath, 'r');

  try {
    return await scanWithHandle(handle, resolvedPath, requestedPath, options);
  } finally {
    await handle.close();
  }
}
