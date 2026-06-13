import * as z from 'zod/v4';

import packageJsonRaw from '../package.json' with { type: 'json' };

const PkgInfoSchema = z.looseObject({
  name: z.string(),
  version: z.string(),
  description: z.string().optional(),
  homepage: z.url().optional(),
});

const result = PkgInfoSchema.safeParse(packageJsonRaw);
if (!result.success) {
  throw new Error(`package.json failed schema validation:\n${z.prettifyError(result.error)}`);
}

export const pkgInfo = result.data;
