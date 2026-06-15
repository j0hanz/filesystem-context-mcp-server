const ESC = '\x1b[';
const ANSI_RESET = `${ESC}0m`;
const ANSI_BOLD = `${ESC}1m`;
const ANSI_DIM = `${ESC}2m`;
const ANSI_GREEN = `${ESC}32m`;
const ANSI_RED = `${ESC}31m`;
const ANSI_CYAN = `${ESC}36m`;
const ANSI_GRAY = `${ESC}90m`;

const KIB = 1024;
const MIB = 1024 * 1024;
const GIB = 1024 * 1024 * 1024;

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
  start: `${ANSI_CYAN}${ANSI_DIM}→${ANSI_RESET}`,
  tick: `${ANSI_GRAY}·${ANSI_RESET}`,
  done: `${ANSI_GREEN}✓${ANSI_RESET}`,
  fail: `${ANSI_RED}✗${ANSI_RESET}`,
} satisfies Record<Phase, string>;

function colorizeStats(text: string): string {
  return text
    .replace(PLUS_PATTERN, `${ANSI_GREEN}+$1${ANSI_RESET}`)
    .replace(MINUS_PATTERN, `${ANSI_RED}-$1${ANSI_RESET}`);
}

function formatDuration(ms: number): string {
  return ms < MS_PER_SECOND ? `${Math.round(ms)}ms` : `${(ms / MS_PER_SECOND).toFixed(1)}s`;
}

export function ansiLine(phase: Phase, ctx: ProgressCtx): string {
  const body = buildBody(ctx, phase);
  const label = `${ANSI_BOLD}${ctx.label}:${ANSI_RESET}`;
  const content = body ? `${label} ${colorizeStats(body)}` : label;

  if (phase === 'done' || phase === 'fail') {
    return content;
  }

  const timing =
    ctx.durationMs !== undefined
      ? `  ${ANSI_DIM}${formatDuration(ctx.durationMs)}${ANSI_RESET}`
      : '';
  return `${SYMBOL_ANSI[phase]}  ${content}${timing}`;
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B';
  if (bytes < KIB) return `${bytes} B`;
  if (bytes < MIB) return `${(bytes / KIB).toFixed(1)} KB`;
  if (bytes < GIB) return `${(bytes / MIB).toFixed(1)} MB`;
  return `${(bytes / GIB).toFixed(1)} GB`;
}

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

export function truncateProgressPattern(pattern: string, maxLength = 40): string {
  if (pattern.length <= maxLength) return pattern;

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

const ANSI_STRIP_RE = new RegExp(String.raw`\x1b\[[0-9;]*m`, 'g');

function stripAnsi(s: string): string {
  return s.replace(ANSI_STRIP_RE, '');
}

export function padEndVisible(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  return visible >= width ? s : s + ' '.repeat(width - visible);
}

const ANSI_CODES = {
  bold: '1',
  dim: '2',
  green: '32',
  yellow: '33',
  cyan: '36',
  boldCyan: '1;36',
  red: '31',
} as const;

function applyAnsi(enabled: boolean, code: string, text: string): string {
  return enabled ? `${ESC}${code}m${text}${ANSI_RESET}` : text;
}

export const cliFmt = {
  bold: (t: string) => applyAnsi(isColorEnabled(), ANSI_CODES.bold, t),
  dim: (t: string) => applyAnsi(isColorEnabled(), ANSI_CODES.dim, t),
  cyan: (t: string) => applyAnsi(isColorEnabled(), ANSI_CODES.cyan, t),
  yellow: (t: string) => applyAnsi(isColorEnabled(), ANSI_CODES.yellow, t),
  green: (t: string) => applyAnsi(isColorEnabled(), ANSI_CODES.green, t),
  flag: (t: string) => applyAnsi(isColorEnabled(), ANSI_CODES.green, t),
  placeholder: (t: string) => applyAnsi(isColorEnabled(), ANSI_CODES.yellow, t),
  section: (t: string) => applyAnsi(isColorEnabled(), ANSI_CODES.boldCyan, t),
  pathStr: (t: string) => applyAnsi(isColorEnabled(), ANSI_CODES.cyan, t),
  bool: (v: boolean) => {
    const ok = isColorEnabled();
    return v ? applyAnsi(ok, ANSI_CODES.green, 'true') : applyAnsi(ok, ANSI_CODES.red, 'false');
  },
  success: (t: string) => `${applyAnsi(isColorEnabled(), ANSI_CODES.green, '✔')} ${t}`,
  stderrWarn: (t: string) =>
    isColorEnabled(process.stderr)
      ? `${applyAnsi(true, ANSI_CODES.yellow, '⚠')} Warning: ${t}`
      : `Warning: ${t}`,
};
