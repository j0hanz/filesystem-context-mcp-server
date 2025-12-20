import fg from 'fast-glob';

import type { SearchContentResult } from '../../../config/types.js';
import {
  DEFAULT_MAX_RESULTS,
  DEFAULT_SEARCH_MAX_FILES,
  DEFAULT_SEARCH_TIMEOUT_MS,
  MAX_SEARCHABLE_FILE_SIZE,
  PARALLEL_CONCURRENCY,
} from '../../constants.js';
import { safeDestroy } from '../../fs-helpers.js';
import { validateExistingPath } from '../../path-validation.js';
import { validateGlobPatternOrThrow } from '../pattern-validator.js';
import { FileProcessor } from './file-processor.js';
import { createMatchStrategy } from './match-strategy.js';
import type { ScanResult, SearchState } from './types.js';

export class SearchEngine {
  private readonly basePath: string;
  private readonly options: {
    filePattern: string;
    excludePatterns: string[];
    caseSensitive: boolean;
    maxResults: number;
    maxFileSize: number;
    maxFilesScanned: number;
    timeoutMs: number;
    skipBinary: boolean;
    contextLines: number;
    wholeWord: boolean;
    isLiteral: boolean;
    includeHidden: boolean;
    baseNameMatch: boolean;
    caseSensitiveFileMatch: boolean;
  };

  constructor(
    basePath: string,
    options: Partial<{
      filePattern: string;
      excludePatterns: string[];
      caseSensitive: boolean;
      maxResults: number;
      maxFileSize: number;
      maxFilesScanned: number;
      timeoutMs: number;
      skipBinary: boolean;
      contextLines: number;
      wholeWord: boolean;
      isLiteral: boolean;
      includeHidden: boolean;
      baseNameMatch: boolean;
      caseSensitiveFileMatch: boolean;
    }>
  ) {
    this.basePath = basePath;
    this.options = {
      filePattern: options.filePattern ?? '**/*',
      excludePatterns: options.excludePatterns ?? [],
      caseSensitive: options.caseSensitive ?? false,
      maxResults: options.maxResults ?? DEFAULT_MAX_RESULTS,
      maxFileSize: options.maxFileSize ?? MAX_SEARCHABLE_FILE_SIZE,
      maxFilesScanned: options.maxFilesScanned ?? DEFAULT_SEARCH_MAX_FILES,
      timeoutMs: options.timeoutMs ?? DEFAULT_SEARCH_TIMEOUT_MS,
      skipBinary: options.skipBinary ?? true,
      contextLines: options.contextLines ?? 0,
      wholeWord: options.wholeWord ?? false,
      isLiteral: options.isLiteral ?? false,
      includeHidden: options.includeHidden ?? false,
      baseNameMatch: options.baseNameMatch ?? false,
      caseSensitiveFileMatch: options.caseSensitiveFileMatch ?? true,
    };
  }

  async search(searchPattern: string): Promise<SearchContentResult> {
    const validPath = await validateExistingPath(this.basePath);
    validateGlobPatternOrThrow(this.options.filePattern, validPath);

    const strategy = createMatchStrategy(searchPattern, {
      isLiteral: this.options.isLiteral,
      wholeWord: this.options.wholeWord,
      caseSensitive: this.options.caseSensitive,
      basePath: validPath,
    });

    const state = this.createInitialState();
    const deadlineMs = this.options.timeoutMs
      ? Date.now() + this.options.timeoutMs
      : undefined;

    const processor = new FileProcessor(strategy, {
      ...this.options,
      deadlineMs,
      currentMatchCount: 0,
      searchPattern,
    });

    const stream = this.createStream(validPath);
    const active = new Set<Promise<void>>();
    let inFlight = 0;

    try {
      for await (const entry of stream) {
        if (this.shouldStop(state, deadlineMs)) break;

        if (state.filesScanned + inFlight >= this.options.maxFilesScanned) {
          if (active.size > 0) {
            await Promise.race(active);
            continue;
          } else {
            break;
          }
        }

        while (active.size >= PARALLEL_CONCURRENCY) {
          await Promise.race(active);
        }

        const rawPath = String(entry);
        inFlight++;
        const p = (async (): Promise<void> => {
          try {
            if (this.shouldStop(state, deadlineMs)) return;
            const result = await processor.processFile(rawPath);
            this.updateState(state, result);
          } catch {
            state.skippedInaccessible++;
          } finally {
            inFlight--;
          }
        })();

        active.add(p);
        void p.finally(() => active.delete(p));
      }
      await Promise.all(active);
    } finally {
      safeDestroy(stream);
    }

    return this.buildResult(validPath, searchPattern, state);
  }

  private createInitialState(): SearchState {
    return {
      matches: [],
      filesScanned: 0,
      filesMatched: 0,
      skippedTooLarge: 0,
      skippedBinary: 0,
      skippedInaccessible: 0,
      linesSkippedDueToRegexTimeout: 0,
      truncated: false,
      stoppedReason: undefined,
    };
  }

  private createStream(basePath: string): AsyncIterable<string | Buffer> {
    return fg.stream(this.options.filePattern, {
      cwd: basePath,
      absolute: true,
      onlyFiles: true,
      dot: this.options.includeHidden,
      ignore: this.options.excludePatterns,
      suppressErrors: true,
      followSymbolicLinks: false,
      baseNameMatch: this.options.baseNameMatch,
      caseSensitiveMatch: this.options.caseSensitiveFileMatch,
    });
  }

  private shouldStop(state: SearchState, deadlineMs?: number): boolean {
    if (deadlineMs && Date.now() > deadlineMs) {
      state.truncated = true;
      state.stoppedReason = 'timeout';
      return true;
    }
    if (state.filesScanned >= this.options.maxFilesScanned) {
      state.truncated = true;
      state.stoppedReason = 'maxFiles';
      return true;
    }
    if (state.matches.length >= this.options.maxResults) {
      state.truncated = true;
      state.stoppedReason = 'maxResults';
      return true;
    }
    return false;
  }

  private updateState(state: SearchState, result: ScanResult): void {
    if (!result.scanned) {
      state.skippedInaccessible++;
      return;
    }

    state.filesScanned++;
    if (result.skippedTooLarge) state.skippedTooLarge++;
    if (result.skippedBinary) state.skippedBinary++;

    if (result.matches.length > 0) {
      state.matches.push(...result.matches);
      state.filesMatched++;
    }
    state.linesSkippedDueToRegexTimeout += result.linesSkippedDueToRegexTimeout;
  }

  private buildResult(
    basePath: string,
    pattern: string,
    state: SearchState
  ): SearchContentResult {
    let { matches } = state;
    if (matches.length > this.options.maxResults) {
      matches = matches.slice(0, this.options.maxResults);
      state.truncated = true;
      state.stoppedReason = 'maxResults';
    }

    return {
      basePath,
      pattern,
      filePattern: this.options.filePattern,
      matches,
      summary: {
        filesScanned: state.filesScanned,
        filesMatched: state.filesMatched,
        matches: matches.length,
        truncated: state.truncated,
        skippedTooLarge: state.skippedTooLarge,
        skippedBinary: state.skippedBinary,
        skippedInaccessible: state.skippedInaccessible,
        linesSkippedDueToRegexTimeout: state.linesSkippedDueToRegexTimeout,
        stoppedReason: state.stoppedReason,
      },
    };
  }
}
