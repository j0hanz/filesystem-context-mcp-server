import { z } from 'zod/v4';

import { ErrorCode } from '../config.js';

import type { Problem, ProblemIssue } from './problem.js';

export const DEFAULT_SUGGESTIONS: Readonly<
  Partial<Record<ErrorCode, string>>
> = {
  [ErrorCode.ACCESS_DENIED]: 'Run roots to list allowed directories.',
  [ErrorCode.NOT_FOUND]: 'Run ls or find to verify the path.',
  [ErrorCode.NOT_FILE]: 'Target is a directory, not a file.',
  [ErrorCode.NOT_DIRECTORY]: 'Target is a file, not a directory.',
  [ErrorCode.TOO_LARGE]: 'Use head/tail or line ranges to read partially.',
  [ErrorCode.TIMEOUT]: 'Reduce scope, depth, or maxResults.',
  [ErrorCode.INVALID_PATTERN]: 'Check syntax and escape special characters.',
  [ErrorCode.PERMISSION_DENIED]: 'Check OS file permissions.',
  [ErrorCode.SYMLINK_NOT_ALLOWED]: 'Symlink escapes allowed directories.',
};

function readSuggestionMeta(schema: z.ZodType | undefined): string | undefined {
  if (!schema) return undefined;
  const meta = z.globalRegistry.get(schema) as
    | { suggestion?: unknown }
    | undefined;
  if (meta && typeof meta.suggestion === 'string') return meta.suggestion;
  return undefined;
}

function descend(
  schema: z.ZodType,
  segment: string | number,
): z.ZodType | undefined {
  const def = (schema as unknown as { _def?: unknown })._def as
    | { shape?: Record<string, z.ZodType>; type?: z.ZodType }
    | undefined;
  if (!def) return undefined;
  if (
    typeof segment === 'string' &&
    def.shape !== undefined &&
    segment in def.shape
  ) {
    return def.shape[segment];
  }
  if (typeof segment === 'number' && def.type !== undefined) return def.type;
  return undefined;
}

function suggestionFromIssueMeta(
  schema: z.ZodType,
  issue: ProblemIssue,
): string | undefined {
  let cursor: z.ZodType | undefined = schema;
  const trail: (z.ZodType | undefined)[] = [cursor];
  for (const segment of issue.path) {
    cursor = cursor ? descend(cursor, segment) : undefined;
    trail.push(cursor);
  }
  // Walk leaf → root, return first .meta().suggestion found.
  for (let i = trail.length - 1; i >= 0; i -= 1) {
    const found = readSuggestionMeta(trail[i]);
    if (found !== undefined) return found;
  }
  return undefined;
}

export function resolveSuggestion(
  p: Pick<Problem, 'code' | 'issues'>,
  schema?: z.ZodType,
): string | undefined {
  if (p.issues && p.issues.length > 0 && schema) {
    for (const issue of p.issues) {
      const fromMeta = suggestionFromIssueMeta(schema, issue);
      if (fromMeta) return fromMeta;
    }
  }
  if (p.issues && p.issues.length > 0) {
    for (const issue of p.issues) {
      const fromRule = issue.params?.suggestion;
      if (typeof fromRule === 'string') return fromRule;
    }
  }
  return DEFAULT_SUGGESTIONS[p.code];
}
