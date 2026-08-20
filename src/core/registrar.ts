import type { McpServer, Root } from '@modelcontextprotocol/server';

import { realpath, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { assertNotAborted, processInParallel, timedSignal, withAbort } from './concurrency.js';
import { isAbortError } from './errors.js';
import { Logger } from './observability.js';
import { isSamePath, normalizePath } from './path.js';
import type { PathGuard } from './path.js';
import type { IconInfo } from './primitives.js';
import type { ResourceStore } from './store.js';
import {
  debounce,
  getInitHandshakeTimeoutMs,
  PARALLEL_CONCURRENCY,
  ROOTS_TIMEOUT_MS,
} from './util.js';

export interface ServerDeps {
  server: McpServer;
  pathGuard: PathGuard;
  resourceStore: ResourceStore;
  isInitialized: () => boolean;
  iconInfo?: IconInfo;
  readOnly?: boolean;
}

export interface Registrar {
  register(deps: ServerDeps): void;
  dispose(server?: McpServer): void;
}

// ─── Root directory resolution helpers (relocated from path.ts) ───────────────
// `Root` is deprecated (SEP-2577, 2026-07-28 era) in favor of passing paths via
// tool parameters/resource URIs/config, but the MCP Roots protocol remains the
// live, negotiated mechanism on the current default protocol version
// (2025-11-25) and works correctly there. Migrating fully requires the new
// input_required multi-round-trip pattern; tracked in repo memory, not done here.
/* eslint-disable @typescript-eslint/no-deprecated -- Root: see comment above */

function isFileRoot(root: Root): boolean {
  return root.uri.startsWith('file://');
}

function rethrowIfAborted(error: unknown): void {
  if (isAbortError(error)) throw error;
}

async function resolveRealPathIfExists(
  normalizedPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    assertNotAborted(signal);
    const realPath = await withAbort(realpath(normalizedPath), signal);
    const normalizedReal = normalizePath(realPath);
    return isSamePath(normalizedReal, normalizedPath) ? null : normalizedReal;
  } catch (error) {
    rethrowIfAborted(error);
    return null;
  }
}

async function resolveRootDirectory(root: Root, signal?: AbortSignal): Promise<string | null> {
  try {
    const dirPath = fileURLToPath(root.uri);
    const normalizedPath = normalizePath(dirPath);
    assertNotAborted(signal);
    const stats = await withAbort(stat(normalizedPath), signal);
    if (!stats.isDirectory()) return null;
    return normalizedPath;
  } catch (error) {
    rethrowIfAborted(error);
    return null;
  }
}

async function getValidRootDirectories(roots: Root[], signal?: AbortSignal): Promise<string[]> {
  const fileRoots = roots.filter(isFileRoot);
  if (fileRoots.length === 0) return [];

  const { results } = await processInParallel(
    fileRoots,
    async (root) => {
      const dir = await resolveRootDirectory(root, signal);
      if (dir === null) return [];
      const real = await resolveRealPathIfExists(dir, signal);
      return real ? [dir, real] : [dir];
    },
    PARALLEL_CONCURRENCY,
    signal,
  );

  return results.flatMap((r) => r.value);
}

async function resolveRootDirectories(roots: Root[]): Promise<string[]> {
  if (roots.length === 0) return [];
  return getValidRootDirectories(roots, timedSignal(undefined, ROOTS_TIMEOUT_MS));
}
/* eslint-enable @typescript-eslint/no-deprecated */

function logMissingDirectories(pathGuard: PathGuard): void {
  const boundaries = pathGuard.getRootBoundaries();
  if (boundaries.length > 0) {
    Logger.emit(
      'warning',
      'No allowed directories. A root boundary is configured, but no workspace roots have been granted by the client yet.',
    );
    return;
  }

  if (pathGuard.options?.allowCwd) {
    Logger.emit(
      'notice',
      'No allowed directories specified via CLI arguments, the FS_ALLOWED_DIRS environment variable, or the MCP Roots protocol. Using the current working directory via --allow-cwd.',
    );
    return;
  }

  Logger.emit(
    'warning',
    'No allowed directories specified. Please configure directories via CLI arguments, the FS_ALLOWED_DIRS environment variable, the MCP Roots protocol (notifications/roots/list_changed), or enable --allow-cwd.',
  );
}

function logMissingDirectoriesIfNeeded(pathGuard: PathGuard): void {
  if (pathGuard.getAllowedDirectories().length === 0 && pathGuard.isServerContext) {
    logMissingDirectories(pathGuard);
  }
}

type RootsManagerState = 'idle' | 'initializing' | 'updating' | 'shutting_down';
const ROOTS_DEBOUNCE_MS = 100;

export class McpRootsSynchronizer {
  private state: RootsManagerState = 'initializing';
  private initTimer: ReturnType<typeof setTimeout> | undefined;
  private pendingRootsUpdate = false;
  private rootDirectories: string[] = [];
  private _debouncedUpdate: { (server: McpServer): void; cancel: () => void } | undefined;

  private readonly pathGuard: PathGuard;
  /** See {@link PathGuard.isServerContext} — gates operator-facing warnings. */
  private readonly isServerContext: boolean;

  constructor(pathGuard: PathGuard, isServerContext = false) {
    this.pathGuard = pathGuard;
    this.isServerContext = isServerContext;
  }

  isInitialized(): boolean {
    return this.state === 'idle' || this.state === 'updating';
  }

  registerHandlers(server: McpServer, onInitTimeout?: () => void): void {
    if (this.state === 'shutting_down') return;
    this.state = 'initializing';
    const initHandshakeTimeoutMs = getInitHandshakeTimeoutMs();

    server.server.setNotificationHandler('notifications/initialized', async () => {
      // The low-level Server registers this same notification to fire its
      // `oninitialized` callback; setNotificationHandler replaces that handler,
      // so call it ourselves to preserve the SDK's contract.
      server.server.oninitialized?.();
      if (this.state === 'shutting_down') return;
      if (this.initTimer) {
        clearTimeout(this.initTimer);
        this.initTimer = undefined;
      }
      this.state = 'idle';
      await this.updateRootsFromClient(server);
    });

    server.server.setNotificationHandler('notifications/roots/list_changed', () => {
      if (!this.isInitialized() || this.state === 'shutting_down') return;
      this.scheduleRootsUpdate(server);
    });

    this.initTimer = setTimeout(() => {
      if (this.state === 'initializing') {
        if (this.isServerContext) {
          Logger.emit(
            'warning',
            `Client did not send notifications/initialized within ${String(initHandshakeTimeoutMs)}ms`,
          );
        }
        onInitTimeout?.();
      }
      this.initTimer = undefined;
    }, initHandshakeTimeoutMs);
    this.initTimer.unref();
  }

  private scheduleRootsUpdate(server: McpServer): void {
    this._debouncedUpdate ??= debounce((s: McpServer) => {
      void this.updateRootsFromClient(s);
    }, ROOTS_DEBOUNCE_MS);
    this._debouncedUpdate(server);
  }

  private async updateRootsFromClient(server: McpServer): Promise<void> {
    if (this.state === 'shutting_down') return;

    if (this.state === 'updating') {
      this.pendingRootsUpdate = true;
      return;
    }
    this.state = 'updating';
    // getClientCapabilities()/listRoots(): deprecated (SEP-2577, 2026-07-28 era);
    // listRoots() throws on that era (push-style request model is replaced by
    // input_required there). Both remain correct on the current default protocol
    // version (2025-11-25); full migration needs the new multi-round-trip
    // pattern, tracked in repo memory, not done here.
    /* eslint-disable @typescript-eslint/no-deprecated -- see comment above */
    try {
      const clientCapabilities = server.server.getClientCapabilities();
      if (!clientCapabilities?.roots) {
        this.rootDirectories = [];
      } else {
        const rootsResult = await server.server.listRoots(undefined, {
          timeout: ROOTS_TIMEOUT_MS,
        });
        const roots: Root[] = rootsResult.roots
          .filter((r) => r.uri.startsWith('file://'))
          .map((r) => (r.name ? { uri: r.uri, name: r.name } : { uri: r.uri }));
        this.rootDirectories = await resolveRootDirectories(roots);
      }
    } catch (error) {
      /* eslint-enable @typescript-eslint/no-deprecated */
      // Ungated — a degraded-to-zero-roots server is exactly the case an
      // operator must be told about. listRoots() throws outright on the
      // 2026-07-28 protocol era, where the push-style request model is gone.
      const detail = error instanceof Error ? error.message : String(error);
      Logger.emit(
        detail.includes('timeout') ? 'debug' : 'warning',
        `MCP Roots unavailable (${detail}). No roots discovered from the client — pass allowed directories as CLI arguments or set FS_ALLOWED_DIRS.`,
      );
    } finally {
      const currentState = this.state as RootsManagerState;
      if (currentState !== 'shutting_down') {
        await this.pathGuard.setRoots(this.rootDirectories);
        this.state = 'idle';
        if (this.pendingRootsUpdate) {
          this.pendingRootsUpdate = false;
          void this.updateRootsFromClient(server);
        }
      }
    }
  }

  logMissingDirectoriesIfNeeded(): void {
    logMissingDirectoriesIfNeeded(this.pathGuard);
  }

  destroy(): void {
    this.state = 'shutting_down';
    if (this.initTimer) {
      clearTimeout(this.initTimer);
      this.initTimer = undefined;
    }
    if (this._debouncedUpdate) {
      this._debouncedUpdate.cancel();
      this._debouncedUpdate = undefined;
    }
  }
}
