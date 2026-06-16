import { FastQueue } from '../../src/core/concurrency.js';
import type { PerPathResult } from '../../src/tools/define.js';

// Probe AC-003: unnarrowed access must fail
declare const result: PerPathResult<string>;
// @ts-expect-error — TS2339: value not accessible without narrowing on error
console.log(result.value);

// Narrowed access must compile without annotation
if (!('error' in result)) {
  console.log(result.value); // OK
}

// Probe AC-004: FastQueue<undefined> must violate the NonNullable constraint
// @ts-expect-error — TS2344: undefined does not satisfy NonNullable<unknown>
new FastQueue<undefined>(8);
