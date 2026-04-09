import { hash, randomUUID } from 'node:crypto';
import { channel } from 'node:diagnostics_channel';

import { ErrorCode, McpError } from './errors.js';

export interface TextResourceEntry {
  uri: string;
  name: string;
  mimeType: string;
  text: string;
  hash: string;
  size: number;
  storedAt: string;
  expiresAt: string;
}

export interface ResourceStore {
  putText(params: {
    name: string;
    mimeType?: string;
    text: string;
  }): TextResourceEntry;
  getText(uri: string): TextResourceEntry;
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
  entryTtlMs: 30 * 60 * 1000, // 30 minutes
};

interface ResourceStoreDiagnosticsEvent {
  phase:
    | 'cache_hit'
    | 'cache_miss'
    | 'cache_store'
    | 'cache_evict'
    | 'cache_clear'
    | 'cache_reject';
  uri?: string;
  name?: string;
  bytes?: number;
  reason?: 'entry_too_large' | 'evicted_immediately' | 'expired' | 'not_found';
}

const RESOURCE_STORE_DIAGNOSTICS_CHANNEL = channel(
  'filesystem-mcp:resource-store'
);

function publishResourceStoreDiagnostics(
  event: ResourceStoreDiagnosticsEvent
): void {
  if (!RESOURCE_STORE_DIAGNOSTICS_CHANNEL.hasSubscribers) return;
  RESOURCE_STORE_DIAGNOSTICS_CHANNEL.publish(event);
}

function estimateBytes(text: string): number {
  return Buffer.byteLength(text, 'utf8');
}

function computeSha256(text: string): string {
  return hash('sha256', text, 'hex');
}

function buildIndexKey(mimeType: string, contentHash: string): string {
  return `${mimeType}:${contentHash}`;
}

function isExpired(entry: TextResourceEntry, now = Date.now()): boolean {
  const expiresAt = Date.parse(entry.expiresAt);
  return Number.isFinite(expiresAt) && expiresAt <= now;
}

function createTextEntry(params: {
  uri: string;
  name: string;
  mimeType: string;
  text: string;
  ttlMs: number;
}): TextResourceEntry {
  const storedAt = new Date();
  return {
    uri: params.uri,
    name: params.name,
    mimeType: params.mimeType,
    text: params.text,
    hash: computeSha256(params.text),
    size: estimateBytes(params.text),
    storedAt: storedAt.toISOString(),
    expiresAt: new Date(storedAt.getTime() + params.ttlMs).toISOString(),
  };
}

export function createInMemoryResourceStore(
  options: Partial<ResourceStoreOptions> = {}
): ResourceStore {
  const resolved: ResourceStoreOptions = {
    ...DEFAULT_RESOURCE_STORE_OPTIONS,
    ...options,
  };

  const byUri = new Map<string, TextResourceEntry>();
  const byHashIndex = new Map<string, string>(); // mimeType:sha256hex -> uri
  let totalBytes = 0;

  function removeEntry(
    uri: string,
    reason?: ResourceStoreDiagnosticsEvent['reason']
  ): void {
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

  function putText(params: {
    name: string;
    mimeType?: string;
    text: string;
  }): TextResourceEntry {
    pruneExpiredEntries();

    const mimeType = params.mimeType ?? 'text/plain';
    const entryBytes = estimateBytes(params.text);
    if (entryBytes > resolved.maxEntryBytes) {
      publishResourceStoreDiagnostics({
        phase: 'cache_reject',
        bytes: entryBytes,
        reason: 'entry_too_large',
      });
      throw new McpError(
        ErrorCode.TOO_LARGE,
        `Resource too large to cache (${entryBytes} bytes)`
      );
    }

    const contentHash = computeSha256(params.text);
    const indexKey = buildIndexKey(mimeType, contentHash);
    const existingUri = byHashIndex.get(indexKey);
    if (existingUri !== undefined) {
      const cached = byUri.get(existingUri);
      if (cached !== undefined) {
        if (isExpired(cached)) {
          removeEntry(existingUri, 'expired');
        } else {
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

    const id = randomUUID();
    const uri = `filesystem-mcp://result/${id}`;
    const entry = createTextEntry({
      uri,
      name: params.name,
      mimeType,
      text: params.text,
      ttlMs: resolved.entryTtlMs,
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
      throw new McpError(
        ErrorCode.TOO_LARGE,
        'Resource cache full: entry evicted immediately'
      );
    }

    return entry;
  }

  function getText(uri: string): TextResourceEntry {
    const existing = byUri.get(uri);
    if (!existing) {
      publishResourceStoreDiagnostics({
        phase: 'cache_miss',
        uri,
        reason: 'not_found',
      });
      throw new McpError(
        ErrorCode.NOT_FOUND,
        `Resource not found: ${uri}. The cached result may have been evicted. Re-run the originating tool to regenerate.`
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
        `Resource expired: ${uri}. Re-run the originating tool to regenerate.`
      );
    }
    publishResourceStoreDiagnostics({
      phase: 'cache_hit',
      uri: existing.uri,
      name: existing.name,
      bytes: existing.size,
    });
    return existing;
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

  return { putText, getText, clear, keys };
}
