import type { McpServer, Root } from '@modelcontextprotocol/server';

import { stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

import { processInParallel, timedSignal } from './concurrency.js';
import { formatUnknownErrorMessage, rethrowIfAborted } from './errors.js';
import { Logger } from './observability.js';
import { isSamePath, normalizePath, resolveRealPath } from './path.js';
import type { PathGuard } from './path.js';
import type { IconInfo } from './primitives.js';
import type { ResourceStore } from './store.js';
import {
  debounce,
  getInitHandshakeTimeoutMs,
  PARALLEL_CONCURRENCY,
  ROOTS_TIMEOUT_MS,
} from './util.js';
import type { WatcherRegistry } from './watcher-registry.js';

export interface ServerDeps {
  server: McpServer;
  pathGuard: PathGuard;
  resourceStore: ResourceStore;
  isInitialized: () => boolean;
  iconInfo?: IconInfo;
  readOnly?: boolean;
  /** Shared file-watcher registry for the modern HTTP leg; omitted on legacy/stdio. */
  watcherRegistry?: WatcherRegistry;
  /** Modern-leg resource-updated notify sink (publishes to the ServerEventBus). */
  notifyResourceUpdated?: (uri: string) => void;
}

export interface Registrar {
  readonly register: (deps: ServerDeps) => void;
  readonly dispose: (server?: McpServer) => void;
}

// ─── Root directory resolution helpers (relocated from path.ts) ───────────────
// `Root` is deprecated (SEP-2577, 2026-07-28 era) in favor of passing paths via
// tool parameters/resource URIs/config. The MCP Roots protocol remains the
// live, negotiated mechanism on the 2025-11-25 era and works correctly there;
// on the 2026-07-28 era the roots synchronizer is not armed (allowed
// directories come from configuration), so these helpers only run on legacy.
/* eslint-disable @typescript-eslint/no-deprecated -- Root: see comment above */

function isFileRoot(root: Root): boolean {
  return root.uri.startsWith('file://');
}

async function resolveRealPathIfExists(
  normalizedPath: string,
  signal?: AbortSignal,
): Promise<string | null> {
  try {
    signal?.throwIfAborted();
    const real = await resolveRealPath(normalizedPath, signal);
    if (real === null) return null;
    return isSamePath(real, normalizedPath) ? null : real;
  } catch (error) {
    rethrowIfAborted(error);
    return null;
  }
}

async function resolveRootDirectory(root: Root): Promise<string | null> {
  try {
    const dirPath = fileURLToPath(root.uri);
    const normalizedPath = normalizePath(dirPath);
    const stats = await stat(normalizedPath);
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
      const dir = await resolveRootDirectory(root);
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

const ROOTS_DEBOUNCE_MS = 100;

export type SynchronizerState = 'initializing' | 'idle' | 'updating' | 'shutting_down';

export class McpRootsSynchronizer {
  private state: SynchronizerState = 'initializing';
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

  markInitialized(): void {
    if (this.state !== 'shutting_down') {
      this.state = 'idle';
    }
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
    // listRoots() throws on that era (the push-style server→client request
    // model is replaced by `input_required` there). This method is only reached
    // on legacy-era connections — the serving factories gate
    // `registerHandlers` to `ctx.era === 'legacy'` (stdio) or the legacy
    // sessionful HTTP stack, so `updateRootsFromClient` never runs on a modern
    // instance. The calls stay correct on the 2025-11-25 era they serve.
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
      // operator must be told about. (listRoots() also throws outright on the
      // 2026-07-28 era, but that path is unreachable here — see the gate above.)
      const detail = formatUnknownErrorMessage(error);
      const lower = detail.toLowerCase();
      const isExpectedNonFatal =
        lower.includes('timeout') ||
        lower.includes('method not found') ||
        lower.includes('unsupported') ||
        detail.includes('-32601');
      Logger.emit(
        isExpectedNonFatal ? 'debug' : 'warning',
        `MCP Roots unavailable (${detail}). No roots discovered from the client — pass allowed directories as CLI arguments or set FS_ALLOWED_DIRS.`,
      );
      // A client whose listRoots() failed told us nothing; clear the last-known
      // roots so the guard does not keep granting a stale access-control input.
      this.rootDirectories = [];
    } finally {
      const currentState = this.state as SynchronizerState;
      if (currentState !== 'shutting_down') {
        try {
          await this.pathGuard.setRoots(this.rootDirectories);
        } catch (error) {
          Logger.emit(
            'warning',
            `Failed to apply roots to the path guard: ${formatUnknownErrorMessage(error)}`,
          );
        }
        // destroy() can flip state to 'shutting_down' during the await above.
        // Re-check before marking idle or re-arming the queued update, so a
        // shutdown started mid-await does not leave the manager in 'idle' or
        // schedule work after destroy().
        if ((this.state as SynchronizerState) !== 'shutting_down') {
          this.state = 'idle';
          if (this.pendingRootsUpdate) {
            this.pendingRootsUpdate = false;
            void this.updateRootsFromClient(server);
          }
        }
      }
    }
  }

  logMissingDirectoriesIfNeeded(): void {
    if (this.pathGuard.getAllowedDirectories().length === 0 && this.pathGuard.isServerContext) {
      logMissingDirectories(this.pathGuard);
    }
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
