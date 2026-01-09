import * as diagnosticsChannel from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { globEntries } from '../../../lib/file-operations/glob-engine.js';
import type { GlobEntriesOptions } from '../../../lib/file-operations/glob-engine.js';
import {
  enableDiagnosticsEnv,
  restoreDiagnosticsEnv,
} from '../../shared/diagnostics-env.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

interface OpsTracingSubscription {
  publishedStart: unknown[];
  publishedEnd: unknown[];
  unsubscribe: () => void;
}

function subscribeOpsTracing(): OpsTracingSubscription {
  const publishedStart: unknown[] = [];
  const publishedEnd: unknown[] = [];
  const onStart = (message: unknown): void => {
    publishedStart.push(message);
  };
  const onEnd = (message: unknown): void => {
    publishedEnd.push(message);
  };

  diagnosticsChannel.subscribe('tracing:fs-context:ops:start', onStart);
  diagnosticsChannel.subscribe('tracing:fs-context:ops:end', onEnd);

  return {
    publishedStart,
    publishedEnd,
    unsubscribe: () => {
      diagnosticsChannel.unsubscribe('tracing:fs-context:ops:start', onStart);
      diagnosticsChannel.unsubscribe('tracing:fs-context:ops:end', onEnd);
    },
  };
}

function createGlobOptions(testDir: string): GlobEntriesOptions {
  return {
    cwd: testDir,
    pattern: '**/*',
    excludePatterns: [],
    includeHidden: false,
    baseNameMatch: false,
    caseSensitiveMatch: true,
    maxDepth: undefined,
    followSymbolicLinks: false,
    onlyFiles: false,
    stats: false,
    suppressErrors: undefined,
  };
}

async function collectGlobEntriesCount(
  options: GlobEntriesOptions
): Promise<number> {
  let count = 0;
  for await (const entry of globEntries(options)) {
    assert.ok(typeof entry.path === 'string');
    count += 1;
  }
  return count;
}

function filterOpEvents(values: unknown[]): { op?: unknown }[] {
  return values.filter(
    (value): value is { op?: unknown } =>
      typeof value === 'object' && value !== null
  );
}

function assertGlobEntriesTraced(
  startEvents: { op?: unknown }[],
  endEvents: { op?: unknown }[]
): void {
  assert.ok(startEvents.some((event) => event.op === 'globEntries'));
  assert.ok(endEvents.some((event) => event.op === 'globEntries'));
}

function registerOpsTracingTests(getTestDir: () => string): void {
  void it('publishes tracing events when diagnostics enabled and subscribed', async () => {
    const envSnapshot = enableDiagnosticsEnv();
    const subscription = subscribeOpsTracing();

    try {
      const options = createGlobOptions(getTestDir());
      const count = await collectGlobEntriesCount(options);
      assert.ok(count > 0);

      const startEvents = filterOpEvents(subscription.publishedStart);
      const endEvents = filterOpEvents(subscription.publishedEnd);
      assertGlobEntriesTraced(startEvents, endEvents);
    } finally {
      subscription.unsubscribe();
      restoreDiagnosticsEnv(envSnapshot);
    }
  });
}

void describe('ops tracing', () => {
  withFileOpsFixture((getTestDir) => {
    registerOpsTracingTests(getTestDir);
  });
});
