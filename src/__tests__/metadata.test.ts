import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

interface ServerJsonPackage {
  transport?: { type?: string };
}

interface ServerJson {
  packages?: ServerJsonPackage[];
}

async function readRepoFile(relativePath: string): Promise<string> {
  return await fs.readFile(path.resolve(relativePath), 'utf8');
}

describe('published metadata', () => {
  it('advertises HTTP transport when the CLI exposes --port', async () => {
    const [cliSource, bootstrapSource, serverJsonRaw] = await Promise.all([
      readRepoFile('src/cli.ts'),
      readRepoFile('src/server/bootstrap.ts'),
      readRepoFile('server.json'),
    ]);

    assert.match(
      cliSource,
      /--port <number>/,
      'Expected CLI to expose --port for Streamable HTTP transport'
    );
    assert.match(
      bootstrapSource,
      /startHttpServer/,
      'Expected runtime to implement an HTTP transport'
    );

    const serverJson = JSON.parse(serverJsonRaw) as ServerJson;
    const transports = (serverJson.packages ?? [])
      .map((pkg) => pkg.transport?.type)
      .filter((value): value is string => typeof value === 'string');

    assert.ok(
      transports.includes('http'),
      `Expected server.json to advertise HTTP transport; found ${JSON.stringify(transports)}`
    );
  });
});
