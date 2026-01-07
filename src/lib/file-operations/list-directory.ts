import type { ListDirectoryResult } from '../../config/types.js';
import { createTimedAbortSignal } from '../fs-helpers/abort.js';
import { validateExistingDirectory } from '../path-validation.js';
import {
  executeListDirectory,
  type ListDirectoryOptions,
  normalizeOptions,
} from './list-directory-helpers.js';

export async function listDirectory(
  dirPath: string,
  options: ListDirectoryOptions = {}
): Promise<ListDirectoryResult> {
  const normalized = normalizeOptions(options);
  const { signal, cleanup } = createTimedAbortSignal(
    options.signal,
    normalized.timeoutMs
  );
  const basePath = await validateExistingDirectory(dirPath, signal);

  try {
    const { entries, summary } = await executeListDirectory(
      basePath,
      normalized,
      signal
    );
    return { path: basePath, entries, summary };
  } finally {
    cleanup();
  }
}
