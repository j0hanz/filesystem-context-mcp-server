import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ansiLine, plainMessage } from '../../src/core/fmt.js';

const ANSI_ESCAPE_RE = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');

describe('plainMessage', () => {
  it('start: label only', () => {
    assert.equal(plainMessage('start', { label: 'Read' }), 'Read:');
  });

  it('start: label + subject', () => {
    assert.equal(plainMessage('start', { label: 'Read', subject: 'tasks.ts' }), 'Read: tasks.ts');
  });

  it('start: label + subject + scope', () => {
    assert.equal(
      plainMessage('start', { label: 'Search', subject: 'async.*await', scope: 'src/' }),
      'Search: async.*await · src/',
    );
  });

  it('tick: subject + current/total', () => {
    assert.equal(
      plainMessage('tick', { label: 'Search', subject: 'async.*await', current: 45, total: 500 }),
      'Search: async.*await · 45/500',
    );
  });

  it('tick: current only (no total)', () => {
    assert.equal(
      plainMessage('tick', { label: 'Search', subject: 'async.*await', current: 45 }),
      'Search: async.*await · 45',
    );
  });

  it('tick: no subject, no current — label only', () => {
    assert.equal(plainMessage('tick', { label: 'Hash' }), 'Hash:');
  });

  it('done: subject + scope + detail', () => {
    assert.equal(
      plainMessage('done', {
        label: 'Search',
        subject: 'async.*await',
        scope: 'src/',
        detail: '23 matches · 8 files',
      }),
      'Search: async.*await · src/ · 23 matches · 8 files',
    );
  });

  it('done: subject only (no scope, no detail)', () => {
    assert.equal(
      plainMessage('done', { label: 'Edit', subject: 'tasks.ts+2-2 · index.ts+50-25' }),
      'Edit: tasks.ts+2-2 · index.ts+50-25',
    );
  });

  it('done: scope omitted when undefined', () => {
    assert.equal(
      plainMessage('done', { label: 'Read', subject: 'tasks.ts', detail: '2.3 KB' }),
      'Read: tasks.ts · 2.3 KB',
    );
  });

  it('fail: subject + error', () => {
    assert.equal(
      plainMessage('fail', {
        label: 'Edit',
        subject: 'tasks.ts',
        error: 'EACCES: permission denied',
      }),
      'Edit: tasks.ts · EACCES: permission denied',
    );
  });

  it('fail: no error — label + subject only', () => {
    assert.equal(plainMessage('fail', { label: 'Edit', subject: 'tasks.ts' }), 'Edit: tasks.ts');
  });
});

describe('Read progress subject format', () => {
  it('line range is embedded in subject as name:start-end', () => {
    const msg = plainMessage('done', {
      label: 'Read',
      subject: 'tasks.ts:10-50',
      detail: '2.3 KB',
    });
    assert.equal(msg, 'Read: tasks.ts:10-50 · 2.3 KB');
  });

  it('line range with open end uses ellipsis', () => {
    const msg = plainMessage('done', {
      label: 'Read',
      subject: 'tasks.ts:10-…',
      detail: '1.1 KB',
    });
    assert.equal(msg, 'Read: tasks.ts:10-… · 1.1 KB');
  });
});

describe('Read progressDone multi-file format', () => {
  it('multi-file detail is total bytes only (count is in subject)', () => {
    const msg = plainMessage('done', {
      label: 'Read',
      subject: '3 files',
      detail: '143 KB',
    });
    assert.equal(msg, 'Read: 3 files · 143 KB');
  });
});

describe('Edit done format', () => {
  it('single-file: scope is absent when subject has diff stats', () => {
    const msg = plainMessage('done', {
      label: 'Edit',
      subject: 'tasks.ts+2-2',
      scope: undefined,
    });
    assert.equal(msg, 'Edit: tasks.ts+2-2');
  });
});

describe('Hash done format', () => {
  it('shows algo:8chars… for a sha256 hash', () => {
    const msg = plainMessage('done', {
      label: 'Hash',
      subject: 'large-file.bin',
      detail: 'sha256:a1b2c3d4…',
    });
    assert.equal(msg, 'Hash: large-file.bin · sha256:a1b2c3d4…');
  });
});

describe('Stat done format', () => {
  it('single directory: shows total entry count', () => {
    const msg = plainMessage('done', {
      label: 'Stat',
      subject: 'src/core/',
      detail: '47 entries',
    });
    assert.equal(msg, 'Stat: src/core/ · 47 entries');
  });

  it('empty directory: omits entry count detail when zero', () => {
    // progressDone returns {} when total is 0, so ctx has no detail
    const msg = plainMessage('done', {
      label: 'Stat',
      subject: 'empty-dir/',
      detail: undefined,
    });
    assert.equal(msg, 'Stat: empty-dir/');
  });

  it('single-path mode: no entry count when fileCount/dirCount undefined', () => {
    // Single-path results don't have fileCount/dirCount, so returns {}
    const msg = plainMessage('done', {
      label: 'Stat',
      subject: 'file.txt',
    });
    assert.equal(msg, 'Stat: file.txt');
  });
});

describe('List done format', () => {
  it('entry count has no "included" qualifier', () => {
    const msg = plainMessage('done', {
      label: 'List',
      subject: 'src/tools/',
      detail: '23 entries',
    });
    assert.equal(msg, 'List: src/tools/ · 23 entries');
    // Verify "included" is absent
    assert.ok(!msg.includes('included'), 'expected no "included" in done line');
  });
});

describe('ansiLine', () => {
  // Strip ANSI codes for readable assertions
  const strip = (s: string): string => s.replace(ANSI_ESCAPE_RE, '');

  it('start symbol is →', () => {
    assert.ok(strip(ansiLine('start', { label: 'Read', subject: 'tasks.ts' })).startsWith('→'));
  });

  it('tick symbol is ·', () => {
    assert.ok(strip(ansiLine('tick', { label: 'Read', current: 3, total: 10 })).startsWith('·'));
  });

  it('done line starts with bold label, no symbol', () => {
    const raw = ansiLine('done', { label: 'Read', subject: 'tasks.ts' });
    const stripped = strip(raw);
    assert.ok(stripped.startsWith('Read:'), `expected label prefix "Read:", got: ${stripped}`);
    assert.ok(!stripped.startsWith('✓'), 'done line should not have symbol');
  });

  it('fail line starts with bold label, no symbol', () => {
    const raw = ansiLine('fail', { label: 'Edit', error: 'EACCES' });
    const stripped = strip(raw);
    assert.ok(stripped.startsWith('Edit:'), `expected label prefix "Edit:", got: ${stripped}`);
    assert.ok(!stripped.startsWith('✗'), 'fail line should not have symbol');
  });

  it('plain text is embedded in ansi output', () => {
    const plain = strip(ansiLine('done', { label: 'Read', subject: 'tasks.ts', detail: '2.3 KB' }));
    assert.ok(plain.includes('Read: tasks.ts · 2.3 KB'));
  });

  it('+N and -N patterns are wrapped in ANSI codes', () => {
    const raw = ansiLine('done', { label: 'Edit', subject: 'tasks.ts+2-2' });
    // +2 should have green ANSI, -2 should have red ANSI
    assert.ok(raw.includes('\x1b[32m+2\x1b[0m'), 'expected green +2');
    assert.ok(raw.includes('\x1b[31m-2\x1b[0m'), 'expected red -2');
  });

  it('durationMs rendered for start/tick but not done/fail', () => {
    // start phase should render timing
    const startRaw = ansiLine('start', { label: 'Read', subject: 'tasks.ts', durationMs: 89 });
    assert.ok(startRaw.includes('89ms'), 'start line should include duration');

    // done phase should NOT render timing
    const doneRaw = ansiLine('done', { label: 'Read', subject: 'f.ts', durationMs: 89 });
    assert.ok(!doneRaw.includes('89ms'), 'done line should not include duration');
  });

  it('durationMs over 1000ms formatted as seconds on start line', () => {
    const raw = ansiLine('start', { label: 'Read', subject: 'f.ts', durationMs: 2100 });
    assert.ok(raw.includes('2.1s'), 'start line should format duration as seconds');
  });

  it('durationMs absent — no timing suffix', () => {
    const raw = ansiLine('done', { label: 'Read', subject: 'f.ts' });
    assert.ok(!raw.includes('ms') && !raw.includes('s  '));
  });

  it('done line has no symbol prefix', () => {
    const raw = ansiLine('done', { label: 'Read', subject: 'tasks.ts' });
    const stripped = strip(raw);
    assert.ok(stripped.startsWith('Read:'), `expected "Read:" prefix, got: ${stripped}`);
    assert.ok(!stripped.startsWith('✓'), 'done line should not start with ✓ symbol');
  });

  it('fail line has no symbol prefix', () => {
    const raw = ansiLine('fail', { label: 'Edit', subject: 'tasks.ts', error: 'EACCES' });
    const stripped = strip(raw);
    assert.ok(stripped.startsWith('Edit:'), `expected "Edit:" prefix, got: ${stripped}`);
    assert.ok(!stripped.startsWith('✗'), 'fail line should not start with ✗ symbol');
  });

  it('done line: durationMs not rendered even when provided', () => {
    const raw = ansiLine('done', { label: 'Read', subject: 'f.ts', durationMs: 89 });
    const stripped = strip(raw);
    assert.ok(!stripped.includes('89ms'), 'done line should not include duration');
    assert.ok(
      stripped.includes('Read:') && stripped.includes('f.ts'),
      'done line should include label and subject',
    );
  });

  it('fail line: durationMs not rendered even when provided', () => {
    const raw = ansiLine('fail', {
      label: 'Edit',
      subject: 'tasks.ts',
      error: 'EACCES',
      durationMs: 150,
    });
    const stripped = strip(raw);
    assert.ok(!stripped.includes('150ms'), 'fail line should not include duration');
    assert.ok(
      stripped.includes('Edit:') && stripped.includes('EACCES'),
      'fail line should include label and error',
    );
  });
});
