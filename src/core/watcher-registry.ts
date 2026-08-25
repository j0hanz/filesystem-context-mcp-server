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
  // A URI may have several notification sinks and several independent leases.
  // Callback identity and lifetime are intentionally separate: the HTTP leg
  // uses one stable bus-publishing callback for every listen stream, while each
  // stream still owns one lease that must be released on close.
  // ponytail: no per-subscription id in the SDK unsubscribe contract, so we
  // ref-count by URI. A departed direct-notification callback can linger until
  // the final lease ends; sends to a closed transport already fail harmlessly.
  // The count outlives the watcher (see `dropWatcher`), so a URI whose watcher
  // errored keeps one map entry per still-unreleased lease until they drain —
  // no watcher slot, just bookkeeping. Per-subscription-id keying retires both
  // this and the unsubscribe-by-URI over-release if that churn is observed.
  const activeCallbacks = new Map<string, Set<(uri: string) => void>>();
  const subscriberCounts = new Map<string, number>();
  const desiredState = new Map<string, 'subscribed' | 'unsubscribed' | 'subscribing'>();
  const debounceTimers = new Map<string, NodeJS.Timeout>();
  let destroyed = false;

  // 'unsubscribed' exists only to abort a subscribe that is mid-await
  // (isStale). If no subscribe is in flight, keep no entry at all: a lingering
  // 'unsubscribed' would permanently block the modern attach path (which never
  // calls startSubscribe) and leak one map entry per URI ever watched. This
  // must be idempotent: remove()'s teardown branch calls this directly and
  // then unconditionally calls dropWatcher (which also calls this) for the
  // same uri — the second call must not clobber what the first one set.
  const settleDesiredState = (uri: string): void => {
    const current = desiredState.get(uri);
    if (current === 'subscribing') {
      desiredState.set(uri, 'unsubscribed');
    } else if (current !== 'unsubscribed') {
      desiredState.delete(uri);
    }
  };

  // Tears down the watcher itself, NOT the ref-count. The 'error' event calls
  // this with leases still outstanding: clearing the count there would let the
  // next release from one of those leases decrement from zero and drop a
  // watcher a later subscriber re-established for the same URI. `drop` below is
  // the only path that ends leases, and it is the only one that clears them.
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
    settleDesiredState(uri);
  };

  /** The last lease ended: drop the watcher and every trace of the URI. */
  const drop = (uri: string): void => {
    const timer = debounceTimers.get(uri);
    if (timer) {
      clearTimeout(timer);
      debounceTimers.delete(uri);
    }
    const watcher = watchers.get(uri);
    if (watcher) dropWatcher(uri, watcher);
    activeCallbacks.delete(uri);
    subscriberCounts.delete(uri);
    settleDesiredState(uri);
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

    /**
     * A subscribe that declared intent and then failed — bad URI, unvalidatable
     * path, cap, fs.watch refusal — drops the entry entirely. Not
     * `settleDesiredState`: that maps 'subscribing' onto 'unsubscribed' to abort
     * an attach still mid-await, and a *finished* failure leaving 'unsubscribed'
     * behind would make `isStale` true forever, so the modern attach path (which
     * never calls `startSubscribe`) could never watch this uri again. Only
     * clears its own 'subscribing' — a concurrent unsubscribe that already set
     * 'unsubscribed' still wins.
     */
    cancelSubscribe(uri: string): void {
      if (desiredState.get(uri) === 'subscribing') desiredState.delete(uri);
    },

    addCallback(uri: string, notify: (uri: string) => void): void {
      let callbacks = activeCallbacks.get(uri);
      if (!callbacks) {
        callbacks = new Set();
        activeCallbacks.set(uri, callbacks);
      }
      callbacks.add(notify);
      desiredState.set(uri, 'subscribed');
    },

    retain(uri: string): void {
      subscriberCounts.set(uri, (subscriberCounts.get(uri) ?? 0) + 1);
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
        // Two attaches that both cleared `hasWatcher` before either finished
        // validating land here for the same uri. Keep the one already wired to
        // the callback set and close this one — overwriting the map entry would
        // strand the first watcher's fd with nothing left holding a reference.
        if (watchers.has(uri)) {
          watcher.close();
          return true;
        }
        watchers.set(uri, watcher);
        return true;
      } catch (err) {
        Logger.error(`Failed to create watcher for ${uri}: ${formatUnknownErrorMessage(err)}`);
        return false;
      }
    },

    /**
     * Ref-count by URI: only tear down the shared watcher when the last lease
     * ends. Callback identity is independent from this count. A release with no
     * lease outstanding (a rolled-back attach) drops the watcher outright.
     */
    release(uri: string): void {
      const remaining = (subscriberCounts.get(uri) ?? 0) - 1;
      if (remaining > 0) {
        subscriberCounts.set(uri, remaining);
        return;
      }
      drop(uri);
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
