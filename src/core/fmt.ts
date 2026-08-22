import { stripVTControlCharacters, styleText } from 'node:util';

import { GIB, KIB, MIB } from './util.js';

const PLUS_PATTERN = /\+(\d+)/g;
const MINUS_PATTERN = /-(\d+)/g;
const MS_PER_SECOND = 1000;

export interface ProgressCtx {
  label: string;
  subject?: string;
  scope?: string;
  current?: number;
  total?: number;
  detail?: string;
  error?: string;
  durationMs?: number;
}

export type Phase = 'start' | 'tick' | 'done' | 'fail';

function buildBody(ctx: ProgressCtx, phase: Phase): string {
  const items: string[] = [];
  if (ctx.subject) {
    items.push(ctx.subject);
  }

  switch (phase) {
    case 'start':
      if (ctx.scope) {
        items.push(ctx.scope);
      }
      break;
    case 'tick':
      if (ctx.current !== undefined && ctx.total !== undefined) {
        items.push(`${ctx.current}/${ctx.total}`);
      } else if (ctx.current !== undefined) {
        items.push(String(ctx.current));
      }
      break;
    case 'done':
      if (ctx.scope) {
        items.push(ctx.scope);
      }
      if (ctx.detail) {
        items.push(ctx.detail);
      }
      break;
    case 'fail':
      if (ctx.error) {
        items.push(ctx.error);
      }
      break;
  }

  return items.join(' · ');
}

export function plainMessage(phase: Phase, ctx: ProgressCtx): string {
  const body = buildBody(ctx, phase);
  return body ? `${ctx.label}: ${body}` : `${ctx.label}:`;
}

const SYMBOL_ANSI = {
  start: styleText(['cyan', 'dim'], '→'),
  tick: styleText('gray', '·'),
  done: styleText('green', '✓'),
  fail: styleText('red', '✗'),
} satisfies Record<Phase, string>;

function colorizeStats(text: string): string {
  return text
    .replace(PLUS_PATTERN, styleText('green', '+$1'))
    .replace(MINUS_PATTERN, styleText('red', '-$1'));
}

function formatDuration(ms: number): string {
  return ms < MS_PER_SECOND ? `${Math.round(ms)}ms` : `${(ms / MS_PER_SECOND).toFixed(1)}s`;
}

export function ansiLine(phase: Phase, ctx: ProgressCtx): string {
  const body = buildBody(ctx, phase);
  const label = styleText('bold', `${ctx.label}:`);
  const content = body ? `${label} ${colorizeStats(body)}` : label;

  if (phase === 'done' || phase === 'fail') {
    return content;
  }

  const timing =
    ctx.durationMs !== undefined ? `  ${styleText('dim', formatDuration(ctx.durationMs))}` : '';
  return `${SYMBOL_ANSI[phase]}  ${content}${timing}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '0 B';
  }
  if (bytes < KIB) {
    return `${bytes} B`;
  }
  if (bytes < MIB) {
    return `${(bytes / KIB).toFixed(1)} KB`;
  }
  if (bytes < GIB) {
    return `${(bytes / MIB).toFixed(1)} MB`;
  }
  return `${(bytes / GIB).toFixed(1)} GB`;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

export function truncateProgressPattern(pattern: string, maxLength = 40): string {
  if (pattern.length <= maxLength) {
    return pattern;
  }

  let preview = pattern;
  if (pattern.includes('|')) {
    const [first = '', second] = pattern.split('|');
    preview = second !== undefined ? `${first}|${second}` : first;
  }

  const sliced = preview.length <= maxLength ? preview : preview.slice(0, maxLength);
  return `${sliced}…`;
}

// ---------------------------------------------------------------------------
// CLI color helpers
// ---------------------------------------------------------------------------

function isColorEnabled(stream: { isTTY?: boolean } = process.stdout): boolean {
  return stream.isTTY === true && !process.env['NO_COLOR'];
}

export function padEndVisible(s: string, width: number): string {
  const visible = stripVTControlCharacters(s).length;
  return visible >= width ? s : s + ' '.repeat(width - visible);
}

type Style = Parameters<typeof styleText>[0];

/** Same palette as above, but only when the target stream wants color. */
function tint(format: Style, text: string, stream?: { isTTY?: boolean }): string {
  return isColorEnabled(stream) ? styleText(format, text) : text;
}

export const cliFmt = {
  bold: (t: string) => tint('bold', t),
  dim: (t: string) => tint('dim', t),
  cyan: (t: string) => tint('cyan', t),
  yellow: (t: string) => tint('yellow', t),
  flag: (t: string) => tint('green', t),
  placeholder: (t: string) => tint('yellow', t),
  section: (t: string) => tint(['cyan', 'bold'], t),
  bool: (v: boolean) => (v ? tint('green', 'true') : tint('red', 'false')),
};
