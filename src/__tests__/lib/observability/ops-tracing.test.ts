import * as diagnosticsChannel from 'node:diagnostics_channel';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { globEntries } from '../../../lib/file-operations/glob-engine.js';
import type { GlobEntriesOptions } from '../../../lib/file-operations/glob-engine.js';
import { withFileOpsFixture } from '../fixtures/file-ops-hooks.js';

const restoreEnv = (key: string, previous: string | undefined): void => {
  if (previous === undefined) {
    Reflect.deleteProperty(process.env, key);
    return;
  }
  process.env[key] = previous;
};

void describe('ops tracing', () => {
  withFileOpsFixture((getTestDir) => {
    void it('publishes tracing events when diagnostics enabled and subscribed', async () => {
      const previousEnabled = process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS;
      const previousDetail = process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS_DETAIL;
      process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS = '1';
      process.env.FILESYSTEM_CONTEXT_DIAGNOSTICS_DETAIL = '0';

      const publishedStart: unknown[] = [];
      const publishedEnd: unknown[] = [];
      const onStart = (message: unknown): void => {
        publishedStart.push(message);
      };
      const onEnd = (message: unknown): void => {
        publishedEnd.push(message);
      };

      diagnosticsChannel.subscribe(
        'tracing:filesystem-context:ops:start',
        onStart
      );
      diagnosticsChannel.subscribe('tracing:filesystem-context:ops:end', onEnd);

      try {
        const options: GlobEntriesOptions = {
          cwd: getTestDir(),
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

        let count = 0;
        for await (const entry of globEntries(options)) {
          assert.ok(typeof entry.path === 'string');
          count += 1;
        }
        assert.ok(count > 0);

        const startEvents = publishedStart.filter(
          (value): value is { op?: unknown } =>
            typeof value === 'object' && value !== null
        );
        const endEvents = publishedEnd.filter(
          (value): value is { op?: unknown } =>
            typeof value === 'object' && value !== null
        );

        assert.ok(startEvents.some((event) => event.op === 'globEntries'));
        assert.ok(endEvents.some((event) => event.op === 'globEntries'));
      } finally {
        diagnosticsChannel.unsubscribe(
          'tracing:filesystem-context:ops:start',
          onStart
        );
        diagnosticsChannel.unsubscribe(
          'tracing:filesystem-context:ops:end',
          onEnd
        );
        restoreEnv('FILESYSTEM_CONTEXT_DIAGNOSTICS', previousEnabled);
        restoreEnv('FILESYSTEM_CONTEXT_DIAGNOSTICS_DETAIL', previousDetail);
      }
    });
  });
});
