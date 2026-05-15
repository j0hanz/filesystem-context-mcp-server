// src/core/fmt.ts

const ESC = '\x1b[';
const R = `${ESC}0m`; // reset
const B = `${ESC}1m`; // bold
const DIM = `${ESC}2m`; // dim
const GRN = `${ESC}32m`; // green
const RED = `${ESC}31m`; // red
const CYN = `${ESC}36m`; // cyan
const GRY = `${ESC}90m`; // gray

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
