const ESC = '\x1b[';
const R = `${ESC}0m`;
const B = `${ESC}1m`;
const DIM = `${ESC}2m`;
const GRN = `${ESC}32m`;
const RED = `${ESC}31m`;
const CYN = `${ESC}36m`;
const GRY = `${ESC}90m`;

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
  if (ctx.subject) items.push(ctx.subject);

  switch (phase) {
    case 'start':
      if (ctx.scope) items.push(ctx.scope);
      break;
    case 'tick':
      if (ctx.current !== undefined && ctx.total !== undefined) {
        items.push(`${ctx.current}/${ctx.total}`);
      } else if (ctx.current !== undefined) {
        items.push(String(ctx.current));
      }
      break;
    case 'done':
      if (ctx.scope) items.push(ctx.scope);
      if (ctx.detail) items.push(ctx.detail);
      break;
    case 'fail':
      if (ctx.error) items.push(ctx.error);
      break;
  }

  return items.join(' · ');
}

export function plainMessage(phase: Phase, ctx: ProgressCtx): string {
  const body = buildBody(ctx, phase);
  return body ? `${ctx.label}: ${body}` : `${ctx.label}:`;
}

const SYMBOL_ANSI = {
  start: `${CYN}${DIM}→${R}`,
  tick: `${GRY}·${R}`,
  done: `${GRN}✓${R}`,
  fail: `${RED}✗${R}`,
} satisfies Record<Phase, string>;

function colorizeStats(text: string): string {
  return text.replace(PLUS_PATTERN, `${GRN}+$1${R}`).replace(MINUS_PATTERN, `${RED}-$1${R}`);
}

function formatDuration(ms: number): string {
  return ms < MS_PER_SECOND ? `${Math.round(ms)}ms` : `${(ms / MS_PER_SECOND).toFixed(1)}s`;
}

export function ansiLine(phase: Phase, ctx: ProgressCtx): string {
  const body = buildBody(ctx, phase);
  const label = `${B}${ctx.label}:${R}`;
  const content = body ? `${label} ${colorizeStats(body)}` : label;

  if (phase === 'done' || phase === 'fail') {
    return content;
  }

  const timing =
    ctx.durationMs !== undefined ? `  ${DIM}${formatDuration(ctx.durationMs)}${R}` : '';
  return `${SYMBOL_ANSI[phase]}  ${content}${timing}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  const KIB_LOCAL = 1024;
  const MIB_LOCAL = 1024 * 1024;
  const GIB_LOCAL = 1024 * 1024 * 1024;
  if (bytes < KIB_LOCAL) return `${bytes} B`;
  if (bytes < MIB_LOCAL) return `${(bytes / KIB_LOCAL).toFixed(1)} KB`;
  if (bytes < GIB_LOCAL) return `${(bytes / MIB_LOCAL).toFixed(1)} MB`;
  return `${(bytes / GIB_LOCAL).toFixed(1)} GB`;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

export function truncateProgressPattern(pattern: string, maxLength = 40): string {
  if (pattern.length <= maxLength) return pattern;
  if (pattern.includes('|')) {
    const segments = pattern.split('|');
    const first = segments[0] ?? '';
    const second = segments[1];
    const preview = second !== undefined ? `${first}|${second}` : first;
    return preview.length <= maxLength ? `${preview}…` : `${preview.slice(0, maxLength)}…`;
  }
  return `${pattern.slice(0, maxLength)}…`;
}
