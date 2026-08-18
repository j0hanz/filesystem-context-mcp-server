import * as z from 'zod/v4';

import { ErrorCode, FsError } from './errors.js';

function createBase64JsonCodec<Schema extends z.ZodType>(
  schema: Schema,
): z.ZodCodec<z.ZodString, Schema> {
  return z.codec(z.string(), schema, {
    decode: (value) => {
      let buffer: Buffer;
      try {
        buffer = Buffer.from(value, 'base64url');
      } catch (error) {
        throw new FsError(
          ErrorCode.INVALID_INPUT,
          'Invalid base64url encoding.',
          undefined,
          { originalError: error instanceof Error ? error.message : String(error) },
          error instanceof Error ? error : undefined,
        );
      }

      let text: string;
      try {
        text = buffer.toString('utf-8');
      } catch (error) {
        throw new FsError(
          ErrorCode.INVALID_INPUT,
          'UTF-8 decode failed (corrupted payload).',
          undefined,
          { originalError: error instanceof Error ? error.message : String(error) },
          error instanceof Error ? error : undefined,
        );
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (error) {
        throw new FsError(
          ErrorCode.INVALID_INPUT,
          'Invalid JSON in payload.',
          undefined,
          { originalError: error instanceof Error ? error.message : String(error) },
          error instanceof Error ? error : undefined,
        );
      }

      // Cast to the codec's declared decode return type. The downstream
      // schema runs immediately after `decode` and validates the actual shape,
      // so this assertion only satisfies the codec contract — it is not trusted.
      return parsed as z.input<Schema>;
    },
    encode: (value) => Buffer.from(JSON.stringify(value)).toString('base64url'),
  });
}

const OffsetCursorSchema = z.strictObject({
  offset: z.int().nonnegative(),
});

const OffsetCursorCodec = createBase64JsonCodec(OffsetCursorSchema);

export function encodeOffsetCursor(offset: number): string {
  return z.encode(OffsetCursorCodec, { offset });
}

export function decodeOffsetCursor(cursor: string): number {
  // safeParse normally reports failure via result.success, but a codec decode can
  // also throw; treat either as an invalid cursor with one uniform error.
  let result: ReturnType<typeof OffsetCursorCodec.safeParse> | undefined;
  let caughtError: unknown;
  try {
    result = OffsetCursorCodec.safeParse(cursor);
  } catch (err) {
    caughtError = err;
    result = undefined;
  }
  if (!result?.success) {
    throw new FsError(
      ErrorCode.INVALID_INPUT,
      'Invalid cursor. Request the first page without a cursor.',
      undefined,
      {
        originalError:
          caughtError instanceof Error
            ? caughtError.message
            : typeof caughtError === 'string' ||
                typeof caughtError === 'number' ||
                typeof caughtError === 'boolean'
              ? String(caughtError)
              : undefined,
      },
      caughtError instanceof Error ? caughtError : undefined,
    );
  }
  return result.data.offset;
}
