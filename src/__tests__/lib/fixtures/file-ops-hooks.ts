import { afterAll, beforeAll } from 'vitest';

import {
  acquireFileOpsFixture,
  releaseFileOpsFixture,
} from './file-ops-fixture.js';

export function useFileOpsFixture(): () => string {
  let testDir = '';
  beforeAll(async () => {
    ({ testDir } = await acquireFileOpsFixture());
  });
  afterAll(async () => {
    await releaseFileOpsFixture();
  });
  return () => testDir;
}
