import type { ContentMatch } from '../../../config/types.js';

interface PendingMatch {
  match: ContentMatch;
  afterNeeded: number;
}

export class ContextManager {
  private readonly contextLines: number;
  private readonly buffer: string[] = [];
  private bufferStart = 0;
  private readonly pendingMatches: PendingMatch[] = [];
  private pendingStart = 0;

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
    matchCount: number,
    excludeCurrentLine = false
  ): ContentMatch {
    const match: ContentMatch = {
      file: filePath,
      line,
      content,
      matchCount,
    };

    if (this.buffer.length > this.bufferStart) {
      const bufferEnd = excludeCurrentLine
        ? Math.max(this.bufferStart, this.buffer.length - 1)
        : this.buffer.length;
      if (bufferEnd > this.bufferStart) {
        match.contextBefore = this.buffer.slice(this.bufferStart, bufferEnd);
      }
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

  private hasCompletedMatch(): boolean {
    return (
      this.pendingStart < this.pendingMatches.length &&
      this.pendingMatches[this.pendingStart]?.afterNeeded === 0
    );
  }

  private shouldCompactPending(): boolean {
    return (
      this.pendingStart > 1024 &&
      this.pendingStart * 2 > this.pendingMatches.length
    );
  }

  private compactPending(): void {
    this.pendingMatches.splice(0, this.pendingStart);
    this.pendingStart = 0;
  }

  private appendPendingContext(line: string): void {
    for (let i = this.pendingStart; i < this.pendingMatches.length; i++) {
      const pending = this.pendingMatches[i];
      if (!pending) continue;
      if (pending.afterNeeded <= 0) continue;
      pending.match.contextAfter ??= [];
      pending.match.contextAfter.push(line);
      pending.afterNeeded--;
    }
  }

  private pruneCompletedMatches(): void {
    while (this.hasCompletedMatch()) {
      this.pendingStart++;
    }
    if (this.shouldCompactPending()) this.compactPending();
  }

  private addToBuffer(line: string): void {
    this.buffer.push(line);
    if (this.buffer.length - this.bufferStart > this.contextLines) {
      this.bufferStart++;
    }
    if (this.bufferStart > 1024 && this.bufferStart * 2 > this.buffer.length) {
      this.buffer.splice(0, this.bufferStart);
      this.bufferStart = 0;
    }
  }
}
