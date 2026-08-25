import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';
import { createTwoFilesPatch, diffLines } from 'diff';

import { NonNegInt, PositiveInt, RequiredPath } from '../core/schema.js';
import { putJsonResource } from '../core/store.js';
import { defineTool, type ToolCtx } from './define.js';
import { loadEditableFile } from './edit.js';

const DiffInputSchema = z.strictObject({
  a: RequiredPath.describe('First file to compare'),
  b: RequiredPath.describe('Second file to compare'),
  context: PositiveInt.max(50)
    .default(3)
    .describe('Number of context lines surrounding each change (default: 3)'),
});

const DiffOutputSchema = z.strictObject({
  ok: z.literal(true).describe('Always true; call succeeded'),
  a: z.string().describe('Resolved absolute path of the first file'),
  b: z.string().describe('Resolved absolute path of the second file'),
  diff: z.string().describe('Unified diff of the two files'),
  linesAdded: NonNegInt.describe('Number of lines added'),
  linesRemoved: NonNegInt.describe('Number of lines removed'),
  resourceUri: z
    .string()
    .optional()
    .describe(
      'URI to the full diff in the resource store (present when resource store is enabled)',
    ),
});

async function handleDiff(
  args: z.infer<typeof DiffInputSchema>,
  ctx: ToolCtx,
): Promise<{
  structured: z.infer<typeof DiffOutputSchema>;
  text: string;
  resources?: ContentBlock[];
}> {
  const [{ validPath: validA, content: contentA }, { validPath: validB, content: contentB }] =
    await Promise.all([
      loadEditableFile(args.a, ctx.fs, ctx.signal, 'diff'),
      loadEditableFile(args.b, ctx.fs, ctx.signal, 'diff'),
    ]);

  // createTwoFilesPatch returns the unified diff string synchronously on diff v9
  // (the { callback } option does not fire on this version — verified).
  const diffText = createTwoFilesPatch(
    basename(validA),
    basename(validB),
    contentA,
    contentB,
    'a',
    'b',
    { context: args.context },
  );

  // diffLines returns the change list synchronously; count added/removed lines.
  let linesAdded = 0;
  let linesRemoved = 0;
  for (const part of diffLines(contentA, contentB)) {
    if (part.added) linesAdded += part.count;
    else if (part.removed) linesRemoved += part.count;
  }

  let resourceUri: string | undefined;
  let link: ReturnType<typeof putJsonResource>['link'] | undefined;
  if (ctx.resourceStore) {
    const result = putJsonResource(ctx.resourceStore, 'diff', {
      diff: diffText,
      linesAdded,
      linesRemoved,
      a: validA,
      b: validB,
    });
    resourceUri = result.entry.uri;
    link = result.link;
  }

  return {
    structured: {
      ok: true as const,
      a: validA,
      b: validB,
      diff: diffText,
      linesAdded,
      linesRemoved,
      ...(resourceUri !== undefined ? { resourceUri } : {}),
    },
    text: diffText,
    ...(link !== undefined ? { resources: [link] } : {}),
  };
}

export const DIFF = defineTool({
  name: 'diff',
  title: 'Diff',
  description:
    'Compare two files and return a unified diff with line counts. ' +
    'Use after an edit dry-run to compare against another file, or to inspect changes between two paths.',
  input: DiffInputSchema,
  output: DiffOutputSchema,
  annotations: {
    readOnlyHint: true,
    idempotentHint: true,
    destructiveHint: false,
    openWorldHint: false,
  },
  progress: (args) => ({
    label: 'Diff',
    subject: basename(args.a),
  }),
  accessPaths: (args) => [args.a, args.b],
  run: (args, ctx) => handleDiff(args, ctx),
});
