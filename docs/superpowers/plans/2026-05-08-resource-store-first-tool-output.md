# Resource-Store-First Tool Output — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refactor all 18 filesystem-mcp tools so payload bodies live in the `ResourceStore` and tool responses become a terse summary + `resource_link` blocks + typed metadata in `structuredContent`.

**Architecture:** Add `src/lib/mime.ts` for mime detection, extend `ResourceStore` with binary support (`putBlob`/`getBlob`) and lower TTL to 60 s, introduce `buildResourceResponse` + `putResource` helpers in `src/tools/shared.ts`, then refactor each tool plus its tests in dependency order. `structuredContent` drops body fields and gains `uri`/`expiresAt` references.

**Tech Stack:** TypeScript (NodeNext ESM), Zod v4, `@modelcontextprotocol/server` v2, Node `node:test` runner via `tsx/esm`.

**Spec:** [docs/superpowers/specs/2026-05-08-resource-store-first-tool-output-design.md](../specs/2026-05-08-resource-store-first-tool-output-design.md)

---

## Conventions used in this plan

- Run `node scripts/tasks.mjs --quick` after every code change for fast static checks. Run the full `node scripts/tasks.mjs` before each commit.
- Single test file: `node --test --import tsx/esm <path>`.
- Single test by name: add `--test-name-pattern="<name>"`.
- Commit message prefix: `feat:` for new behavior, `refactor:` for tool refactors, `test:` for test-only changes, `chore:` for snapshot regen.

---

## Task 1: Add mime detection helper

**Files:**

- Create: `src/lib/mime.ts`
- Test: `__tests__/unit/mime.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// __tests__/unit/mime.test.ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { detectMimeType } from '../../src/lib/mime.js';

test('detectMimeType: typescript by extension', () => {
  const r = detectMimeType('src/index.ts');
  assert.equal(r.mimeType, 'text/x-typescript');
  assert.equal(r.kind, 'text');
});

test('detectMimeType: png by extension', () => {
  const r = detectMimeType('logo.png');
  assert.equal(r.mimeType, 'image/png');
  assert.equal(r.kind, 'image');
});

test('detectMimeType: pdf by extension', () => {
  const r = detectMimeType('doc.pdf');
  assert.equal(r.mimeType, 'application/pdf');
  assert.equal(r.kind, 'pdf');
});

test('detectMimeType: png by magic bytes when extension missing', () => {
  const sample = Buffer.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00,
  ]);
  const r = detectMimeType('blob', sample);
  assert.equal(r.mimeType, 'image/png');
  assert.equal(r.kind, 'image');
});

test('detectMimeType: json by extension', () => {
  const r = detectMimeType('data.json');
  assert.equal(r.mimeType, 'application/json');
  assert.equal(r.kind, 'text');
});

test('detectMimeType: markdown by extension', () => {
  const r = detectMimeType('README.md');
  assert.equal(r.mimeType, 'text/markdown');
  assert.equal(r.kind, 'text');
});

test('detectMimeType: diff', () => {
  const r = detectMimeType('change.diff');
  assert.equal(r.mimeType, 'text/x-diff');
  assert.equal(r.kind, 'text');
});

test('detectMimeType: unknown text fallback', () => {
  const r = detectMimeType('LICENSE');
  assert.equal(r.mimeType, 'text/plain');
  assert.equal(r.kind, 'text');
});

test('detectMimeType: unknown binary fallback via magic bytes', () => {
  const sample = Buffer.from([0x00, 0x01, 0x02, 0x03]);
  const r = detectMimeType('blob.bin', sample);
  assert.equal(r.mimeType, 'application/octet-stream');
  assert.equal(r.kind, 'binary');
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx/esm __tests__/unit/mime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `src/lib/mime.ts`**

```ts
// src/lib/mime.ts
import { extname } from 'node:path';

export type MimeKind = 'text' | 'binary' | 'image' | 'audio' | 'pdf';

export interface MimeInfo {
  mimeType: string;
  kind: MimeKind;
}

const EXT_MAP: Record<string, MimeInfo> = {
  // text / source
  '.ts': { mimeType: 'text/x-typescript', kind: 'text' },
  '.tsx': { mimeType: 'text/x-typescript', kind: 'text' },
  '.js': { mimeType: 'application/javascript', kind: 'text' },
  '.jsx': { mimeType: 'application/javascript', kind: 'text' },
  '.mjs': { mimeType: 'application/javascript', kind: 'text' },
  '.cjs': { mimeType: 'application/javascript', kind: 'text' },
  '.json': { mimeType: 'application/json', kind: 'text' },
  '.jsonc': { mimeType: 'application/json', kind: 'text' },
  '.md': { mimeType: 'text/markdown', kind: 'text' },
  '.markdown': { mimeType: 'text/markdown', kind: 'text' },
  '.txt': { mimeType: 'text/plain', kind: 'text' },
  '.log': { mimeType: 'text/plain', kind: 'text' },
  '.csv': { mimeType: 'text/csv', kind: 'text' },
  '.tsv': { mimeType: 'text/tab-separated-values', kind: 'text' },
  '.xml': { mimeType: 'application/xml', kind: 'text' },
  '.html': { mimeType: 'text/html', kind: 'text' },
  '.htm': { mimeType: 'text/html', kind: 'text' },
  '.css': { mimeType: 'text/css', kind: 'text' },
  '.scss': { mimeType: 'text/x-scss', kind: 'text' },
  '.yaml': { mimeType: 'application/yaml', kind: 'text' },
  '.yml': { mimeType: 'application/yaml', kind: 'text' },
  '.toml': { mimeType: 'application/toml', kind: 'text' },
  '.ini': { mimeType: 'text/plain', kind: 'text' },
  '.env': { mimeType: 'text/plain', kind: 'text' },
  '.sh': { mimeType: 'application/x-sh', kind: 'text' },
  '.bash': { mimeType: 'application/x-sh', kind: 'text' },
  '.ps1': { mimeType: 'application/x-powershell', kind: 'text' },
  '.py': { mimeType: 'text/x-python', kind: 'text' },
  '.rb': { mimeType: 'text/x-ruby', kind: 'text' },
  '.go': { mimeType: 'text/x-go', kind: 'text' },
  '.rs': { mimeType: 'text/x-rust', kind: 'text' },
  '.c': { mimeType: 'text/x-c', kind: 'text' },
  '.h': { mimeType: 'text/x-c', kind: 'text' },
  '.cc': { mimeType: 'text/x-c++', kind: 'text' },
  '.cpp': { mimeType: 'text/x-c++', kind: 'text' },
  '.hpp': { mimeType: 'text/x-c++', kind: 'text' },
  '.java': { mimeType: 'text/x-java', kind: 'text' },
  '.kt': { mimeType: 'text/x-kotlin', kind: 'text' },
  '.swift': { mimeType: 'text/x-swift', kind: 'text' },
  '.sql': { mimeType: 'application/sql', kind: 'text' },
  '.diff': { mimeType: 'text/x-diff', kind: 'text' },
  '.patch': { mimeType: 'text/x-diff', kind: 'text' },
  // images
  '.png': { mimeType: 'image/png', kind: 'image' },
  '.jpg': { mimeType: 'image/jpeg', kind: 'image' },
  '.jpeg': { mimeType: 'image/jpeg', kind: 'image' },
  '.gif': { mimeType: 'image/gif', kind: 'image' },
  '.webp': { mimeType: 'image/webp', kind: 'image' },
  '.svg': { mimeType: 'image/svg+xml', kind: 'text' },
  '.bmp': { mimeType: 'image/bmp', kind: 'image' },
  '.ico': { mimeType: 'image/x-icon', kind: 'image' },
  // audio
  '.mp3': { mimeType: 'audio/mpeg', kind: 'audio' },
  '.wav': { mimeType: 'audio/wav', kind: 'audio' },
  '.ogg': { mimeType: 'audio/ogg', kind: 'audio' },
  '.flac': { mimeType: 'audio/flac', kind: 'audio' },
  // documents / archives / blobs
  '.pdf': { mimeType: 'application/pdf', kind: 'pdf' },
  '.zip': { mimeType: 'application/zip', kind: 'binary' },
  '.gz': { mimeType: 'application/gzip', kind: 'binary' },
  '.tar': { mimeType: 'application/x-tar', kind: 'binary' },
  '.7z': { mimeType: 'application/x-7z-compressed', kind: 'binary' },
};

interface MagicSignature {
  bytes: readonly number[];
  info: MimeInfo;
}

const MAGIC_SIGNATURES: readonly MagicSignature[] = [
  {
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
    info: { mimeType: 'image/png', kind: 'image' },
  },
  {
    bytes: [0xff, 0xd8, 0xff],
    info: { mimeType: 'image/jpeg', kind: 'image' },
  },
  {
    bytes: [0x47, 0x49, 0x46, 0x38],
    info: { mimeType: 'image/gif', kind: 'image' },
  },
  {
    bytes: [0x25, 0x50, 0x44, 0x46],
    info: { mimeType: 'application/pdf', kind: 'pdf' },
  },
  {
    bytes: [0x50, 0x4b, 0x03, 0x04],
    info: { mimeType: 'application/zip', kind: 'binary' },
  },
];

function matchesMagic(sample: Buffer, sig: MagicSignature): boolean {
  if (sample.length < sig.bytes.length) return false;
  for (let i = 0; i < sig.bytes.length; i += 1) {
    if (sample[i] !== sig.bytes[i]) return false;
  }
  return true;
}

function looksBinary(sample: Buffer): boolean {
  // Heuristic: a NUL byte in the first 8 KiB is a strong binary signal.
  const limit = Math.min(sample.length, 8192);
  for (let i = 0; i < limit; i += 1) {
    if (sample[i] === 0x00) return true;
  }
  return false;
}

export function detectMimeType(path: string, sample?: Buffer): MimeInfo {
  const ext = extname(path).toLowerCase();
  const fromExt = EXT_MAP[ext];
  if (fromExt) return fromExt;

  if (sample && sample.length > 0) {
    for (const sig of MAGIC_SIGNATURES) {
      if (matchesMagic(sample, sig)) return sig.info;
    }
    if (looksBinary(sample)) {
      return { mimeType: 'application/octet-stream', kind: 'binary' };
    }
  }

  return { mimeType: 'text/plain', kind: 'text' };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/mime.test.ts`
Expected: PASS — 9 tests pass.

- [ ] **Step 5: Run quick checks**

Run: `node scripts/tasks.mjs --quick`
Expected: PASS — lint, type-check, knip clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mime.ts __tests__/unit/mime.test.ts
git commit -m "feat: add mime detection helper (extension map + magic bytes)"
```

---

## Task 2: Extend ResourceStore with blob support and lower TTL

**Files:**

- Modify: `src/lib/resource-store.ts`
- Test: `__tests__/unit/resource-store-blob.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// __tests__/unit/resource-store-blob.test.ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createInMemoryResourceStore } from '../../src/lib/resource-store.js';

test('putBlob stores binary and getBlob returns it', () => {
  const store = createInMemoryResourceStore();
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const entry = store.putBlob({
    name: 'logo.png',
    mimeType: 'image/png',
    data,
  });
  assert.match(entry.uri, /^filesystem-mcp:\/\/result\//);
  assert.equal(entry.mimeType, 'image/png');
  assert.equal(entry.size, 4);

  const fetched = store.getBlob(entry.uri);
  assert.equal(fetched.data.equals(data), true);
});

test('putBlob deduplicates identical content', () => {
  const store = createInMemoryResourceStore();
  const data = Buffer.from('hello-bytes');
  const a = store.putBlob({
    name: 'a.bin',
    mimeType: 'application/octet-stream',
    data,
  });
  const b = store.putBlob({
    name: 'b.bin',
    mimeType: 'application/octet-stream',
    data,
  });
  assert.equal(a.uri, b.uri);
});

test('getBlob throws when called on a text URI', () => {
  const store = createInMemoryResourceStore();
  const text = store.putText({ name: 't.txt', text: 'hi' });
  assert.throws(() => store.getBlob(text.uri));
});

test('getText throws when called on a blob URI', () => {
  const store = createInMemoryResourceStore();
  const blob = store.putBlob({
    name: 'b.bin',
    mimeType: 'application/octet-stream',
    data: Buffer.from([1, 2, 3]),
  });
  assert.throws(() => store.getText(blob.uri));
});

test('default TTL is 60 seconds', () => {
  const store = createInMemoryResourceStore();
  const entry = store.putText({ name: 't.txt', text: 'hi' });
  const ttlMs = Date.parse(entry.expiresAt) - Date.parse(entry.storedAt);
  assert.equal(ttlMs, 60_000);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx/esm __tests__/unit/resource-store-blob.test.ts`
Expected: FAIL — `putBlob` undefined; TTL is 30 min.

- [ ] **Step 3: Modify `src/lib/resource-store.ts`**

Read the current file first to confirm the exact location of `DEFAULT_RESOURCE_STORE_OPTIONS`, the `TextResourceEntry`/`ResourceStore` declarations, and the `createInMemoryResourceStore` implementation.

Make these changes:

**3a.** Lower TTL default:

```ts
const DEFAULT_RESOURCE_STORE_OPTIONS: ResourceStoreOptions = {
  maxEntries: 64,
  maxTotalBytes: 25 * 1024 * 1024,
  maxEntryBytes: 10 * 1024 * 1024,
  entryTtlMs: 60 * 1000, // 60 seconds — anti-leak window between tool return and resources/read
};
```

**3b.** Add a `BlobResourceEntry` type and a `kind` discriminator on stored entries:

```ts
export interface BlobResourceEntry {
  uri: string;
  name: string;
  mimeType: string;
  data: Buffer;
  hash: string;
  size: number;
  storedAt: string;
  expiresAt: string;
}

type StoredEntry =
  | (TextResourceEntry & { kind: 'text' })
  | (BlobResourceEntry & { kind: 'blob' });
```

Replace the internal `byUri: Map<string, TextResourceEntry>` with `byUri: Map<string, StoredEntry>`. Update `removeEntry`, `pruneExpiredEntries`, and `enforceLimits` to read `entry.size`/`entry.mimeType`/`entry.hash` (which exist on both kinds — no other change needed).

**3c.** Extend the `ResourceStore` interface:

```ts
export interface ResourceStore {
  putText(params: {
    name: string;
    mimeType?: string;
    text: string;
  }): TextResourceEntry;
  putBlob(params: {
    name: string;
    mimeType: string;
    data: Buffer;
  }): BlobResourceEntry;
  getText(uri: string): TextResourceEntry;
  getBlob(uri: string): BlobResourceEntry;
  clear(): void;
  keys(): string[];
}
```

**3d.** Implement `putBlob` (mirrors `putText` but stores `Buffer`, hashes bytes):

```ts
function computeBlobHash(data: Buffer): string {
  return hash('sha256', data, 'hex');
}

function createBlobEntry(params: {
  uri: string;
  name: string;
  mimeType: string;
  data: Buffer;
  ttlMs: number;
}): BlobResourceEntry {
  const storedAt = new Date();
  return {
    uri: params.uri,
    name: params.name,
    mimeType: params.mimeType,
    data: params.data,
    hash: computeBlobHash(params.data),
    size: params.data.length,
    storedAt: storedAt.toISOString(),
    expiresAt: new Date(storedAt.getTime() + params.ttlMs).toISOString(),
  };
}

function putBlob(params: {
  name: string;
  mimeType: string;
  data: Buffer;
}): BlobResourceEntry {
  pruneExpiredEntries();

  if (params.data.length > resolved.maxEntryBytes) {
    publishResourceStoreDiagnostics({
      phase: 'cache_reject',
      bytes: params.data.length,
      reason: 'entry_too_large',
    });
    throw new McpError(
      ErrorCode.TOO_LARGE,
      `Resource too large to cache (${params.data.length} bytes).`
    );
  }

  const contentHash = computeBlobHash(params.data);
  const indexKey = buildIndexKey(params.mimeType, contentHash);
  const existingUri = byHashIndex.get(indexKey);
  if (existingUri !== undefined) {
    const cached = byUri.get(existingUri);
    if (cached !== undefined && cached.kind === 'blob') {
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
    } else if (cached === undefined) {
      byHashIndex.delete(indexKey);
    }
  }

  const id = randomUUID();
  const uri = `filesystem-mcp://result/${id}`;
  const entry = createBlobEntry({
    uri,
    name: params.name,
    mimeType: params.mimeType,
    data: params.data,
    ttlMs: resolved.entryTtlMs,
  });

  byUri.set(uri, { ...entry, kind: 'blob' });
  byHashIndex.set(indexKey, uri);
  totalBytes += entry.size;
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
```

**3e.** Implement `getBlob` and update `getText` to reject blob URIs:

```ts
function getText(uri: string): TextResourceEntry {
  const existing = byUri.get(uri);
  if (!existing || existing.kind !== 'text') {
    publishResourceStoreDiagnostics({
      phase: 'cache_miss',
      uri,
      reason: 'not_found',
    });
    throw new McpError(
      ErrorCode.NOT_FOUND,
      `Resource not found: ${uri}. Re-run the tool to regenerate.`
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
      `Resource expired: ${uri}. Re-run the tool to regenerate.`
    );
  }
  publishResourceStoreDiagnostics({
    phase: 'cache_hit',
    uri: existing.uri,
    name: existing.name,
    bytes: existing.size,
  });
  const { kind, ...rest } = existing;
  void kind;
  return rest;
}

function getBlob(uri: string): BlobResourceEntry {
  const existing = byUri.get(uri);
  if (!existing || existing.kind !== 'blob') {
    publishResourceStoreDiagnostics({
      phase: 'cache_miss',
      uri,
      reason: 'not_found',
    });
    throw new McpError(
      ErrorCode.NOT_FOUND,
      `Resource not found: ${uri}. Re-run the tool to regenerate.`
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
      `Resource expired: ${uri}. Re-run the tool to regenerate.`
    );
  }
  publishResourceStoreDiagnostics({
    phase: 'cache_hit',
    uri: existing.uri,
    name: existing.name,
    bytes: existing.size,
  });
  const { kind, ...rest } = existing;
  void kind;
  return rest;
}
```

Update `putText` similarly so its dedup branch checks `cached.kind === 'text'` and so the value stored in `byUri` is `{ ...entry, kind: 'text' }`.

Update `keys()` and the returned object to include `putBlob`/`getBlob`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/resource-store-blob.test.ts __tests__/unit/resource-store.test.ts`
Expected: PASS — both new and existing resource-store tests pass.

- [ ] **Step 5: Run full task suite**

Run: `node scripts/tasks.mjs --quick`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/resource-store.ts __tests__/unit/resource-store-blob.test.ts
git commit -m "feat(resource-store): add binary blob support and lower TTL to 60s"
```

---

## Task 3: Add `buildResourceResponse` and `putResource` helpers, drop `maybeExternalizeTextContent`

**Files:**

- Modify: `src/tools/shared.ts`
- Test: `__tests__/unit/shared-resource-response.test.ts`

- [ ] **Step 1: Write failing tests**

```ts
// __tests__/unit/shared-resource-response.test.ts
import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { createInMemoryResourceStore } from '../../src/lib/resource-store.js';
import { buildResourceResponse, putResource } from '../../src/tools/shared.js';

test('buildResourceResponse: summary + resource_link blocks + structured', () => {
  const link = {
    type: 'resource_link' as const,
    uri: 'filesystem-mcp://result/abc',
    name: 'src/x.ts',
    mimeType: 'text/x-typescript',
    size: 10,
  };
  const r = buildResourceResponse({
    summary: 'read: src/x.ts · 1 line · 10 B · text/x-typescript',
    resources: [link],
    structured: { path: 'src/x.ts', size: 10 },
  });
  assert.equal(r.content[0]?.type, 'text');
  assert.equal(r.content[1], link);
  assert.deepEqual(r.structuredContent, { path: 'src/x.ts', size: 10 });
});

test('putResource: text kind uses putText and returns resource_link', () => {
  const store = createInMemoryResourceStore();
  const { entry, link } = putResource({
    store,
    name: 'src/x.ts',
    mimeType: 'text/x-typescript',
    kind: 'text',
    content: 'export const x = 1;',
  });
  assert.equal(link.type, 'resource_link');
  assert.equal(link.mimeType, 'text/x-typescript');
  assert.equal(link.size, entry.size);
  assert.deepEqual(link.annotations?.audience, ['user']);
});

test('putResource: image kind uses putBlob', () => {
  const store = createInMemoryResourceStore();
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
  const { link } = putResource({
    store,
    name: 'logo.png',
    mimeType: 'image/png',
    kind: 'image',
    content: data,
  });
  assert.equal(link.mimeType, 'image/png');
  assert.equal(link.size, 4);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test --import tsx/esm __tests__/unit/shared-resource-response.test.ts`
Expected: FAIL — exports do not exist.

- [ ] **Step 3: Modify `src/tools/shared.ts`**

**3a.** Remove `maybeExternalizeTextContent` and `MAX_INLINE_CONTENT_CHARS` / `MAX_INLINE_PREVIEW_CHARS` constants (no threshold any more).

**3b.** Add the new helpers (place near `buildResourceLink`):

```ts
import type { MimeKind } from '../lib/mime.js';

interface BuildResourceResponseParams<T> {
  summary: string;
  resources: ContentBlock[];
  structured: T;
}

export function buildResourceResponse<T>(
  params: BuildResourceResponseParams<T>
): { content: ContentBlock[]; structuredContent: T } {
  return {
    content: [{ type: 'text', text: params.summary }, ...params.resources],
    structuredContent: params.structured,
  };
}

interface PutResourceParams {
  store: ResourceStore;
  name: string;
  mimeType: string;
  kind: MimeKind;
  content: string | Buffer;
  /** Override default audience annotation. Defaults to ['user']. */
  audience?: ('user' | 'assistant')[];
  /** Optional human-readable title. */
  title?: string;
  /** Optional description. */
  description?: string;
}

interface PutResourceResult {
  entry: { uri: string; size: number; mimeType: string; expiresAt: string };
  link: ContentBlock;
}

export function putResource(params: PutResourceParams): PutResourceResult {
  const audience = params.audience ?? ['user'];

  if (params.kind === 'text') {
    if (typeof params.content !== 'string') {
      throw new TypeError('putResource: kind=text requires string content');
    }
    const entry = params.store.putText({
      name: params.name,
      mimeType: params.mimeType,
      text: params.content,
    });
    return {
      entry,
      link: buildLinkBlock({
        entry,
        audience,
        title: params.title,
        description: params.description,
      }),
    };
  }

  // image | binary | audio | pdf — all use blob storage
  const data = Buffer.isBuffer(params.content)
    ? params.content
    : Buffer.from(params.content, 'utf8');
  const entry = params.store.putBlob({
    name: params.name,
    mimeType: params.mimeType,
    data,
  });
  return {
    entry,
    link: buildLinkBlock({
      entry,
      audience,
      title: params.title,
      description: params.description,
    }),
  };
}

function buildLinkBlock(params: {
  entry: {
    uri: string;
    size: number;
    mimeType: string;
    name: string;
    expiresAt: string;
  };
  audience: ('user' | 'assistant')[];
  title?: string;
  description?: string;
}): ContentBlock {
  return {
    type: 'resource_link',
    uri: params.entry.uri,
    name: params.entry.name,
    ...(params.title ? { title: params.title } : {}),
    ...(params.description ? { description: params.description } : {}),
    mimeType: params.entry.mimeType,
    size: params.entry.size,
    annotations: { audience: params.audience, priority: 0.7 },
    _meta: { expiresAt: params.entry.expiresAt },
  };
}
```

**3c.** Keep `buildResourceLink`, `buildToolResponse`, `buildStructuredError`, `ToolResponse`, `ToolResult`, error types — used by P2/P3 tools and error handling.

**3d.** Find any callers of `maybeExternalizeTextContent` (currently used in `read.ts`, `read-multiple.ts`, `search-content.ts`, `tree.ts`, `list-directory.ts`, `diff-files.ts`) — leave them building errors for now; they will be migrated in their own task.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test --import tsx/esm __tests__/unit/shared-resource-response.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check the whole repo (will reveal callers of removed function)**

Run: `npm run type-check`
Expected: Errors in tools that imported `maybeExternalizeTextContent`. **Do not fix them yet** — those tools migrate in later tasks. To unblock the build for now, leave a stub:

```ts
/** @deprecated Removed in resource-store-first refactor. Use `putResource` instead. */
export function maybeExternalizeTextContent(): undefined {
  return undefined;
}
```

Re-run `npm run type-check`. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/tools/shared.ts __tests__/unit/shared-resource-response.test.ts
git commit -m "feat(tools): add buildResourceResponse and putResource helpers"
```

---

## Task 4: Add `ResourceLinkRef` shared schema

**Files:**

- Modify: `src/schemas/shared.ts`
- Test: `__tests__/schemas/fields.test.ts` (extend)

- [ ] **Step 1: Add to `src/schemas/shared.ts`**

```ts
import { NonNegInt } from './fields.js';

export const ResourceLinkRef = z.strictObject({
  uri: z.string().url().describe('Resource URI; fetch via resources/read'),
  mimeType: z.string().describe('MIME type of the linked resource'),
  size: NonNegInt.describe('Resource size in bytes'),
  expiresAt: z
    .string()
    .datetime()
    .describe('ISO timestamp; resource may be evicted earlier'),
});

export type ResourceLinkRefValue = z.infer<typeof ResourceLinkRef>;
```

- [ ] **Step 2: Add a test**

Append to `__tests__/schemas/fields.test.ts`:

```ts
import { ResourceLinkRef } from '../../src/schemas/shared.js';

test('ResourceLinkRef accepts a valid link metadata object', () => {
  const ok = ResourceLinkRef.safeParse({
    uri: 'filesystem-mcp://result/abc',
    mimeType: 'text/x-typescript',
    size: 4231,
    expiresAt: '2026-05-08T12:34:56.000Z',
  });
  assert.equal(ok.success, true);
});

test('ResourceLinkRef rejects unknown keys', () => {
  const bad = ResourceLinkRef.safeParse({
    uri: 'filesystem-mcp://result/abc',
    mimeType: 'text/x-typescript',
    size: 4231,
    expiresAt: '2026-05-08T12:34:56.000Z',
    extra: true,
  });
  assert.equal(bad.success, false);
});
```

- [ ] **Step 3: Run tests**

Run: `node --test --import tsx/esm __tests__/schemas/fields.test.ts`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/schemas/shared.ts __tests__/schemas/fields.test.ts
git commit -m "feat(schemas): add ResourceLinkRef shared schema"
```

---

## Task 5: Add `readResourceLink` test helper

**Files:**

- Modify: `__tests__/helpers.ts`

- [ ] **Step 1: Add helper**

Append to `__tests__/helpers.ts`:

```ts
import type { Client } from '@modelcontextprotocol/client';
import type { CallToolResult } from '@modelcontextprotocol/server';

/**
 * Walk a tool result for the first resource_link, fetch it via resources/read,
 * and return decoded text or blob along with mime info.
 */
export async function readResourceLink(
  client: Client,
  result: CallToolResult
): Promise<{ text?: string; blob?: Buffer; mimeType: string; uri: string }> {
  const link = result.content.find((b) => b.type === 'resource_link');
  if (!link || link.type !== 'resource_link') {
    throw new Error('No resource_link block in tool result');
  }
  const read = await client.readResource({ uri: link.uri });
  const item = read.contents[0];
  if (!item) throw new Error(`Empty contents for ${link.uri}`);
  if ('text' in item && typeof item.text === 'string') {
    return {
      text: item.text,
      mimeType: item.mimeType ?? link.mimeType ?? 'text/plain',
      uri: link.uri,
    };
  }
  if ('blob' in item && typeof item.blob === 'string') {
    return {
      blob: Buffer.from(item.blob, 'base64'),
      mimeType: item.mimeType ?? link.mimeType ?? 'application/octet-stream',
      uri: link.uri,
    };
  }
  throw new Error(`Resource ${link.uri} has neither text nor blob`);
}
```

- [ ] **Step 2: Smoke-check by running existing tests (helper is unused — should not break anything)**

Run: `node scripts/tasks.mjs --quick`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add __tests__/helpers.ts
git commit -m "test: add readResourceLink helper"
```

---

## Tool refactor recipe (used by Tasks 6–22)

Each tool refactor follows the same five-step recipe. The per-tool table below specifies the differing inputs.

**Recipe:**

1. **Update tests first.** Open the tool's test file. For each test that asserts `result.content[0].text` contains the body, change the assertion to:
   - Call `readResourceLink(client, result)` to fetch the body.
   - Assert the body content via `text` or `blob` from the helper.
   - Assert the new `structuredContent` shape (no body, presence of `uri`, `mimeType`, `expiresAt`).
   - Assert the summary `content[0].text` matches the new format string.
     Run the test file and confirm it FAILS.

2. **Update the output schema.** Drop body fields. Add `uri`, `mimeType`, `size`, `expiresAt` (or use `ResourceLinkRef` directly when the tool returns one link).

3. **Update the handler.** Replace the `buildToolResponse(text, structured, [link])` / inline-content pattern with `buildResourceResponse({ summary, resources, structured })`. Build the link via `putResource({ store, name, mimeType, kind, content })` from `src/tools/shared.ts`. Use `detectMimeType` from `src/lib/mime.ts` to get `mimeType` + `kind` when they are not already known.

4. **Run the tool's tests.** Confirm they PASS.

5. **Run quick checks then commit:**

```bash
node scripts/tasks.mjs --quick
git add src/tools/<tool>.ts __tests__/tools/<file>.test.ts src/schemas/...
git commit -m "refactor(<tool>): emit resource_link instead of inline body"
```

After every group of related tool refactors, also run `node --test --import tsx/esm __tests__/contract.test.ts` — its assertions on annotations should remain green.

---

## Task 6: Refactor `read`

**Files:**

- Modify: `src/tools/read.ts`
- Test: `__tests__/tools/read-write.test.ts` (the `read` tests)

**Per-tool spec:**

- **Summary:** `` `read: ${path} · ${linesRead}/${totalLines} lines · ${humanBytes(size)} · ${mimeType}` ``
- **Resource:** one link, body content (text or blob via `detectMimeType`).
- **`structuredContent`:**

  ```ts
  {
    path: string;
    totalLines?: number;
    linesRead?: number;
    hasMoreLines?: boolean;
    head?: number; tail?: number; startLine?: number; endLine?: number;
    offset?: number; bytesRead?: number; reachedEOF?: boolean;
    size: number;
    mimeType: string;
    isBinary: boolean;
    contentHash?: string;       // when includeHash
    uri: string;
    expiresAt: string;
    continuation?: ContinuationSchema;
  }
  ```

- **Notes:** Drop the existing `content` and `resourceUri` output fields — `uri` replaces both. The continuation logic stays unchanged.

Apply the recipe.

---

## Task 7: Refactor `read-multiple`

**Files:**

- Modify: `src/tools/read-multiple.ts`
- Test: `__tests__/tools/read-write.test.ts` (the `read-multiple` tests)

**Per-tool spec:**

- **Summary:** `` `read-multiple: ${ok}/${total} files · ${humanBytes(totalBytes)}${failed ? ` · ${failed} failed` : ''}` ``
- **Resources:** one `resource_link` per successful file (each with its own mime).
- **`structuredContent`:**

  ```ts
  {
    results: Array<{
      path: string;
      ok: boolean;
      mimeType?: string;
      size?: number;
      uri?: string;
      expiresAt?: string;
      error?: { code: string; message: string };
    }>;
    summary: {
      total: number;
      ok: number;
      failed: number;
      totalBytes: number;
    }
  }
  ```

Apply the recipe.

---

## Task 8: Refactor `list-directory`

**Files:**

- Modify: `src/tools/list-directory.ts`
- Test: `__tests__/tools/directory.test.ts`

**Per-tool spec:**

- **Summary:** `` `list-directory: ${path} · ${total} entries (${dirs} dirs, ${files} files)` ``
- **Resource:** one link with `mimeType: 'application/json'`, body is `JSON.stringify(entries)`.
- **`structuredContent`:** `{ path, total, dirs, files, truncated, uri, mimeType, size, expiresAt }`.

Apply the recipe.

---

## Task 9: Refactor `tree`

**Files:**

- Modify: `src/tools/tree.ts`
- Test: `__tests__/tools/directory.test.ts` (the `tree` tests)

**Per-tool spec:**

- **Summary:** `` `tree: ${root} · ${nodes} nodes · depth ${maxDepth}${truncated ? ' (truncated)' : ''}` ``
- **Resource:** one link with `mimeType: 'application/json'`, body is `JSON.stringify(treeRoot)`.
- **`structuredContent`:** `{ root, nodes, maxDepth, truncated, uri, mimeType, size, expiresAt }`.

Apply the recipe.

---

## Task 10: Refactor `search-files`

**Files:**

- Modify: `src/tools/search-files.ts`
- Test: `__tests__/tools/search.test.ts` (the `search-files` tests)

**Per-tool spec:**

- **Summary:** `` `search-files: ${matches.length} matches for ${pattern}${truncated ? ' (truncated)' : ''}` ``
- **Resource:** one link with `mimeType: 'application/json'`, body is `JSON.stringify(matches)`.
- **`structuredContent`:** `{ pattern, count: matches.length, truncated, uri, mimeType, size, expiresAt }`.

Apply the recipe.

---

## Task 11: Refactor `search-content`

**Files:**

- Modify: `src/tools/search-content.ts`
- Test: `__tests__/tools/search.test.ts` (the `search-content` tests)

**Per-tool spec:**

- **Summary:** `` `search-content: ${hits} hits in ${files} files for ${pattern}${truncated ? ' (truncated)' : ''}` ``
- **Resource:** one link with `mimeType: 'application/json'`, body is `JSON.stringify(hits)` where each hit has `{ path, line, column, lineText, contextBefore?, contextAfter? }`.
- **`structuredContent`:** `{ pattern, hits, files, truncated, uri, mimeType, size, expiresAt }`.

Apply the recipe.

---

## Task 12: Refactor `diff-files`

**Files:**

- Modify: `src/tools/diff-files.ts`
- Test: `__tests__/tools/directory.test.ts` or wherever diff-files tests live (search workspace if unsure: `grep -r "diff_files\|'diff'" __tests__`).

**Per-tool spec:**

- **Summary:** `` `diff: ${a} ↔ ${b} · +${additions}/-${deletions}${identical ? ' (identical)' : ''}` ``
- **Resource:** one link with `mimeType: 'text/x-diff'`, body is the unified diff string.
- **`structuredContent`:** `{ a, b, additions, deletions, identical, uri, mimeType, size, expiresAt }`.

Apply the recipe.

---

## Task 13: Refactor `calculate-hash` (no link)

**Files:**

- Modify: `src/tools/calculate-hash.ts`
- Test: `__tests__/tools/hash.test.ts`

**Per-tool spec:**

- **Pattern:** P2 (no resource_link).
- **Summary:** `` `hash: ${path} · ${algorithm}:${hash.slice(0, 16)}…` ``
- **Resource:** none.
- **`structuredContent`:** `{ path, algorithm, hash, size }`.
- **Helper:** use `buildToolResponse(summary, structured)` (existing helper, unchanged).

Apply the recipe but skip the `putResource` call.

---

## Task 14: Refactor `stat-many`

**Files:**

- Modify: `src/tools/stat-many.ts`
- Test: `__tests__/tools/stat.test.ts` (the `stat-many` tests)

**Per-tool spec:**

- **Summary:** `` `stat-many: ${count} paths${errors ? ` · ${errors} errors` : ''}` ``
- **Resource:** one link with `mimeType: 'application/json'`, body is `JSON.stringify(results)`.
- **`structuredContent`:** `{ count, errors, uri, mimeType, size, expiresAt }`.

Apply the recipe.

---

## Task 15: Refactor `stat` (no link)

**Files:**

- Modify: `src/tools/stat.ts`
- Test: `__tests__/tools/stat.test.ts`

**Per-tool spec:**

- **Pattern:** P2.
- **Summary:** `` `stat: ${path} · ${type} · ${humanBytes(size)}` ``
- **Resource:** none.
- **`structuredContent`:** existing fields preserved (`path, type, size, mtime, ...`).
- **Helper:** `buildToolResponse(summary, structured)`.

Apply the recipe.

---

## Task 16: Refactor `write-file`

**Files:**

- Modify: `src/tools/write-file.ts`
- Test: `__tests__/tools/read-write.test.ts` (the `write-file` tests)

**Per-tool spec:**

- **Summary:** `` `write: ${path} · ${humanBytes(size)} · ${mimeType}${created ? ' (created)' : ''}` ``
- **Resource:** one link to the _written_ content (echoes what is now on disk) — use `putResource` with the new content + detected mime.
- **`structuredContent`:** `{ path, size, mimeType, sha256, created, uri, expiresAt }`.

Apply the recipe.

---

## Task 17: Refactor `edit-file`

**Files:**

- Modify: `src/tools/edit-file.ts`
- Test: `__tests__/tools/read-write.test.ts` (the `edit-file` tests)

**Per-tool spec:**

- **Summary:** `` `edit: ${path} · +${additions}/-${deletions} (${edits} edits)` ``
- **Resource:** one link with `mimeType: 'text/x-diff'`, body is the unified diff between pre/post content.
- **`structuredContent`:** `{ path, edits, additions, deletions, sha256, uri, expiresAt }`.

Apply the recipe.

---

## Task 18: Refactor `apply-patch`

**Files:**

- Modify: `src/tools/apply-patch.ts`
- Test: search workspace (`grep -r "apply_patch\|apply-patch" __tests__`)

**Per-tool spec:**

- **Summary:** `` `patch: ${files} files · +${additions}/-${deletions}` ``
- **Resource:** one link with `mimeType: 'text/x-diff'`, body is the applied unified diff (the patch input echoed or normalized).
- **`structuredContent`:** `{ files, additions, deletions, uri, expiresAt }`.

Apply the recipe.

---

## Task 19: Refactor `replace-in-files`

**Files:**

- Modify: `src/tools/replace-in-files.ts`
- Test: search workspace (`grep -r "replace_in_files\|replace-in-files" __tests__`)

**Per-tool spec:**

- **Summary:** `` `replace: ${files} files · ${replacements} replacements` ``
- **Resource:** one link with `mimeType: 'text/x-diff'`, body is a per-file unified diff bundle.
- **`structuredContent`:** `{ files, replacements, uri, expiresAt }`.

Apply the recipe.

---

## Task 20: Refactor `move-file`, `delete-file`, `create-directory` (no links)

**Files:**

- Modify: `src/tools/move-file.ts`, `src/tools/delete-file.ts`, `src/tools/create-directory.ts`
- Test: search workspace for each tool's test cases.

**Per-tool spec (P2 — confirmation only):**

- `move-file` summary: `` `move: ${from} → ${to}` ``, structured: `{ from, to }`.
- `delete-file` summary: `` `delete: ${path}` ``, structured: `{ path, deleted: true }`.
- `create-directory` summary: `` `mkdir: ${path}` ``, structured: `{ path, created }`.

Each uses `buildToolResponse(summary, structured)`. One commit per tool (or one bundled commit if changes are tiny).

---

## Task 21: Refactor `roots` (no link)

**Files:**

- Modify: `src/tools/roots.ts`
- Test: search workspace.

**Per-tool spec:**

- **Pattern:** P2.
- **Summary:** `` `roots: ${roots.length} allowed` ``
- **`structuredContent`:** `{ roots: string[] }` (existing).

Apply the recipe.

---

## Task 22: Remove the deprecated `maybeExternalizeTextContent` stub

**Files:**

- Modify: `src/tools/shared.ts`

- [ ] **Step 1: Confirm no remaining callers**

Run: `grep -rn "maybeExternalizeTextContent" src __tests__`
Expected: no matches outside `src/tools/shared.ts`.

- [ ] **Step 2: Remove the stub from `src/tools/shared.ts`**

Delete the `/** @deprecated ... */` stub added in Task 3.

- [ ] **Step 3: Run full task suite**

Run: `node scripts/tasks.mjs`
Expected: PASS — lint, type-check, knip (knip will flag any remaining unused exports), tests, build.

- [ ] **Step 4: Commit**

```bash
git add src/tools/shared.ts
git commit -m "refactor(tools): remove deprecated maybeExternalizeTextContent stub"
```

---

## Task 23: Verify `filesystem-mcp://result/{id}` resource handler routes blobs

**Files:**

- Modify: `src/resources.ts`
- Test: `__tests__/resources.test.ts`

- [ ] **Step 1: Read current `src/resources.ts`**

Identify how the `filesystem-mcp://result/{id}` template is handled today (currently only text via `getText`).

- [ ] **Step 2: Write a failing test**

Add to `__tests__/resources.test.ts`:

```ts
test('resources/read returns blob contents for a blob URI', async () => {
  const env = await createTestEnv();
  // Trigger a tool that produces a blob (read on a binary fixture, or putBlob via test seam).
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const entry = env.resourceStore.putBlob({
    name: 'logo.png',
    mimeType: 'image/png',
    data,
  });
  const result = await env.client.readResource({ uri: entry.uri });
  const item = result.contents[0]!;
  assert.equal(item.mimeType, 'image/png');
  assert.equal('blob' in item, true);
  assert.equal(
    Buffer.from((item as { blob: string }).blob, 'base64').equals(data),
    true
  );
});
```

(If `createTestEnv` does not currently expose `resourceStore`, add an accessor in `__tests__/helpers.ts` as part of this task.)

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test --import tsx/esm __tests__/resources.test.ts`
Expected: FAIL — handler returns text-only or throws on blob URI.

- [ ] **Step 4: Update `src/resources.ts`**

In the `filesystem-mcp://result/{id}` handler, look up the entry kind. If the store now exposes a unified `get(uri)` method, use that. Otherwise, try `getText` first; on `kind`-mismatch error, fall through to `getBlob`. Return `BlobResourceContents` (`{ uri, mimeType, blob: data.toString('base64') }`) for blobs and `TextResourceContents` for text.

A cleaner approach: extend `ResourceStore` with a `peek(uri): { kind: 'text' | 'blob' }` accessor and branch on that.

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test --import tsx/esm __tests__/resources.test.ts`
Expected: PASS.

- [ ] **Step 6: Run full task suite**

Run: `node scripts/tasks.mjs`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/resources.ts __tests__/resources.test.ts __tests__/helpers.ts
git commit -m "feat(resources): route filesystem-mcp://result/{id} to blob or text contents"
```

---

## Task 24: Regenerate contract and schema snapshots

**Files:**

- Modify: `__tests__/contract.test.ts` (if any annotation/shape assertions need updating)
- Modify: `__tests__/schemas/__snapshots__/*`

- [ ] **Step 1: Run snapshot tests to see what changed**

Run: `node --test --import tsx/esm __tests__/schemas/snapshot.test.ts`
Expected: snapshot mismatches across all refactored tools.

- [ ] **Step 2: Regenerate snapshots**

Run: `NODE_TEST_UPDATE_SNAPSHOTS=1 node --test --import tsx/esm __tests__/schemas/snapshot.test.ts`
(Or whatever update mechanism the codebase uses — check `__tests__/schemas/snapshot.test.ts` source for the env var or arg.)

- [ ] **Step 3: Eyeball the diff**

Run: `git diff __tests__/schemas/__snapshots__/`
Confirm: every diff matches the design (`uri`, `mimeType`, `size`, `expiresAt` added; body fields removed; no surprise additions).

- [ ] **Step 4: Run full suite**

Run: `node scripts/tasks.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add __tests__/contract.test.ts __tests__/schemas/__snapshots__/
git commit -m "chore(test): regenerate schema snapshots for resource-store-first tools"
```

---

## Task 25: Update `.github/tool-call.md` example

**Files:**

- Modify: `.github/tool-call.md`

- [ ] **Step 1: Read the current file**

- [ ] **Step 2: Replace the response block**

Replace the existing inline-text response with a representative new-shape response for `read`:

```json
{
  "content": [
    {
      "type": "text",
      "text": "read: src/index.ts · 139/139 lines · 4.2 KB · text/x-typescript"
    },
    {
      "type": "resource_link",
      "uri": "filesystem-mcp://result/<uuid>",
      "name": "src/index.ts",
      "title": "Read: src/index.ts",
      "mimeType": "text/x-typescript",
      "size": 4231,
      "annotations": { "audience": ["user"], "priority": 0.7 },
      "_meta": { "expiresAt": "2026-05-08T12:34:56.000Z" }
    }
  ],
  "structuredContent": {
    "path": "src/index.ts",
    "totalLines": 139,
    "linesRead": 139,
    "size": 4231,
    "mimeType": "text/x-typescript",
    "isBinary": false,
    "uri": "filesystem-mcp://result/<uuid>",
    "expiresAt": "2026-05-08T12:34:56.000Z"
  }
}
```

- [ ] **Step 3: Commit**

```bash
git add .github/tool-call.md
git commit -m "docs: update tool-call.md to reflect resource-store-first response shape"
```

---

## Task 26: Final validation

- [ ] **Step 1: Full suite**

Run: `node scripts/tasks.mjs`
Expected: PASS — format, lint, type-check, knip, tests, build.

- [ ] **Step 2: HTTP integration smoke**

Run the inspector against a stdio binding to confirm `read` on a `.png` returns a `resource_link` with `image/png` and that fetching the URI returns base64 data:

```bash
npm run inspector
```

In the Inspector UI, call `read` on an existing PNG fixture (or `assets/icon.png` if present), confirm the response shows `image/png` and the link, click the link to view the rendered image.

- [ ] **Step 3: Mark plan complete**

```bash
git log --oneline
```

Confirm all task commits are present, then push the branch when ready.

---

## Self-review notes

- **Spec coverage:** Tasks map to spec sections — `mime.ts` (Task 1), `ResourceStore` extensions + TTL (Task 2), `shared.ts` helpers (Task 3), `ResourceLinkRef` (Task 4), test helper (Task 5), all 18 tools (Tasks 6–21), stub cleanup (Task 22), resources route (Task 23), snapshot regen (Task 24), example update (Task 25), validation (Task 26).
- **No version bump:** Confirmed — Task 26 does not touch `package.json`.
- **HTTP per-session isolation:** Implicit via existing `AsyncLocalStorage`. Task 23's blob route exercises it; Task 26 step 2 is the manual confirmation.
- **Type consistency:** `MimeKind`, `MimeInfo`, `BlobResourceEntry`, `ResourceLinkRef`, `buildResourceResponse`, `putResource` are defined once and referenced by name throughout.
- **Risks called out in spec are addressed:** test churn → `readResourceLink` helper (Task 5); blob routing → Task 23; inspector compat → Task 26.
