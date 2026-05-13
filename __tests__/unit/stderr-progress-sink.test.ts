import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import type { ProgressCtx } from '../../src/core/fmt.js';
import { StderrProgressSink } from '../../src/core/observability.js';

const ANSI_ESCAPE_RE = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');

describe('StderrProgressSink', () => {
  const ctx: ProgressCtx = { label: 'Search', subject: 'async.*await', scope: 'src/' };

  describe('when isTTY is false', () => {
    let origIsTTY: boolean | undefined;
    before(() => {
      origIsTTY = process.stderr.isTTY;
      (process.stderr as NodeJS.WriteStream & { isTTY: boolean }).isTTY = false;
    });
    after(() => {
      (process.stderr as NodeJS.WriteStream & { isTTY: boolean }).isTTY = origIsTTY === true;
    });

    it('emits nothing to stderr', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, () => lines.push('written'));
      sink.emit({ kind: 'tick', current: 45, total: 500, message: 'Search: async.*await  src/' });
      assert.equal(lines.length, 0);
    });
  });

  describe('when isTTY is true', () => {
    let origIsTTY: boolean | undefined;
    before(() => {
      origIsTTY = process.stderr.isTTY;
      (process.stderr as NodeJS.WriteStream & { isTTY: boolean }).isTTY = true;
    });
    after(() => {
      (process.stderr as NodeJS.WriteStream & { isTTY: boolean }).isTTY = origIsTTY === true;
    });

    it('emits a tick line for kind=tick with current > 0', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.emit({ kind: 'tick', current: 45, total: 500, message: '' });
      assert.equal(lines.length, 1);
      assert.ok(lines[0]?.includes('45/500'), `expected "45/500" in: ${lines[0]}`);
    });

    it('emits a start line for kind=tick with current === 0', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.emit({ kind: 'tick', current: 0, message: 'Search: async.*await  src/' });
      assert.equal(lines.length, 1);
      // start symbol → is in the stripped text
      const stripped = lines[0]?.replace(ANSI_ESCAPE_RE, '') ?? '';
      assert.ok(stripped.startsWith('→'), `expected → symbol, got: ${stripped}`);
    });

    it('emits a done line for kind=complete', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.emit({ kind: 'complete', current: 500, message: 'Search: async.*await  src/' });
      const stripped = lines[0]?.replace(ANSI_ESCAPE_RE, '') ?? '';
      assert.ok(stripped.startsWith('✓'), `expected ✓ symbol, got: ${stripped}`);
    });

    it('emits a fail line for kind=fail', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.emit({ kind: 'fail', current: 0, message: '', error: new Error('EACCES') });
      const stripped = lines[0]?.replace(ANSI_ESCAPE_RE, '') ?? '';
      assert.ok(stripped.startsWith('✗'), `expected ✗ symbol`);
      assert.ok(stripped.includes('EACCES'), `expected EACCES in: ${stripped}`);
    });

    it('updateCtx merges partial ctx used on next emit', () => {
      const lines: string[] = [];
      const sink = new StderrProgressSink(ctx, (line) => lines.push(line));
      sink.updateCtx({ detail: '23 matches · 8 files' });
      sink.emit({ kind: 'complete', current: 500, message: '' });
      assert.ok(lines[0]?.includes('23 matches · 8 files'), `expected detail in: ${lines[0]}`);
    });
  });
});
