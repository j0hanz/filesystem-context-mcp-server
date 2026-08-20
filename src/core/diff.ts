import { createTwoFilesPatch } from 'diff';

/**
 * Build a unified two-file patch on the event loop (deferred via setImmediate
 * so a large diff never blocks). `label` is used as both the old and new file
 * header. Resolves to '' if the diff library returns undefined.
 */
export function buildPatchDiff(label: string, original: string, modified: string): Promise<string> {
  return new Promise<string>((resolve) => {
    setImmediate(() => {
      createTwoFilesPatch(label, label, original, modified, 'Original', 'Modified', {
        callback: (res: string | undefined) => {
          resolve(res ?? '');
        },
      });
    });
  });
}
