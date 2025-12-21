import * as fsPromises from 'node:fs/promises';
import * as readline from 'node:readline';
import type { ReadStream } from 'node:fs';

import type { ContentMatch } from '../../../config/types.js';
import { MAX_LINE_CONTENT_LENGTH } from '../../constants.js';
import { isProbablyBinary } from '../../fs-helpers.js';
import { validateExistingPathDetailed } from '../../path-validation.js';
import { ContextManager } from './context-manager.js';
import type { Matcher } from './match-strategy.js';
import type { ScanResult, SearchOptions } from './types.js';

function createEmptyResult(overrides: Partial<ScanResult>): ScanResult {
  return {
    matches: [],
    linesSkippedDueToRegexTimeout: 0,
    fileHadMatches: false,
    skippedTooLarge: false,
    skippedBinary: false,
    scanned: false,
    ...overrides,
  };
}

async function resolvePath(
  rawPath: string
): Promise<{ openPath: string; displayPath: string } | null> {
  try {
    const validated = await validateExistingPathDetailed(rawPath);
    return {
      openPath: validated.resolvedPath,
      displayPath: validated.requestedPath,
    };
  } catch {
    return null;
  }
}

function createReadInterface(handle: fsPromises.FileHandle): {
  rl: readline.Interface;
  stream: ReadStream;
} {
  const stream = handle.createReadStream({
    encoding: 'utf-8',
    autoClose: false,
  });
  const rl = readline.createInterface({
    input: stream,
    crlfDelay: Infinity,
  });
  return { rl, stream };
}

function trimLine(line: string): string {
  return line.trimEnd().substring(0, MAX_LINE_CONTENT_LENGTH);
}

function shouldStop(
  currentFileMatches: number,
  options: SearchOptions
): boolean {
  if (options.deadlineMs && Date.now() > options.deadlineMs) {
    return true;
  }
  if (options.currentMatchCount + currentFileMatches >= options.maxResults) {
    return true;
  }
  return false;
}

async function scanContent(
  handle: fsPromises.FileHandle,
  displayPath: string,
  matcher: Matcher,
  options: SearchOptions
): Promise<ScanResult> {
  const contextManager = new ContextManager(options.contextLines);
  const matches: ContentMatch[] = [];
  let linesSkipped = 0;
  let lineNumber = 0;

  const { rl, stream } = createReadInterface(handle);

  try {
    for await (const line of rl) {
      lineNumber++;

      if (shouldStop(matches.length, options)) break;

      const trimmed = trimLine(line);
      contextManager.pushLine(trimmed);

      const matchCount = matcher(line);

      if (matchCount < 0) {
        linesSkipped++;
        continue;
      }

      if (matchCount > 0) {
        matches.push(
          contextManager.createMatch(
            displayPath,
            lineNumber,
            trimmed,
            matchCount
          )
        );
      }
    }
  } finally {
    rl.close();
    stream.destroy();
  }

  return {
    matches,
    linesSkippedDueToRegexTimeout: linesSkipped,
    fileHadMatches: matches.length > 0,
    skippedTooLarge: false,
    skippedBinary: false,
    scanned: true,
  };
}

async function scanWithHandle(
  handle: fsPromises.FileHandle,
  openPath: string,
  displayPath: string,
  matcher: Matcher,
  options: SearchOptions
): Promise<ScanResult> {
  const stats = await handle.stat();
  if (stats.size > options.maxFileSize) {
    return createEmptyResult({ scanned: true, skippedTooLarge: true });
  }

  if (options.skipBinary && (await isProbablyBinary(openPath, handle))) {
    return createEmptyResult({ scanned: true, skippedBinary: true });
  }

  return await scanContent(handle, displayPath, matcher, options);
}

export async function processFile(
  rawPath: string,
  matcher: Matcher,
  options: SearchOptions
): Promise<ScanResult> {
  const resolved = await resolvePath(rawPath);
  if (!resolved) {
    return createEmptyResult({ scanned: false }); // Inaccessible
  }

  const handle = await fsPromises.open(resolved.openPath, 'r');
  try {
    return await scanWithHandle(
      handle,
      resolved.openPath,
      resolved.displayPath,
      matcher,
      options
    );
  } finally {
    await handle.close().catch(() => {});
  }
}
