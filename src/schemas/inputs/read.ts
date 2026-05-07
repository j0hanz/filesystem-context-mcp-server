import { z } from 'zod/v4';

import { OptionalPath } from '../fields.js';
import { createReadRangeFields, validateReadRange } from '../shared.js';
import { toToolJsonSchema } from '../json-schema.js';

const readRangeFields = createReadRangeFields({
  head: 'Return first N lines',
  tail: 'Return last N lines',
  startLine: 'Start line (1-indexed)',
  endLine: 'End line (1-indexed)',
});

export const ReadFileInputSchema = z
  .strictObject({
    path: OptionalPath.describe(
      'File path (relative to first root if multiple roots)'
    ),
    ...readRangeFields,
  })
  .superRefine((value, ctx) => {
    validateReadRange(
      {
        head: value.head,
        tail: value.tail,
        startLine: value.startLine,
        endLine: value.endLine,
      },
      ctx
    );
  });

// Pre-augmented schema with oneOf constraints for read-mode mutual exclusion
export const ReadFileInputSchemaJson = toToolJsonSchema(
  ReadFileInputSchema,
  (s) => ({
    ...s,
    allOf: [
      ...(Array.isArray(s.allOf) ? (s.allOf as unknown[]) : []),
      {
        if: { required: ['head'] },
        then: {
          not: {
            anyOf: [
              { required: ['tail'] },
              { required: ['startLine'] },
              { required: ['endLine'] },
            ],
          },
        },
      },
      {
        if: { required: ['tail'] },
        then: {
          not: {
            anyOf: [
              { required: ['head'] },
              { required: ['startLine'] },
              { required: ['endLine'] },
            ],
          },
        },
      },
      {
        if: { required: ['startLine'] },
        then: {
          not: {
            anyOf: [{ required: ['head'] }, { required: ['tail'] }],
          },
        },
      },
    ],
  })
);
