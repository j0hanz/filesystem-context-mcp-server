import { z } from 'zod/v4';

// NOTE: singular `path` is intentionally removed (breaking change).
// Response now always uses `paths` array.
export const CreateDirectoryOutputSchema = z.strictObject({
  ok: z.literal(true),
  paths: z
    .array(z.string())
    .describe('Created directory paths'),
});
