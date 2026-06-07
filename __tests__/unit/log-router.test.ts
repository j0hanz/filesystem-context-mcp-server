import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import {
  Logger,
  type LoggingLevel,
  LogRouter,
  type LogSender,
  type LogTarget,
  withSession,
} from '../../src/core/observability.js';

interface RecordedLog {
  level: LoggingLevel;
  data: string;
}

function makeRecordingTarget(): {
  target: LogTarget;
  records: RecordedLog[];
} {
  const records: RecordedLog[] = [];
  const fakeSender: LogSender = {
    async send(level: LoggingLevel, message: string): Promise<void> {
      records.push({ level, data: message });
    },
  };

  return {
    records,
    target: {
      sender: fakeSender,
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

  it('routes events with a sessionId to the matching session target', async () => {
    const router = LogRouter.global();
    const stdio = makeRecordingTarget();
    const sessionA = makeRecordingTarget();
    const sessionB = makeRecordingTarget();
    router.attachStdio(stdio.target);
    router.attachSession('A', sessionA.target);
    router.attachSession('B', sessionB.target);

    await withSession('A', async () => {
      Logger.notice('for A');
    });
    await withSession('B', async () => {
      Logger.warn('for B');
    });

    assert.equal(sessionA.records.length, 1);
    assert.equal(sessionA.records[0]?.level, 'notice');
    assert.equal(sessionB.records.length, 1);
    assert.equal(sessionB.records[0]?.level, 'warning');
    assert.equal(stdio.records.length, 0);
  });

  it('detachSession stops routing for that session id', async () => {
    const router = LogRouter.global();
    const session = makeRecordingTarget();
    router.attachSession('A', session.target);
    router.detachSession('A');

    await withSession('A', async () => {
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
