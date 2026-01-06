import { ErrorCode, McpError } from '../../errors.js';
import { assertNotAborted } from '../abort.js';
import { isProbablyBinary } from '../binary-detect.js';
import type { NormalizedOptions } from './read-options.js';

export async function assertNotBinary(
  validPath: string,
  filePath: string,
  normalized: NormalizedOptions
): Promise<void> {
  assertNotAborted(normalized.signal);
  const isBinary = await isProbablyBinary(
    validPath,
    undefined,
    normalized.signal
  );
  if (!isBinary) return;
  throw new McpError(
    ErrorCode.E_INVALID_INPUT,
    `Binary file detected: ${filePath}. Set skipBinary=false to read as text.`,
    filePath
  );
}
