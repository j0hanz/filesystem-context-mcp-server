import { z } from 'zod/v4';

// NOTE: singular `source` is intentionally removed (breaking change).
// Response now always uses `sources` array.
export const MoveFileOutputSchema = z.strictObject({
  ok: z.literal(true),
  sources: z.array(z.string()).describe('Moved source paths'),
  destination: z.string().describe('New path'),
});
