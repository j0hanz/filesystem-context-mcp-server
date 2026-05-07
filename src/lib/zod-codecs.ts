import { z } from 'zod/v4';

export function createBase64JsonCodec<Schema extends z.ZodType>(
  schema: Schema
): z.ZodCodec<z.ZodString, Schema> {
  return z.codec(z.string(), schema, {
    decode: (value) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf-8'));
      } catch (error) {
        throw new Error('Invalid base64url-encoded JSON payload.', {
          cause: error,
        });
      }

      // Cast to the codec's declared decode return type. The downstream
      // schema runs immediately after `decode` and validates the actual shape,
      // so this assertion only satisfies the codec contract — it is not trusted.
      return parsed as z.input<Schema>;
    },
    encode: (value) => Buffer.from(JSON.stringify(value)).toString('base64url'),
  });
}
