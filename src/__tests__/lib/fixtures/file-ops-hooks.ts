import { after, before, type TestContext } from 'node:test';

import {
  acquireFileOpsFixture,
  releaseFileOpsFixture,
} from './file-ops-fixture.js';

export function withFileOpsFixture(
  fn: (getTestDir: () => string) => void
): void {
  let testDir = '';
  before(async () => {
    ({ testDir } = await acquireFileOpsFixture());
  });

  after(async () => {
    await releaseFileOpsFixture();
  });

  fn(() => testDir);
}

export async function setupFileOpsFixture(t: TestContext): Promise<string> {
  const { testDir } = await acquireFileOpsFixture();
  t.after(async () => {
    await releaseFileOpsFixture();
  });
  return testDir;
}
