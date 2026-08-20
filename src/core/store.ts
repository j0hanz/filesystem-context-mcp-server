import { hash, randomUUID } from 'node:crypto';

import { ErrorCode, FsError } from './errors.js';
import { Logger } from './observability.js';

interface ResourceEntryBase {
  uri: string;
  name: string;
  mimeType: string;
  hash: string;
  size: number;
  storedAt: string;
  expiresAt: string;
}

interface TextResourceEntry extends ResourceEntryBase {
  text: string;
}

interface BlobResourceEntry extends ResourceEntryBase {
  data: Buffer;
}

export interface ResourceStore {
  putText(params: {
    name: string;
    mimeType?: string;
    text: string;
  }): TextResourceEntry & { kind: 'text' };
  getText(uri: string): TextResourceEntry & { kind: 'text' };
  putBlob(params: {
    name: string;
    mimeType: string;
    data: Buffer;
  }): BlobResourceEntry & { kind: 'blob' };
  getBlob(uri: string): BlobResourceEntry & { kind: 'blob' };
  getEntry(uri: string): StoredEntry;
  clear(): void;
  keys(): string[];
}

interface ResourceStoreOptions {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  entryTtlMs: number;
}

const DEFAULT_RESOURCE_STORE_OPTIONS: ResourceStoreOptions = {
  maxEntries: 64,
  maxTotalBytes: 25 * 1024 * 1024,
  maxEntryBytes: 10 * 1024 * 1024,
  entryTtlMs: 60 * 1000, // 60 seconds — anti-leak window
};

type StoredEntry = (TextResourceEntry & { kind: 'text' }) | (BlobResourceEntry & { kind: 'blob' });

function estimateBytes(text: string | Buffer): number {
  if (Buffer.isBuffer(text)) {
    return text.length;
  }
  return Buffer.byteLength(text, 'utf8');
}

function computeSha256(data: string | Buffer): string {
  return hash('sha256', data, 'hex');
}

function buildIndexKey(mimeType: string, contentHash: string): string {
  return `${mimeType}:${contentHash}`;
}

function isExpired(entry: TextResourceEntry | BlobResourceEntry, now = Date.now()): boolean {
  const expiresAt = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expiresAt)) return true;
  return expiresAt <= now;
}

// -----------------------------------------------------------------------------
// ResourceStore implementation — storage + eviction + TTL in one class
// -----------------------------------------------------------------------------

class InMemoryResourceStore implements ResourceStore {
  private readonly byUri = new Map<string, StoredEntry>();
  private readonly byHashIndex = new Map<string, string>();
  private _totalBytes = 0;
  private readonly options: ResourceStoreOptions;

  constructor(options: ResourceStoreOptions) {
    this.options = options;
  }

  // ── low-level storage ────────────────────────────────────────────────────

  private getEntryByHash(mimeType: string, contentHash: string): StoredEntry | undefined {
    const indexKey = buildIndexKey(mimeType, contentHash);
    const existingUri = this.byHashIndex.get(indexKey);
    return existingUri ? this.byUri.get(existingUri) : undefined;
  }

  private bumpLru(uri: string, entry: StoredEntry): void {
    if (!this.byUri.has(uri)) return;
    this.byUri.delete(uri);
    this.byUri.set(uri, entry);
  }

  private removeEntry(uri: string): StoredEntry | undefined {
    const existing = this.byUri.get(uri);
    if (!existing) return undefined;
    this._totalBytes -= existing.size;
    this.byUri.delete(uri);
    const indexKey = buildIndexKey(existing.mimeType, existing.hash);
    if (this.byHashIndex.get(indexKey) === uri) {
      this.byHashIndex.delete(indexKey);
      // Restore index mapping to another valid entry with the same hash and mimeType if one exists
      for (const [otherUri, otherEntry] of this.byUri.entries()) {
        if (otherEntry.mimeType === existing.mimeType && otherEntry.hash === existing.hash) {
          if (!isExpired(otherEntry)) {
            this.byHashIndex.set(indexKey, otherUri);
            break;
          }
        }
      }
    }
    return existing;
  }

  private rawPut(
    params: { name: string; mimeType: string; data: string | Buffer },
    createFn: (base: Omit<TextResourceEntry | BlobResourceEntry, 'text' | 'data'>) => StoredEntry,
  ): StoredEntry {
    const contentHash = computeSha256(params.data);
    const entryBytes = estimateBytes(params.data);
    const uri = `filesystem-mcp://result/${randomUUID()}`;
    const storedAt = new Date();
    const entry = createFn({
      uri,
      name: params.name,
      mimeType: params.mimeType,
      hash: contentHash,
      size: entryBytes,
      storedAt: storedAt.toISOString(),
      expiresAt: new Date(storedAt.getTime() + this.options.entryTtlMs).toISOString(),
    });

    this.byUri.set(uri, entry);
    this.byHashIndex.set(buildIndexKey(params.mimeType, contentHash), uri);
    this._totalBytes += entryBytes;
    return entry;
  }

  // ── eviction & cache policy ──────────────────────────────────────────────

  private evictOldest(): void {
    const first = this.byUri.values().next();
    if (first.done) return;
    this.removeEntry(first.value.uri);
  }

  private pruneExpiredEntries(now = Date.now()): void {
    const toRemove: string[] = [];
    for (const entry of this.byUri.values()) {
      if (isExpired(entry, now)) toRemove.push(entry.uri);
    }
    for (const uri of toRemove) {
      this.removeEntry(uri);
    }
  }

  private enforceLimits(): void {
    while (this.byUri.size > this.options.maxEntries) this.evictOldest();
    while (this._totalBytes > this.options.maxTotalBytes) {
      if (this.byUri.size === 0) {
        Logger.error(
          `[resource-store] enforceLimits invariant violation: totalBytes=${this._totalBytes} but entryCount=0`,
        );
        break;
      }
      this.evictOldest();
    }
  }

  private getExisting(uri: string, expectedKind?: 'text' | 'blob'): StoredEntry {
    const existing = this.byUri.get(uri);

    if (!existing) {
      throw new FsError(
        ErrorCode.NOT_FOUND,
        `Resource not found: ${uri}. Re-run the tool to regenerate.`,
      );
    }

    if (isExpired(existing)) {
      this.removeEntry(uri);
      throw new FsError(
        ErrorCode.NOT_FOUND,
        `Resource expired: ${uri}. Re-run the tool to regenerate.`,
      );
    }

    if (expectedKind && existing.kind !== expectedKind) {
      throw new FsError(
        ErrorCode.NOT_FOUND,
        `Resource not found: ${uri}. Re-run the tool to regenerate.`,
      );
    }

    this.bumpLru(uri, existing);
    return existing;
  }

  private checkBeforePut(data: string | Buffer): void {
    this.pruneExpiredEntries();
    const entryBytes = estimateBytes(data);
    if (entryBytes > this.options.maxEntryBytes) {
      throw new FsError(ErrorCode.TOO_LARGE, `Resource too large to cache (${entryBytes} bytes).`);
    }
  }

  private tryReturnHashHit(
    kind: 'text' | 'blob',
    mimeType: string,
    data: string | Buffer,
    name: string,
  ): StoredEntry | undefined {
    const contentHash = computeSha256(data);
    const cached = this.getEntryByHash(mimeType, contentHash);
    if (cached !== undefined) {
      if (isExpired(cached)) {
        this.removeEntry(cached.uri);
      } else if (cached.kind === kind) {
        const now = Date.now();
        const refreshed: StoredEntry = {
          ...cached,
          name,
          storedAt: new Date(now).toISOString(),
          expiresAt: new Date(now + this.options.entryTtlMs).toISOString(),
        };
        this.bumpLru(refreshed.uri, refreshed);
        return refreshed;
      } else {
        // Kind mismatch: remove orphan so rawPut can safely take over the byHashIndex slot.
        this.removeEntry(cached.uri);
      }
    }
    return undefined;
  }

  private enforceAfterPut(entry: StoredEntry): void {
    this.enforceLimits();
    if (!this.byUri.has(entry.uri)) {
      throw new FsError(ErrorCode.TOO_LARGE, 'Cache full: entry evicted.');
    }
  }

  // ── public ResourceStore ─────────────────────────────────────────────────

  putText(params: { name: string; mimeType?: string; text: string }): TextResourceEntry & {
    kind: 'text';
  } {
    this.checkBeforePut(params.text);
    const hit = this.tryReturnHashHit(
      'text',
      params.mimeType ?? 'text/plain',
      params.text,
      params.name,
    );
    if (hit) return hit as TextResourceEntry & { kind: 'text' };

    const entry = this.rawPut(
      { name: params.name, mimeType: params.mimeType ?? 'text/plain', data: params.text },
      (base) => ({ ...base, kind: 'text', text: params.text }),
    );
    this.enforceAfterPut(entry);
    return entry as TextResourceEntry & { kind: 'text' };
  }

  getText(uri: string): TextResourceEntry & { kind: 'text' } {
    return this.getExisting(uri, 'text') as TextResourceEntry & { kind: 'text' };
  }

  putBlob(params: {
    name: string;
    mimeType: string;
    data: Buffer;
  }): BlobResourceEntry & { kind: 'blob' } {
    this.checkBeforePut(params.data);
    const hit = this.tryReturnHashHit('blob', params.mimeType, params.data, params.name);
    if (hit) return hit as BlobResourceEntry & { kind: 'blob' };

    const entry = this.rawPut(
      { name: params.name, mimeType: params.mimeType, data: params.data },
      (base) => ({ ...base, kind: 'blob', data: params.data }),
    );
    this.enforceAfterPut(entry);
    return entry as BlobResourceEntry & { kind: 'blob' };
  }

  getBlob(uri: string): BlobResourceEntry & { kind: 'blob' } {
    return this.getExisting(uri, 'blob') as BlobResourceEntry & { kind: 'blob' };
  }

  getEntry(uri: string): StoredEntry {
    return this.getExisting(uri);
  }

  clear(): void {
    this.byUri.clear();
    this.byHashIndex.clear();
    this._totalBytes = 0;
  }

  /**
   * Returns live URIs currently in the store.
   * Side effect: prunes expired entries before returning.
   */
  keys(): string[] {
    this.pruneExpiredEntries();
    return Array.from(this.byUri.keys());
  }
}

export function createInMemoryResourceStore(
  options: Partial<ResourceStoreOptions> = {},
): ResourceStore {
  const resolved = { ...DEFAULT_RESOURCE_STORE_OPTIONS, ...options };
  if (resolved.maxEntryBytes > resolved.maxTotalBytes) {
    throw new Error(
      `Invalid store options: maxEntryBytes (${resolved.maxEntryBytes}) must not exceed maxTotalBytes (${resolved.maxTotalBytes}).`,
    );
  }
  return new InMemoryResourceStore(resolved);
}
