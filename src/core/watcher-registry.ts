import type { FSWatcher } from 'node:fs';
import { watch } from 'node:fs';

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
  const activeCallbacks = new Map<string, (uri: string) => void>();
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
    desiredState.set(uri, 'unsubscribed');
  };

  const notifyAll = (uri: string): void => {
    if (!activeCallbacks.has(uri)) return;
    const existing = debounceTimers.get(uri);
    if (existing) {
      clearTimeout(existing);
    }
    const timer = setTimeout(() => {
      debounceTimers.delete(uri);
      const cb = activeCallbacks.get(uri);
      if (!cb) return;
      try {
        cb(uri);
      } catch (err) {
        Logger.warn(`Notify callback error for ${uri}: ${formatUnknownErrorMessage(err)}`);
      }
    }, 50);
    timer.unref();
    debounceTimers.set(uri, timer);
  };

  return {
    hasWatcher: (uri: string): boolean => watchers.has(uri),

    isAtCap: (): boolean => watchers.size >= MAX_WATCHERS,

    /** The registry was destroyed, or this uri was unsubscribed, mid-await. */
    isStale: (uri: string): boolean => destroyed || desiredState.get(uri) === 'unsubscribed',

    startSubscribe(uri: string): void {
      desiredState.set(uri, 'subscribing');
    },

    addCallback(uri: string, notify: (uri: string) => void): void {
      activeCallbacks.set(uri, notify);
      desiredState.set(uri, 'subscribed');
    },

    attach(uri: string, resolvedPath: string): boolean {
      try {
        const watcher = watch(resolvedPath, () => {
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
      desiredState.clear();
    },
  };
}

export type WatcherRegistry = ReturnType<typeof createWatcherRegistry>;
