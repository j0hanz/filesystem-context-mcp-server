import * as fsPromises from 'node:fs/promises';
import * as readline from 'node:readline';
import type { ReadStream } from 'node:fs';

import type { ContentMatch } from '../../../config/types.js';
import { MAX_LINE_CONTENT_LENGTH } from '../../constants.js';
import { isProbablyBinary } from '../../fs-helpers.js';
import { validateExistingPathDetailed } from '../../path-validation.js';
import { ContextManager } from './context-manager.js';
import type { MatchStrategy } from './match-strategy.js';
import type { ScanResult, SearchOptions } from './types.js';

export class FileProcessor {
  private readonly strategy: MatchStrategy;
  private readonly options: SearchOptions;

  constructor(strategy: MatchStrategy, options: SearchOptions) {
    this.strategy = strategy;
    this.options = options;
  }

  async processFile(rawPath: string): Promise<ScanResult> {
    const resolved = await this.resolvePath(rawPath);
    if (!resolved) {
      return this.createEmptyResult({ scanned: false }); // Inaccessible
    }

    const handle = await fsPromises.open(resolved.openPath, 'r');
    try {
      return await this.scanWithHandle(
        handle,
        resolved.openPath,
        resolved.displayPath
      );
    } finally {
      await handle.close().catch(() => {});
    }
  }

  private async resolvePath(
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

  private async scanWithHandle(
    handle: fsPromises.FileHandle,
    openPath: string,
    displayPath: string
  ): Promise<ScanResult> {
    const stats = await handle.stat();
    if (stats.size > this.options.maxFileSize) {
      return this.createEmptyResult({ scanned: true, skippedTooLarge: true });
    }

    if (this.options.skipBinary && (await isProbablyBinary(openPath, handle))) {
      return this.createEmptyResult({ scanned: true, skippedBinary: true });
    }

    return await this.scanContent(handle, displayPath);
  }

  private async scanContent(
    handle: fsPromises.FileHandle,
    displayPath: string
  ): Promise<ScanResult> {
    const contextManager = new ContextManager(this.options.contextLines);
    const matches: ContentMatch[] = [];
    let linesSkipped = 0;
    let lineNumber = 0;

    const { rl, stream } = this.createReadInterface(handle);

    try {
      for await (const line of rl) {
        lineNumber++;

        if (this.shouldStop(matches.length)) break;

        const trimmed = this.trimLine(line);
        contextManager.pushLine(trimmed);

        const matchCount = this.strategy.countMatches(line);

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

  private createReadInterface(handle: fsPromises.FileHandle): {
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

  private trimLine(line: string): string {
    return line.trimEnd().substring(0, MAX_LINE_CONTENT_LENGTH);
  }

  private shouldStop(currentFileMatches: number): boolean {
    if (this.options.deadlineMs && Date.now() > this.options.deadlineMs) {
      return true;
    }
    if (
      this.options.currentMatchCount + currentFileMatches >=
      this.options.maxResults
    ) {
      return true;
    }
    return false;
  }

  private createEmptyResult(overrides: Partial<ScanResult>): ScanResult {
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
}
