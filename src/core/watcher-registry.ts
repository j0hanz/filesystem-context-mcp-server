import type { FSWatcher } from 'node:fs';
import { statSync, watch } from 'node:fs';

import { formatUnknownErrorMessage } from './errors.js';
import { Logger } from './observability.js';
import { parseEnvInt } from './util.js';

// Cap concurrent file watchers to avoid exhausting OS-level watch handles
// (e.g. Linux inotify, default ~8192/user). One subscription == one watcher.
export const MAX_WATCHERS = parseEnvInt('FILESYSTEM_MCP_MAX_WATCHERS', 256, 1, 4096);

/**
 * Owns the uri → FSWatcher map and the subscription bookkeeping around it:
 * notify callbacks, desired subscribe/unsubscribe state, and the watcher cap.
 * `subscribe` awaits path validation midway, so callers re-check `isStale` and
 * `hasWatcher` after the await before attaching.
 */
export function createWatcherRegistry() {
  const watchers = new Map<string, FSWatcher>();
  // A URI may have several subscribers; each subscriber's notify callback lives
  // in the Set. `addCallback` adds (not replaces), so a second subscriber no
  // longer silently drops the first's callback. The unsubscribe protocol
  // carries no subscription id, so `remove(uri)` ref-counts by URI: it only
  // tears down the shared watcher when the last subscriber leaves. A departed
  // subscriber's notify closure lingers in the Set until then; its transport is
  // gone and `sendResourceUpdated` already swallows closed-transport errors, so
  // the remaining subscribers keep receiving updates.
  // ponytail: no per-subscription id in the SDK unsubscribe contract, so we
  // ref-count by URI, not by callback identity. If a same client re-subscribes
  // to the same URI with a fresh closure (without unsubscribing first), the
  // count over-counts and the watcher leaks past the last unsubscribe — bounded
  // by MAX_WATCHERS; add per-subscription-id keying if that churn is observed.
  const activeCallbacks = new Map<string, Set<(uri: string) => void>>();
  const subscriberCounts = new Map<string, number>();
  const desiredState = new Map<string, 'subscribed' | 'unsubscribed' | 'subscribing'>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  let destroyed = false;

  const dropWatcher = (uri: string, watcher: FSWatcher): void => {
    const current = watchers.get(uri);
    if (current !== watcher) return;
    const timer = debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(uri);
    }
    watcher.close();
    watchers.delete(uri);
    activeCallbacks.delete(uri);
    subscriberCounts.delete(uri);
    desiredState.set(uri, 'unsubscribed');
  };

  const notifyAll = (uri: string): void => {
    const callbacks = activeCallbacks.get(uri);
    if (!callbacks || callbacks.size === 0) return;
    const existing = debounceTimers.get(uri);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(uri);
      const cbs = activeCallbacks.get(uri);
      if (!cbs) return;
      // One debounce timer per URI — fan out to every subscriber inside it, so
      // a burst of changes still fires one notification round per URI, not per
      // subscriber.
      for (const cb of cbs) {
        try {
          cb(uri);
        } catch (err) {
          Logger.warn(`Notify callback error for ${uri}: ${formatUnknownErrorMessage(err)}`);
        }
      }
    }, 50);
    timer.unref();
    debounceTimers.set(uri, timer);
  };

  return {
    hasWatcher: (uri: string): boolean => watchers.has(uri),

    isAtCap: (): boolean => watchers.size >= MAX_WATCHERS,

    /** Live watcher count, for pre-checking a batched listen against remaining capacity. */
    size: (): number => watchers.size,

    /** The registry was destroyed, or this uri was unsubscribed, mid-await. */
    isStale: (uri: string): boolean => destroyed || desiredState.get(uri) === 'unsubscribed',

    startSubscribe(uri: string): void {
      desiredState.set(uri, 'subscribing');
    },

    addCallback(uri: string, notify: (uri: string) => void): void {
      let callbacks = activeCallbacks.get(uri);
      if (!callbacks) {
        callbacks = new Set();
        activeCallbacks.set(uri, callbacks);
      }
      // Only count a genuinely new subscriber; a duplicate add of the same
      // closure (idempotent re-subscribe) must not inflate the ref count.
      if (!callbacks.has(notify)) {
        subscriberCounts.set(uri, (subscriberCounts.get(uri) ?? 0) + 1);
      }
      callbacks.add(notify);
      desiredState.set(uri, 'subscribed');
    },

    attach(uri: string, resolvedPath: string): boolean {
      try {
        // Watch directories recursively (children included) and files as-is.
        // `fs.watch` async errors arrive via the 'error' event below, not as a
        // sync throw, so no recursive-fallback try/catch is needed here — the
        // outer catch handles sync throws (inotify exhaustion, path-race).
        // `{ recursive: true }` is honored on macOS, Windows, and — since Node
        // 20.13 — Linux; `engines.node` is >=24, so all three are covered.
        const recursive = statSync(resolvedPath).isDirectory();
        const watcher = watch(resolvedPath, recursive ? { recursive: true } : undefined, () => {
          notifyAll(uri);
        });
        watcher.on('error', (err: Error) => {
          Logger.warn(`Watcher error for ${uri}: ${err.message}`);
          dropWatcher(uri, watcher);
        });
        watchers.set(uri, watcher);
        return true;
      } catch (err) {
        Logger.error(`Failed to create watcher for ${uri}: ${formatUnknownErrorMessage(err)}`);
        return false;
      }
    },

    remove(uri: string): void {
      // Ref-count by URI: only tear down the shared watcher when the last
      // subscriber leaves. While others remain, the departed subscriber's
      // closure lingers (see the activeCallbacks comment above) and the watcher
      // stays live so the remaining subscribers keep receiving updates.
      const remaining = (subscriberCounts.get(uri) ?? 0) - 1;
      if (remaining > 0) {
        subscriberCounts.set(uri, remaining);
        return;
      }
      subscriberCounts.delete(uri);
      desiredState.set(uri, 'unsubscribed');
      activeCallbacks.delete(uri);
      const timer = debounceTimers.get(uri);
      if (timer) {
        clearTimeout(timer);
        debounceTimers.delete(uri);
      }
      const watcher = watchers.get(uri);
      if (watcher) {
        dropWatcher(uri, watcher);
      }
    },

    destroy(): void {
      destroyed = true;
      for (const timer of debounceTimers.values()) {
        clearTimeout(timer);
      }
      debounceTimers.clear();
      for (const watcher of watchers.values()) {
        try {
          watcher.close();
        } catch {
          /* ignore close errors so all watchers are attempted */
        }
      }
      watchers.clear();
      activeCallbacks.clear();
      subscriberCounts.clear();
      desiredState.clear();
    },
  };
}

export type WatcherRegistry = ReturnType<typeof createWatcherRegistry>;
