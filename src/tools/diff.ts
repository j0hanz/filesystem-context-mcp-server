import type { ContentBlock } from '@modelcontextprotocol/server';

import { basename } from 'node:path';

import * as z from 'zod/v4';
import { createTwoFilesPatch, diffLines } from 'diff';

import { NonNegInt, PositiveInt, RequiredPath } from '../core/schema.js';
import { putJsonResource } from '../core/store.js';
import { defineTool, type ToolCtx } from './define.js';

const DiffInputSchema = z.strictObject({
  a: RequiredPath.describe('First file to compare'),
  b: RequiredPath.describe('Second file to compare'),
  context: PositiveInt.max(50)
    .default(3)
    .describe('Number of context lines surrounding each change (default: 3)'),
});

const DiffOutputSchema = z.strictObject({
  a: z.string().describe('Resolved absolute path of the first file'),
  b: z.string().describe('Resolved absolute path of the second file'),
  // The unified diff itself rides the text content block; `resourceUri` holds
  // the full copy for a client that wants to fetch it separately.
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
      ctx.fs.readEditableText(args.a, { signal: ctx.signal, tool: 'diff' }),
      ctx.fs.readEditableText(args.b, { signal: ctx.signal, tool: 'diff' }),
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
  // Identical files: the diff has no hunks, so externalizing it buys the client
  // a link to nothing and burns a store slot the next real diff wants.
  if (ctx.resourceStore && linesAdded + linesRemoved > 0) {
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

  // The diff shipped three times: this text block, `structured.diff`, and the
  // externalized store entry. The text block is the one a model reads, so the
  // structured copy goes — `resourceUri` still holds the full diff for a client
  // that wants to fetch it separately.
  return {
    structured: {
      a: validA,
      b: validB,
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
    'Compare two files and return a unified diff with line counts. Pass the two paths as a and b. ' +
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
