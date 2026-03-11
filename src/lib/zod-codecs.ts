import { z } from 'zod';

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

      return parsed as z.input<Schema>;
    },
    encode: (value) => Buffer.from(JSON.stringify(value)).toString('base64url'),
  });
}
