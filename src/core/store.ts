import type { ContentBlock } from '@modelcontextprotocol/server';

import { hash, randomUUID } from 'node:crypto';

import { ErrorCode, FsError } from './errors.js';
import { Logger } from './observability.js';
import { MIB } from './util.js';

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

export interface ResourceStoreOptions {
  maxEntries: number;
  maxTotalBytes: number;
  maxEntryBytes: number;
  entryTtlMs: number;
}

const DEFAULT_RESOURCE_STORE_OPTIONS: ResourceStoreOptions = {
  maxEntries: 64,
  maxTotalBytes: 25 * MIB,
  maxEntryBytes: 10 * MIB,
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

function isExpired(entry: TextResourceEntry | BlobResourceEntry, now = Date.now()): boolean {
  const expiresAt = Date.parse(entry.expiresAt);
  if (!Number.isFinite(expiresAt)) {
    return true;
  }
  return expiresAt <= now;
}

// -----------------------------------------------------------------------------
// ResourceStore implementation — storage + eviction + TTL in one class
// -----------------------------------------------------------------------------

function invalidStoreOptionsError(maxEntryBytes: number, maxTotalBytes: number): Error {
  return new Error(
    `Invalid store options: maxEntryBytes (${maxEntryBytes}) must not exceed maxTotalBytes (${maxTotalBytes}).`,
  );
}

export class ResourceStore {
  private readonly byUri = new Map<string, StoredEntry>();
  private _totalBytes = 0;
  private readonly options: ResourceStoreOptions;

  constructor(options: Partial<ResourceStoreOptions> = {}) {
    const resolved = { ...DEFAULT_RESOURCE_STORE_OPTIONS, ...options };
    if (resolved.maxEntryBytes > resolved.maxTotalBytes) {
      throw invalidStoreOptionsError(resolved.maxEntryBytes, resolved.maxTotalBytes);
    }
    this.options = resolved;
  }

  // ── low-level storage ────────────────────────────────────────────────────

  private bumpLru(uri: string, entry: StoredEntry): void {
    if (!this.byUri.has(uri)) {
      return;
    }
    this.byUri.delete(uri);
    this.byUri.set(uri, entry);
  }

  private removeEntry(uri: string): StoredEntry | undefined {
    const existing = this.byUri.get(uri);
    if (!existing) {
      return undefined;
    }
    this._totalBytes -= existing.size;
    this.byUri.delete(uri);
    return existing;
  }

  private rawPut<E extends StoredEntry>(
    params: { name: string; mimeType: string; contentHash: string; entryBytes: number },
    createFn: (base: Omit<TextResourceEntry | BlobResourceEntry, 'text' | 'data'>) => E,
  ): E {
    const { contentHash, entryBytes } = params;
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
    this._totalBytes += entryBytes;
    return entry;
  }

  // ── eviction & cache policy ──────────────────────────────────────────────

  private evictOldest(): void {
    const first = this.byUri.values().next();
    if (first.done) {
      return;
    }
    this.removeEntry(first.value.uri);
  }

  private pruneExpiredEntries(now = Date.now()): void {
    const toRemove: string[] = [];
    for (const entry of this.byUri.values()) {
      if (isExpired(entry, now)) {
        toRemove.push(entry.uri);
      }
    }
    for (const uri of toRemove) {
      this.removeEntry(uri);
    }
  }

  private enforceLimits(): void {
    while (this.byUri.size > this.options.maxEntries) {
      this.evictOldest();
    }
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

  private getExisting(uri: string, expectedKind: 'text'): TextResourceEntry & { kind: 'text' };
  private getExisting(uri: string, expectedKind: 'blob'): BlobResourceEntry & { kind: 'blob' };
  private getExisting(uri: string): StoredEntry;
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

  private checkBeforePut(entryBytes: number): void {
    this.pruneExpiredEntries();
    if (entryBytes > this.options.maxEntryBytes) {
      throw new FsError(ErrorCode.TOO_LARGE, `Resource too large to cache (${entryBytes} bytes).`);
    }
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
    const contentHash = computeSha256(params.text);
    const entryBytes = estimateBytes(params.text);
    this.checkBeforePut(entryBytes);

    const entry = this.rawPut(
      { name: params.name, mimeType: params.mimeType ?? 'text/plain', contentHash, entryBytes },
      (base) => ({ ...base, kind: 'text', text: params.text }),
    );
    this.enforceAfterPut(entry);
    return entry;
  }

  getText(uri: string): TextResourceEntry & { kind: 'text' } {
    return this.getExisting(uri, 'text');
  }

  putBlob(params: {
    name: string;
    mimeType: string;
    data: Buffer;
  }): BlobResourceEntry & { kind: 'blob' } {
    const contentHash = computeSha256(params.data);
    const entryBytes = estimateBytes(params.data);
    this.checkBeforePut(entryBytes);

    const entry = this.rawPut(
      { name: params.name, mimeType: params.mimeType, contentHash, entryBytes },
      (base) => ({ ...base, kind: 'blob', data: params.data }),
    );
    this.enforceAfterPut(entry);
    return entry;
  }

  getBlob(uri: string): BlobResourceEntry & { kind: 'blob' } {
    return this.getExisting(uri, 'blob');
  }

  getEntry(uri: string): StoredEntry {
    return this.getExisting(uri);
  }

  clear(): void {
    this.byUri.clear();
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

export interface JsonResourceResult {
  entry: {
    uri: string;
    size: number;
    mimeType: string;
    expiresAt: string;
  };
  link: ContentBlock;
}

/**
 * Owner of the externalize-a-payload rule: a tool whose inline response is
 * truncated publishes the full value to the resource store as pretty-printed
 * JSON and hands back the URI to reach it by, plus the link block that offers
 * it to the user.
 */
export function putJsonResource(
  store: ResourceStore,
  name: string,
  // `Record<string, unknown> | readonly unknown[]`, not `unknown` or `object`:
  // JSON.stringify returns undefined for undefined and for functions, and `null`
  // is excluded so non-string payloads cannot enter the store's text entry.
  value: Record<string, unknown> | readonly unknown[],
): JsonResourceResult {
  const entry = store.putText({
    name,
    mimeType: 'application/json',
    text: JSON.stringify(value, null, 2),
  });

  return {
    entry: {
      uri: entry.uri,
      size: entry.size,
      mimeType: entry.mimeType,
      expiresAt: entry.expiresAt,
    },
    link: {
      type: 'resource_link',
      uri: entry.uri,
      name: entry.name,
      mimeType: entry.mimeType,
      size: entry.size,
      annotations: { audience: ['user'] },
    },
  };
}
