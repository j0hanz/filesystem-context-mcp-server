// __tests__/unit/log-router.test.ts
import type { LoggingLevel, McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  Logger,
  LogRouter,
  type LogTarget,
  SessionContext,
} from '../../src/lib/logger.js';

interface RecordedLog {
  level: LoggingLevel;
  data: string;
}

function makeRecordingTarget(): {
  target: LogTarget;
  records: RecordedLog[];
} {
  const records: RecordedLog[] = [];
  const fakeServer = {
    server: {
      getClientCapabilities(): unknown {
        return { logging: true };
      },
    },
    sendLoggingMessage(params: {
      level: LoggingLevel;
      data: unknown;
    }): Promise<void> {
      records.push({ level: params.level, data: String(params.data) });
      return Promise.resolve();
    },
  } as unknown as McpServer;

  return {
    records,
    target: {
      server: fakeServer,
      loggingState: { minimumLevel: 'debug' },
    },
  };
}

describe('LogRouter', () => {
  afterEach(() => {
    LogRouter.global().reset();
  });

  it('global() returns a singleton instance', () => {
    const a = LogRouter.global();
    const b = LogRouter.global();
    assert.strictEqual(a, b);
  });

  it('routes events without a sessionId to the stdio target', () => {
    const router = LogRouter.global();
    const { target, records } = makeRecordingTarget();
    router.attachStdio(target);

    Logger.info('hello stdio');

    assert.equal(records.length, 1);
    assert.equal(records[0]?.level, 'info');
    assert.match(records[0]?.data ?? '', /hello stdio/u);
  });

  it('attachStdio is idempotent — second call does not replace the first', () => {
    const router = LogRouter.global();
    const first = makeRecordingTarget();
    const second = makeRecordingTarget();
    router.attachStdio(first.target);
    router.attachStdio(second.target);

    Logger.info('hi');
    assert.equal(first.records.length, 1);
    assert.equal(second.records.length, 0);
  });

  it('routes events with a sessionId to the matching session target', () => {
    const router = LogRouter.global();
    const stdio = makeRecordingTarget();
    const sessionA = makeRecordingTarget();
    const sessionB = makeRecordingTarget();
    router.attachStdio(stdio.target);
    router.attachSession('A', sessionA.target);
    router.attachSession('B', sessionB.target);

    SessionContext.run({ sessionId: 'A' }, () => {
      Logger.notice('for A');
    });
    SessionContext.run({ sessionId: 'B' }, () => {
      Logger.warn('for B');
    });

    assert.equal(sessionA.records.length, 1);
    assert.equal(sessionA.records[0]?.level, 'notice');
    assert.equal(sessionB.records.length, 1);
    assert.equal(sessionB.records[0]?.level, 'warning');
    assert.equal(stdio.records.length, 0);
  });

  it('detachSession stops routing for that session id', () => {
    const router = LogRouter.global();
    const session = makeRecordingTarget();
    router.attachSession('A', session.target);
    router.detachSession('A');

    SessionContext.run({ sessionId: 'A' }, () => {
      Logger.info('orphaned');
    });

    assert.equal(session.records.length, 0);
  });

  it('detachStdio removes fallback routing', () => {
    const router = LogRouter.global();
    const stdio = makeRecordingTarget();
    router.attachStdio(stdio.target);
    router.detachStdio();

    Logger.info('no listener');
    assert.equal(stdio.records.length, 0);
  });
});
