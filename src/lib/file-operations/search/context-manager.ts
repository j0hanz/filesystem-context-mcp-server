import type { ContentMatch } from '../../../config/types.js';

interface PendingMatch {
  match: ContentMatch;
  afterNeeded: number;
}

export class ContextManager {
  private readonly contextLines: number;
  private readonly buffer: string[] = [];
  private readonly pendingMatches: PendingMatch[] = [];

  constructor(contextLines: number) {
    this.contextLines = contextLines;
  }

  pushLine(line: string): void {
    if (this.contextLines <= 0) return;

    this.updatePendingMatches(line);
    this.addToBuffer(line);
  }

  createMatch(
    filePath: string,
    line: number,
    content: string,
    matchCount: number
  ): ContentMatch {
    const match: ContentMatch = {
      file: filePath,
      line,
      content,
      matchCount,
    };

    if (this.buffer.length > 0) {
      match.contextBefore = [...this.buffer];
    }

    if (this.contextLines > 0) {
      this.pendingMatches.push({ match, afterNeeded: this.contextLines });
    }

    return match;
  }

  private updatePendingMatches(line: string): void {
    this.appendPendingContext(line);
    this.pruneCompletedMatches();
  }

  private appendPendingContext(line: string): void {
    for (const pending of this.pendingMatches) {
      if (pending.afterNeeded <= 0) continue;
      pending.match.contextAfter ??= [];
      pending.match.contextAfter.push(line);
      pending.afterNeeded--;
    }
  }

  private pruneCompletedMatches(): void {
    while (
      this.pendingMatches.length > 0 &&
      this.pendingMatches[0]?.afterNeeded === 0
    ) {
      this.pendingMatches.shift();
    }
  }

  private addToBuffer(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length > this.contextLines) {
      this.buffer.shift();
    }
  }
}
