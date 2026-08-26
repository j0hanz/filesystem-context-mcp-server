import { ErrorCode, formatUnknownErrorMessage, FsError } from './errors.js';
import type { PageSnapshot, PageSnapshotStore } from './page-store.js';
import { invalidCursor } from './page-store.js';

interface PageCursor {
  readonly snapshotId: string;
  readonly offset: number;
}

function encodePageCursor(cursor: PageCursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function pageResult<T, M>(
  snapshotId: string,
  offset: number,
  pageSize: number,
  snapshot: PageSnapshot<T, M>,
): { page: readonly T[]; metadata: M; nextCursor: string | undefined } {
  if (offset >= snapshot.items.length) throw invalidCursor();
  const page = snapshot.items.slice(offset, offset + pageSize);
  const nextOffset = offset + page.length;
  return {
    page,
    metadata: snapshot.metadata,
    nextCursor:
      nextOffset < snapshot.items.length
        ? encodePageCursor({ snapshotId, offset: nextOffset })
        : undefined,
  };
}

export function createFirstPage<T, M>(params: {
  store: PageSnapshotStore;
  queryKey: string;
  items: readonly T[];
  metadata: M;
  pageSize: number;
}): { page: readonly T[]; metadata: M; nextCursor: string | undefined } {
  if (params.items.length <= params.pageSize) {
    return {
      page: params.items,
      metadata: params.metadata,
      nextCursor: undefined,
    };
  }
  const snapshotId = params.store.create({
    queryKey: params.queryKey,
    items: params.items,
    metadata: params.metadata,
  });
  return pageResult(snapshotId, 0, params.pageSize, {
    items: params.items,
    metadata: params.metadata,
  });
}

// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- the cursor carries no typed payload; the caller supplies the snapshot's original item and metadata types.
export function readNextPage<T, M>(params: {
  store: PageSnapshotStore;
  queryKey: string;
  cursor: string;
  pageSize: number;
}): { page: readonly T[]; metadata: M; nextCursor: string | undefined } {
  const decoded = decodePageCursor(params.cursor);
  const snapshot = params.store.read<T, M>(decoded.snapshotId, params.queryKey);
  return pageResult(decoded.snapshotId, decoded.offset, params.pageSize, snapshot);
}

function decodePageCursor(cursor: string): PageCursor {
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf-8');
    const parsed = JSON.parse(text) as { snapshotId?: unknown; offset?: unknown };
    if (
      typeof parsed.snapshotId === 'string' &&
      parsed.snapshotId.length > 0 &&
      typeof parsed.offset === 'number' &&
      Number.isInteger(parsed.offset) &&
      parsed.offset >= 0
    ) {
      return { snapshotId: parsed.snapshotId, offset: parsed.offset };
    }
    throw new Error('Invalid page cursor');
  } catch (error) {
    if (error instanceof FsError) throw error;
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      invalidCursor().message,
      undefined,
      { originalError: formatUnknownErrorMessage(error) },
      error instanceof Error ? error : undefined,
    );
  }
}
