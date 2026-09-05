import { basename } from 'node:path';
import { stripVTControlCharacters, styleText } from 'node:util';

export interface ProgressCtx {
  label: string;
  subject?: string;
  scope?: string;
  current?: number;
  total?: number;
  detail?: string;
  error?: string;
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

export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${String(count)} ${count === 1 ? singular : plural}`;
}

/**
 * Short label for a path in summary text. `basename` returns '' for a root
 * (`C:\`, `/`) and for a trailing-slash path, which rendered as a bare
 * separator in the per-path summaries, so fall back to the full path.
 */
export function pathLabel(path: string): string {
  return basename(path) || path;
}

/** Names past this point are noise in a summary line; structuredContent holds them all. */
const MAX_ROSTER_ITEMS = 20;

/**
 * Join a per-path summary roster, capped. A 1000-path delete would otherwise
 * name every entry in the text block that `structuredContent` already carries
 * in full.
 */
export function joinRoster(items: readonly string[], separator = ' · '): string {
  if (items.length <= MAX_ROSTER_ITEMS) return items.join(separator);
  const shown = items.slice(0, MAX_ROSTER_ITEMS).join(separator);
  return `${shown}${separator}+${String(items.length - MAX_ROSTER_ITEMS)} more`;
}

export function truncateProgressPattern(pattern: string, maxLength = 40): string {
  return pattern.length <= maxLength ? pattern : `${pattern.slice(0, maxLength)}…`;
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
