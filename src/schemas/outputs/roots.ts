import { z } from 'zod/v4';

export const RootsOutputSchema = z.strictObject({
  ok: z.literal(true),
  roots: z
    .array(
      z.strictObject({
        uri: z.string().describe('Root URI (file://)'),
        name: z.string().optional().describe('Display name'),
      })
    )
    .optional(),
});
