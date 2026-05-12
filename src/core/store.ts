import { hash, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

import { ErrorCode, McpError } from './errors.js';

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

export function createInMemoryResourceStore(
  options: Partial<ResourceStoreOptions> = {},
): ResourceStore {
  const resolved: ResourceStoreOptions = {
    ...DEFAULT_RESOURCE_STORE_OPTIONS,
    ...options,
  };

  const byUri = new Map<string, StoredEntry>();
  const byHashIndex = new Map<string, string>(); // mimeType:sha256hex -> uri
  let totalBytes = 0;

  function removeEntry(uri: string, reason?: ResourceStoreDiagnosticsEvent['reason']): void {
    const existing = byUri.get(uri);
    if (!existing) return;
    totalBytes -= existing.size;
    byUri.delete(uri);
    byHashIndex.delete(buildIndexKey(existing.mimeType, existing.hash));
    publishResourceStoreDiagnostics({
      phase: 'cache_evict',
      uri,
      name: existing.name,
      bytes: existing.size,
      ...(reason !== undefined ? { reason } : {}),
    });
  }

  function evictOldest(): void {
    const first = byUri.keys().next();
    if (first.done) return;
    removeEntry(first.value);
  }

  function pruneExpiredEntries(now = Date.now()): void {
    for (const [uri, entry] of byUri) {
      if (isExpired(entry, now)) {
        removeEntry(uri, 'expired');
      }
    }
  }

  function enforceLimits(): void {
    while (byUri.size > resolved.maxEntries) evictOldest();
    while (totalBytes > resolved.maxTotalBytes) {
      if (byUri.size === 0) break;
      evictOldest();
    }
  }

  function bumpLru(uri: string, entry: StoredEntry): void {
    byUri.delete(uri);
    byUri.set(uri, entry);
  }

  function _getExisting(uri: string, expectedKind?: 'text' | 'blob'): StoredEntry {
    const existing = byUri.get(uri);
    if (!existing || (expectedKind && existing.kind !== expectedKind)) {
      publishResourceStoreDiagnostics({
        phase: 'cache_miss',
        uri,
        reason: 'not_found',
      });
      throw new McpError(
        ErrorCode.NOT_FOUND,
        `Resource not found: ${uri}. Re-run the tool to regenerate.`,
      );
    }
    if (isExpired(existing)) {
      removeEntry(uri, 'expired');
      publishResourceStoreDiagnostics({
        phase: 'cache_miss',
        uri,
        reason: 'expired',
      });
      throw new McpError(
        ErrorCode.NOT_FOUND,
        `Resource expired: ${uri}. Re-run the tool to regenerate.`,
      );
    }
    bumpLru(uri, existing);
    publishResourceStoreDiagnostics({
      phase: 'cache_hit',
      uri: existing.uri,
      name: existing.name,
      bytes: existing.size,
    });
    return existing;
  }

  function _put(
    kind: 'text' | 'blob',
    params: { name: string; mimeType: string; data: string | Buffer },
    createFn: (base: Omit<TextResourceEntry | BlobResourceEntry, 'text' | 'data'>) => StoredEntry,
  ): StoredEntry {
    pruneExpiredEntries();

    const entryBytes = estimateBytes(params.data);
    if (entryBytes > resolved.maxEntryBytes) {
      publishResourceStoreDiagnostics({
        phase: 'cache_reject',
        bytes: entryBytes,
        reason: 'entry_too_large',
      });
      throw new McpError(ErrorCode.TOO_LARGE, `Resource too large to cache (${entryBytes} bytes).`);
    }

    const contentHash = computeSha256(params.data);
    const indexKey = buildIndexKey(params.mimeType, contentHash);
    const existingUri = byHashIndex.get(indexKey);

    if (existingUri !== undefined) {
      const cached = byUri.get(existingUri);
      if (cached !== undefined) {
        if (isExpired(cached)) {
          removeEntry(existingUri, 'expired');
        } else if (cached.kind === kind) {
          bumpLru(existingUri, cached);
          publishResourceStoreDiagnostics({
            phase: 'cache_hit',
            uri: cached.uri,
            name: cached.name,
            bytes: cached.size,
          });
          return cached;
        }
      } else {
        byHashIndex.delete(indexKey);
      }
    }

    const uri = `filesystem-mcp://result/${randomUUID()}`;
    const storedAt = new Date();
    const entry = createFn({
      uri,
      name: params.name,
      mimeType: params.mimeType,
      hash: contentHash,
      size: entryBytes,
      storedAt: storedAt.toISOString(),
      expiresAt: new Date(storedAt.getTime() + resolved.entryTtlMs).toISOString(),
    });

    byUri.set(uri, entry);
    byHashIndex.set(indexKey, uri);
    totalBytes += entryBytes;

    publishResourceStoreDiagnostics({
      phase: 'cache_store',
      uri: entry.uri,
      name: entry.name,
      bytes: entry.size,
    });

    enforceLimits();

    if (!byUri.has(uri)) {
      publishResourceStoreDiagnostics({
        phase: 'cache_reject',
        uri,
        name: entry.name,
        bytes: entry.size,
        reason: 'evicted_immediately',
      });
      throw new McpError(ErrorCode.TOO_LARGE, 'Cache full: entry evicted.');
    }

    return entry;
  }

  function putText(params: { name: string; mimeType?: string; text: string }): TextResourceEntry {
    return _put(
      'text',
      {
        name: params.name,
        mimeType: params.mimeType ?? 'text/plain',
        data: params.text,
      },
      (base) => ({
        ...base,
        kind: 'text',
        text: params.text,
      }),
    ) as TextResourceEntry & { kind: 'text' };
  }

  function getText(uri: string): TextResourceEntry {
    return _getExisting(uri, 'text') as TextResourceEntry & { kind: 'text' };
  }

  function putBlob(params: { name: string; mimeType: string; data: Buffer }): BlobResourceEntry {
    return _put(
      'blob',
      { name: params.name, mimeType: params.mimeType, data: params.data },
      (base) => ({
        ...base,
        kind: 'blob',
        data: params.data,
      }),
    ) as BlobResourceEntry & { kind: 'blob' };
  }

  function getBlob(uri: string): BlobResourceEntry {
    return _getExisting(uri, 'blob') as BlobResourceEntry & { kind: 'blob' };
  }

  function getEntry(uri: string): StoredEntry {
    return _getExisting(uri);
  }

  function clear(): void {
    const bytesBeforeClear = totalBytes;
    byUri.clear();
    byHashIndex.clear();
    totalBytes = 0;
    publishResourceStoreDiagnostics({
      phase: 'cache_clear',
      bytes: bytesBeforeClear,
    });
  }

  function keys(): string[] {
    pruneExpiredEntries();
    return Array.from(byUri.keys());
  }

  return { putText, getText, putBlob, getBlob, getEntry, clear, keys };
}
