import { hash, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

import { ErrorCode, FsError } from './errors.js';

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
  putText(params: { name: string; mimeType?: string; text: string }): TextResourceEntry;
  getText(uri: string): TextResourceEntry;
  putBlob(params: { name: string; mimeType: string; data: Buffer }): BlobResourceEntry;
  getBlob(uri: string): BlobResourceEntry;
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

const _CACHE_PHASES = [
  'cache_hit',
  'cache_miss',
  'cache_store',
  'cache_evict',
  'cache_clear',
  'cache_reject',
] as const;

type CachePhase = (typeof _CACHE_PHASES)[number];

const _CACHE_EVICTION_REASONS = [
  'entry_too_large',
  'evicted_immediately',
  'expired',
  'not_found',
] as const;

type CacheEvictionReason = (typeof _CACHE_EVICTION_REASONS)[number];

interface ResourceStoreDiagnosticsEvent {
  phase: CachePhase;
  uri?: string;
  name?: string;
  bytes?: number;
  reason?: CacheEvictionReason;
}

const RESOURCE_STORE_DIAGNOSTICS_CHANNEL = channel('filesystem-mcp:resource-store');

function publishResourceStoreDiagnostics(event: ResourceStoreDiagnosticsEvent): void {
  if (!RESOURCE_STORE_DIAGNOSTICS_CHANNEL.hasSubscribers) return;
  RESOURCE_STORE_DIAGNOSTICS_CHANNEL.publish(event);
}

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
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

// -----------------------------------------------------------------------------
// Internal Interfaces
// -----------------------------------------------------------------------------

interface InternalStore extends ResourceStore {
  removeEntry(uri: string, reason?: CacheEvictionReason): StoredEntry | undefined;
  getEntryIfExists(uri: string): StoredEntry | undefined;
  getEntryByHash(mimeType: string, contentHash: string): StoredEntry | undefined;
  bumpLru(uri: string, entry: StoredEntry): void;
  readonly totalBytes: number;
  readonly entryCount: number;
  entries(): IterableIterator<StoredEntry>;
}

// -----------------------------------------------------------------------------
// Raw Storage
// -----------------------------------------------------------------------------

class RawStore implements InternalStore {
  private readonly byUri = new Map<string, StoredEntry>();
  private readonly byHashIndex = new Map<string, string>();
  private _totalBytes = 0;
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  get totalBytes(): number {
    return this._totalBytes;
  }
  get entryCount(): number {
    return this.byUri.size;
  }
  entries(): IterableIterator<StoredEntry> {
    return this.byUri.values();
  }

  getEntryIfExists(uri: string): StoredEntry | undefined {
    return this.byUri.get(uri);
  }

  getEntryByHash(mimeType: string, contentHash: string): StoredEntry | undefined {
    const indexKey = buildIndexKey(mimeType, contentHash);
    const existingUri = this.byHashIndex.get(indexKey);
    return existingUri ? this.byUri.get(existingUri) : undefined;
  }

  bumpLru(uri: string, entry: StoredEntry): void {
    this.byUri.delete(uri);
    this.byUri.set(uri, entry);
  }

  removeEntry(uri: string, _reason?: CacheEvictionReason): StoredEntry | undefined {
    const existing = this.byUri.get(uri);
    if (!existing) return undefined;
    this._totalBytes -= existing.size;
    this.byUri.delete(uri);
    this.byHashIndex.delete(buildIndexKey(existing.mimeType, existing.hash));
    return existing;
  }

  private _put(
    _kind: 'text' | 'blob',
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
      expiresAt: new Date(storedAt.getTime() + this.ttlMs).toISOString(),
    });

    this.byUri.set(uri, entry);
    this.byHashIndex.set(buildIndexKey(params.mimeType, contentHash), uri);
    this._totalBytes += entryBytes;
    return entry;
  }

  putText(params: { name: string; mimeType?: string; text: string }): TextResourceEntry {
    return this._put(
      'text',
      { name: params.name, mimeType: params.mimeType ?? 'text/plain', data: params.text },
      (base) => ({ ...base, kind: 'text', text: params.text }),
    ) as TextResourceEntry & { kind: 'text' };
  }

  getText(uri: string): TextResourceEntry & { kind: 'text' } {
    const entry = this.getEntry(uri);
    if (entry.kind !== 'text')
      throw new FsError(ErrorCode.NOT_FOUND, `Resource is not text: ${uri}`);
    return entry;
  }

  putBlob(params: { name: string; mimeType: string; data: Buffer }): BlobResourceEntry {
    return this._put(
      'blob',
      { name: params.name, mimeType: params.mimeType, data: params.data },
      (base) => ({ ...base, kind: 'blob', data: params.data }),
    ) as BlobResourceEntry & { kind: 'blob' };
  }

  getBlob(uri: string): BlobResourceEntry {
    const entry = this.getEntry(uri);
    if (entry.kind !== 'blob')
      throw new FsError(ErrorCode.NOT_FOUND, `Resource is not blob: ${uri}`);
    return entry;
  }

  getEntry(uri: string): StoredEntry {
    const existing = this.byUri.get(uri);
    if (!existing) throw new FsError(ErrorCode.NOT_FOUND, `Resource not found: ${uri}`);
    return existing;
  }

  clear(): void {
    this.byUri.clear();
    this.byHashIndex.clear();
    this._totalBytes = 0;
  }

  keys(): string[] {
    return Array.from(this.byUri.keys());
  }
}

// -----------------------------------------------------------------------------
// Delegation Base
// -----------------------------------------------------------------------------

abstract class WrappedStore implements InternalStore {
  protected readonly wrapped: InternalStore;

  constructor(wrapped: InternalStore) {
    this.wrapped = wrapped;
  }

  get totalBytes() {
    return this.wrapped.totalBytes;
  }
  get entryCount() {
    return this.wrapped.entryCount;
  }
  entries() {
    return this.wrapped.entries();
  }
  getEntryIfExists(uri: string) {
    return this.wrapped.getEntryIfExists(uri);
  }
  getEntryByHash(mimeType: string, contentHash: string) {
    return this.wrapped.getEntryByHash(mimeType, contentHash);
  }
  bumpLru(uri: string, entry: StoredEntry) {
    this.wrapped.bumpLru(uri, entry);
  }

  abstract removeEntry(uri: string, reason?: CacheEvictionReason): StoredEntry | undefined;
  abstract putText(params: { name: string; mimeType?: string; text: string }): TextResourceEntry;
  abstract getText(uri: string): TextResourceEntry;
  abstract putBlob(params: { name: string; mimeType: string; data: Buffer }): BlobResourceEntry;
  abstract getBlob(uri: string): BlobResourceEntry;
  abstract getEntry(uri: string): StoredEntry;
  abstract clear(): void;
  abstract keys(): string[];
}

// -----------------------------------------------------------------------------
// Diagnostic Decorator
// -----------------------------------------------------------------------------

class DiagnosticStore extends WrappedStore {
  constructor(wrapped: InternalStore) {
    super(wrapped);
  }

  removeEntry(uri: string, reason?: CacheEvictionReason): StoredEntry | undefined {
    const entry = this.wrapped.removeEntry(uri, reason);
    if (entry) {
      publishResourceStoreDiagnostics({
        phase: 'cache_evict',
        uri,
        name: entry.name,
        bytes: entry.size,
        ...(reason !== undefined ? { reason } : {}),
      });
    }
    return entry;
  }

  putText(params: {
    name: string;
    mimeType?: string;
    text: string;
  }): TextResourceEntry & { kind: 'text' } {
    const entry = this.wrapped.putText(params) as TextResourceEntry & { kind: 'text' };
    publishResourceStoreDiagnostics({
      phase: 'cache_store',
      uri: entry.uri,
      name: entry.name,
      bytes: entry.size,
    });
    return entry;
  }

  getText(uri: string): TextResourceEntry & { kind: 'text' } {
    return this.wrapped.getText(uri) as TextResourceEntry & { kind: 'text' };
  }

  putBlob(params: {
    name: string;
    mimeType: string;
    data: Buffer;
  }): BlobResourceEntry & { kind: 'blob' } {
    const entry = this.wrapped.putBlob(params) as BlobResourceEntry & { kind: 'blob' };
    publishResourceStoreDiagnostics({
      phase: 'cache_store',
      uri: entry.uri,
      name: entry.name,
      bytes: entry.size,
    });
    return entry;
  }

  getBlob(uri: string): BlobResourceEntry & { kind: 'blob' } {
    return this.wrapped.getBlob(uri) as BlobResourceEntry & { kind: 'blob' };
  }

  getEntry(uri: string): StoredEntry {
    return this.wrapped.getEntry(uri);
  }

  clear(): void {
    const bytesBeforeClear = this.wrapped.totalBytes;
    this.wrapped.clear();
    publishResourceStoreDiagnostics({ phase: 'cache_clear', bytes: bytesBeforeClear });
  }

  keys(): string[] {
    return this.wrapped.keys();
  }
}

// -----------------------------------------------------------------------------
// Eviction & Cache Policy Decorator
// -----------------------------------------------------------------------------

class EvictionStore extends WrappedStore {
  private readonly options: ResourceStoreOptions;

  constructor(wrapped: InternalStore, options: ResourceStoreOptions) {
    super(wrapped);
    this.options = options;
  }

  removeEntry(uri: string, reason?: CacheEvictionReason) {
    return this.wrapped.removeEntry(uri, reason);
  }

  private evictOldest(): void {
    const first = this.wrapped.entries().next();
    if (first.done) return;
    this.removeEntry(first.value.uri);
  }

  private pruneExpiredEntries(now = Date.now()): void {
    for (const entry of this.wrapped.entries()) {
      if (isExpired(entry, now)) {
        this.removeEntry(entry.uri, 'expired');
      }
    }
  }

  private enforceLimits(): void {
    while (this.wrapped.entryCount > this.options.maxEntries) this.evictOldest();
    while (this.wrapped.totalBytes > this.options.maxTotalBytes) {
      if (this.wrapped.entryCount === 0) break;
      this.evictOldest();
    }
  }

  private _getExisting(uri: string, expectedKind?: 'text' | 'blob'): StoredEntry {
    const existing = this.wrapped.getEntryIfExists(uri);
    if (!existing || (expectedKind && existing.kind !== expectedKind)) {
      publishResourceStoreDiagnostics({ phase: 'cache_miss', uri, reason: 'not_found' });
      throw new FsError(
        ErrorCode.NOT_FOUND,
        `Resource not found: ${uri}. Re-run the tool to regenerate.`,
      );
    }
    if (isExpired(existing)) {
      this.removeEntry(uri, 'expired');
      publishResourceStoreDiagnostics({ phase: 'cache_miss', uri, reason: 'expired' });
      throw new FsError(
        ErrorCode.NOT_FOUND,
        `Resource expired: ${uri}. Re-run the tool to regenerate.`,
      );
    }
    this.bumpLru(uri, existing);
    publishResourceStoreDiagnostics({
      phase: 'cache_hit',
      uri: existing.uri,
      name: existing.name,
      bytes: existing.size,
    });
    return existing;
  }

  private _checkBeforePut(data: string | Buffer): void {
    this.pruneExpiredEntries();
    const entryBytes = estimateBytes(data);
    if (entryBytes > this.options.maxEntryBytes) {
      publishResourceStoreDiagnostics({
        phase: 'cache_reject',
        bytes: entryBytes,
        reason: 'entry_too_large',
      });
      throw new FsError(ErrorCode.TOO_LARGE, `Resource too large to cache (${entryBytes} bytes).`);
    }
  }

  private _tryReturnHashHit(
    kind: 'text' | 'blob',
    mimeType: string,
    data: string | Buffer,
  ): StoredEntry | undefined {
    const contentHash = computeSha256(data);
    const cached = this.wrapped.getEntryByHash(mimeType, contentHash);
    if (cached !== undefined) {
      if (isExpired(cached)) {
        this.removeEntry(cached.uri, 'expired');
      } else if (cached.kind === kind) {
        this.bumpLru(cached.uri, cached);
        publishResourceStoreDiagnostics({
          phase: 'cache_hit',
          uri: cached.uri,
          name: cached.name,
          bytes: cached.size,
        });
        return cached;
      }
    }
    return undefined;
  }

  private _enforceAfterPut(entry: StoredEntry): void {
    this.enforceLimits();
    if (!this.wrapped.getEntryIfExists(entry.uri)) {
      publishResourceStoreDiagnostics({
        phase: 'cache_reject',
        uri: entry.uri,
        name: entry.name,
        bytes: entry.size,
        reason: 'evicted_immediately',
      });
      throw new FsError(ErrorCode.TOO_LARGE, 'Cache full: entry evicted.');
    }
  }
  putText(params: { name: string; mimeType?: string; text: string }): TextResourceEntry & {
    kind: 'text';
  } {
    this._checkBeforePut(params.text);
    const hit = this._tryReturnHashHit('text', params.mimeType ?? 'text/plain', params.text);
    if (hit) return hit as TextResourceEntry & { kind: 'text' };

    const entry = this.wrapped.putText(params) as TextResourceEntry & { kind: 'text' };
    this._enforceAfterPut(entry);
    return entry;
  }
  getText(uri: string): TextResourceEntry & { kind: 'text' } {
    return this._getExisting(uri, 'text') as TextResourceEntry & { kind: 'text' };
  }

  putBlob(params: {
    name: string;
    mimeType: string;
    data: Buffer;
  }): BlobResourceEntry & { kind: 'blob' } {
    this._checkBeforePut(params.data);
    const hit = this._tryReturnHashHit('blob', params.mimeType, params.data);
    if (hit) return hit as BlobResourceEntry & { kind: 'blob' };

    const entry = this.wrapped.putBlob(params) as BlobResourceEntry & { kind: 'blob' };
    this._enforceAfterPut(entry);
    return entry;
  }

  getBlob(uri: string): BlobResourceEntry {
    return this._getExisting(uri, 'blob') as BlobResourceEntry & { kind: 'blob' };
  }

  getEntry(uri: string): StoredEntry {
    return this._getExisting(uri);
  }

  clear(): void {
    this.wrapped.clear();
  }

  keys(): string[] {
    this.pruneExpiredEntries();
    return this.wrapped.keys();
  }
}

export function createInMemoryResourceStore(
  options: Partial<ResourceStoreOptions> = {},
): ResourceStore {
  const resolved = { ...DEFAULT_RESOURCE_STORE_OPTIONS, ...options };
  const raw = new RawStore(resolved.entryTtlMs);
  const diagnostic = new DiagnosticStore(raw);
  const eviction = new EvictionStore(diagnostic, resolved);
  return eviction;
}
