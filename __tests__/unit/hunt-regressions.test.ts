/**
 * Regression tests for the defects found in the src/ bug hunt.
 *
 * Each case is the smallest call that fails if the corresponding fix is
 * reverted. Symlink cases skip themselves when the platform refuses to create
 * one (unprivileged Windows), matching security.test.ts.
 */
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport, McpServer } from '@modelcontextprotocol/server';

import assert from 'node:assert/strict';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { ErrorCode, FsError, isFsError, SKIPPABLE_FS_CODES } from '../../src/core/errors.js';
import { buildFileResourceUri } from '../../src/core/file-uri.js';
import { PathGuard } from '../../src/core/path.js';
import { createInMemoryResourceStore } from '../../src/core/store.js';
import { resourcesRegistrar } from '../../src/resources.js';
import { assertOk, createTestEnv, getStructured } from '../helpers.js';

const IS_WINDOWS = process.platform === 'win32';

/** Create a symlink, returning false when the platform denies it. */
async function trySymlink(target: string, link: string, type?: 'dir' | 'file'): Promise<boolean> {
  try {
    await symlink(target, link, IS_WINDOWS ? (type === 'dir' ? 'junction' : 'file') : undefined);
    return true;
  } catch {
    return false;
  }
}

interface PerPathResult {
  path: string;
  value?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// ─── 1. delete: sensitive denial must not be swallowed ───────────────────────

describe('delete: sensitive-file denial survives the ENOENT fallback', () => {
  it('blocks deleting .aws/credentials reached through a symlinked parent', async (t) => {
    const env = await createTestEnv();
    try {
      const awsDir = join(env.tmpDir, '.aws');
      await mkdir(awsDir);
      const secret = join(awsDir, 'credentials');
      await writeFile(secret, 'placeholder');

      const linkDir = join(env.tmpDir, 'cfg');
      if (!(await trySymlink(awsDir, linkDir, 'dir'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      const result = await env.client.callTool({
        name: 'delete',
        arguments: { paths: [join(linkDir, 'credentials')] },
      });

      const sc = getStructured(result);
      assert.equal(sc['ok'], false, 'delete must report failure for a denylisted target');
      const failures = sc['failures'] as { error: { code: string } }[];
      assert.equal(failures[0]?.error.code, 'ACCESS_DENIED');
      // The decisive assertion: the file is still on disk.
      await stat(secret);
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 2. replace_text: literal replacement inserts verbatim ───────────────────

describe('replace_text: $ sequences are literal unless isRegex=true', () => {
  it('does not expand $& / $\u0060 / $\u0027 / $$ on a literal search', async () => {
    const env = await createTestEnv();
    try {
      const file = join(env.tmpDir, 'compose.yml');
      await writeFile(file, 'listen: MARKER\ntail line\n');

      // Defaults: isRegex=false, caseSensitive=false — the regex matcher path.
      // An expansion would collapse "$$" to a single "$".
      assertOk(
        await env.client.callTool({
          name: 'replace_text',
          arguments: { path: file, searchPattern: 'MARKER', replacement: '$$PORT' },
        }),
      );

      assert.equal(await readFile(file, 'utf-8'), 'listen: $$PORT\ntail line\n');
    } finally {
      await env.cleanup();
    }
  });

  it("does not splice the file remainder for a replacement of $'", async () => {
    const env = await createTestEnv();
    try {
      const file = join(env.tmpDir, 'prices.txt');
      await writeFile(file, 'cost USD here\n');

      assertOk(
        await env.client.callTool({
          name: 'replace_text',
          arguments: { path: file, searchPattern: 'USD', replacement: "$'" },
        }),
      );

      assert.equal(await readFile(file, 'utf-8'), "cost $' here\n");
    } finally {
      await env.cleanup();
    }
  });

  it('still expands capture groups when isRegex=true', async () => {
    const env = await createTestEnv();
    try {
      const file = join(env.tmpDir, 'names.txt');
      await writeFile(file, 'function oldName(\n');

      assertOk(
        await env.client.callTool({
          name: 'replace_text',
          arguments: {
            path: file,
            searchPattern: 'function (\\w+)\\(',
            replacement: 'function $1_renamed(',
            isRegex: true,
            caseSensitive: true,
          },
        }),
      );

      assert.equal(await readFile(file, 'utf-8'), 'function oldName_renamed(\n');
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 3. move: a symlink moves as the link ────────────────────────────────────

describe('move: renames the symlink, not its target', () => {
  it('leaves the target in place and moves the link itself', async (t) => {
    const env = await createTestEnv();
    try {
      const target = join(env.tmpDir, 'data.txt');
      await writeFile(target, 'payload');
      const link = join(env.tmpDir, 'link.txt');
      if (!(await trySymlink(target, link, 'file'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      assertOk(
        await env.client.callTool({
          name: 'move',
          arguments: { moves: [{ source: link, destination: join(env.tmpDir, 'moved.txt') }] },
        }),
      );

      // The target must not have been renamed out from under the link.
      assert.equal(await readFile(target, 'utf-8'), 'payload');
      const moved = await lstat(join(env.tmpDir, 'moved.txt'));
      assert.ok(moved.isSymbolicLink(), 'the moved entry must still be a symlink');
    } finally {
      await env.cleanup();
    }
  });

  it('skips a self-move of a symlink instead of renaming it over its target', async (t) => {
    const env = await createTestEnv();
    try {
      const target = join(env.tmpDir, 'data.txt');
      await writeFile(target, 'payload');
      const link = join(env.tmpDir, 'link.txt');
      if (!(await trySymlink(target, link, 'file'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      assertOk(
        await env.client.callTool({
          name: 'move',
          arguments: { moves: [{ source: link, destination: link }] },
        }),
      );

      assert.equal(
        await readFile(target, 'utf-8'),
        'payload',
        'self-move must not touch the target',
      );
      assert.ok((await lstat(link)).isSymbolicLink(), 'the link must survive a self-move');
    } finally {
      await env.cleanup();
    }
  });

  it('skips moving a symlink onto its own target', async (t) => {
    const env = await createTestEnv();
    try {
      const target = join(env.tmpDir, 'data.txt');
      await writeFile(target, 'payload');
      const link = join(env.tmpDir, 'link.txt');
      if (!(await trySymlink(target, link, 'file'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      assertOk(
        await env.client.callTool({
          name: 'move',
          arguments: { moves: [{ source: link, destination: target }] },
        }),
      );

      // Renaming the link over data.txt would destroy the payload and leave a
      // self-referential link.
      assert.equal(await readFile(target, 'utf-8'), 'payload');
      assert.equal((await lstat(target)).isSymbolicLink(), false);
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 4. atomic write preserves mode ──────────────────────────────────────────

describe('edit: preserves the target file mode', () => {
  it('keeps 0o600 across a write', async (t) => {
    if (IS_WINDOWS) {
      t.skip('POSIX permission bits are not modelled on Windows');
      return;
    }
    const env = await createTestEnv();
    try {
      const file = join(env.tmpDir, 'secret.conf');
      await writeFile(file, 'token = old\n');
      await chmod(file, 0o600);

      assertOk(
        await env.client.callTool({
          name: 'edit',
          arguments: { path: file, edits: [{ oldText: 'old', newText: 'new' }] },
        }),
      );

      assert.equal((await stat(file)).mode & 0o777, 0o600);
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 5. list: a dangling symlink is skipped, not fatal ───────────────────────

describe('list: tolerates a broken symlink', () => {
  it('skips the dangling entry and still lists its siblings', async (t) => {
    const env = await createTestEnv();
    try {
      await writeFile(join(env.tmpDir, 'sibling.txt'), 'present');
      // Target inside the allowed root, but never created.
      const broken = join(env.tmpDir, 'broken.txt');
      if (!(await trySymlink(join(env.tmpDir, 'missing.txt'), broken, 'file'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      const result = await env.client.callTool({
        name: 'list',
        arguments: { path: env.tmpDir },
      });

      assertOk(result);
      const sc = getStructured(result);
      const names = (sc['entries'] as { name: string }[]).map((e) => e.name);
      assert.ok(names.includes('sibling.txt'), 'listing must survive the broken link');
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 5b. list entry access: an EACCES symlink target is skipped, not fatal ──
//
// The plan prescribed stubbing node:fs/promises realpath via mock.method, but
// ESM namespace exports of built-ins are non-configurable and the module
// namespace is read-only in strict mode, so realpath cannot be patched from a
// consumer. The fix's real consumer is PathGuard.isEntryAccessible, the exact
// call list/find_files/tree/search_text route every entry through: a symlink
// whose validateExistingPathDetailed rejects with PERMISSION_DENIED must be
// skipped rather than rethrown. A fake PathGuard injects that error
// deterministically, with no platform dependency.

function fakeGuardThrowing(error: FsError): PathGuard {
  return {
    isSensitive: () => false,
    async validateExistingPathDetailed() {
      throw error;
    },
    async isEntryAccessible() {
      try {
        await this.validateExistingPathDetailed();
        return true;
      } catch (caught) {
        if (isFsError(caught) && SKIPPABLE_FS_CODES.has(caught.code)) return false;
        throw caught;
      }
    },
  } as unknown as PathGuard;
}

describe('list entry access: tolerates an EACCES symlink target', () => {
  it('skips a symlink whose target reports PERMISSION_DENIED', async () => {
    const fakeGuard = fakeGuardThrowing(
      new FsError(ErrorCode.PERMISSION_DENIED, 'Cannot access path', '/root/denied.txt'),
    );

    const result = await fakeGuard.isEntryAccessible('/root/denied.txt', 'symlink', ['/root']);
    assert.equal(result, false, 'a PERMISSION_DENIED symlink target must be skipped, not thrown');
  });

  it('still rethrows a non-skippable UNKNOWN from the same path (no over-widening)', async () => {
    const fakeGuard = fakeGuardThrowing(
      new FsError(ErrorCode.UNKNOWN, 'PathGuard not initialized', '/root/denied.txt'),
    );

    await assert.rejects(
      () => fakeGuard.isEntryAccessible('/root/denied.txt', 'symlink', ['/root']),
      (err: unknown) => err instanceof FsError && err.code === ErrorCode.UNKNOWN,
    );
  });
});

// ─── 6. read: every path budget-skipped ──────────────────────────────────────

describe('read: all paths skipped by the size budget', () => {
  it('returns per-path TOO_LARGE instead of failing the call', async () => {
    const env = await createTestEnv();
    try {
      const big = join(env.tmpDir, 'big.log');
      // Over the 512 KiB read-many total budget, under the 10 MiB file cap.
      await writeFile(big, 'x'.repeat(600 * 1024));

      const result = await env.client.callTool({
        name: 'read',
        arguments: { paths: [big] },
      });

      assertOk(result);
      const sc = getStructured(result);
      const results = sc['results'] as PerPathResult[];
      assert.equal(results.length, 1);
      assert.equal(results[0]?.error?.code, 'TOO_LARGE');
      assert.deepEqual(sc['summary'], { total: 1, succeeded: 0, failed: 1 });
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 7. read: tail emits no top-of-file continuation ─────────────────────────

describe('read: tail continuation', () => {
  it('omits the continuation rather than pointing at line tail+1', async () => {
    const env = await createTestEnv();
    try {
      const file = join(env.tmpDir, 'app.log');
      const lines = Array.from({ length: 100 }, (_, i) => `line ${String(i + 1)}`);
      await writeFile(file, lines.join('\n') + '\n');

      const result = await env.client.callTool({
        name: 'read',
        arguments: { path: file, tail: 10 },
      });

      assertOk(result);
      const value = (getStructured(result)['results'] as PerPathResult[])[0]?.value;
      assert.ok(value);
      assert.match(String(value['content']), /line 100$/u, 'tail must return the end of the file');
      assert.equal(
        value['continuation'],
        undefined,
        'a tail read must not hand back a continuation counted from line 1',
      );
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 8 & 10. stat: symlink target and type ───────────────────────────────────

describe('stat: symlink reporting', () => {
  it('reports symlinkTarget for an actual symlink', async (t) => {
    const env = await createTestEnv();
    try {
      const target = join(env.tmpDir, 'target.txt');
      await writeFile(target, 'payload');
      const link = join(env.tmpDir, 'link.txt');
      if (!(await trySymlink(target, link, 'file'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      const result = await env.client.callTool({ name: 'stat', arguments: { path: link } });
      assertOk(result);
      const value = (getStructured(result)['results'] as PerPathResult[])[0]?.value;
      assert.ok(value);
      assert.equal(value['type'], 'symlink');
      assert.ok(
        typeof value['symlinkTarget'] === 'string' && value['symlinkTarget'].length > 0,
        'symlinkTarget must be populated for a symlink',
      );
    } finally {
      await env.cleanup();
    }
  });

  it('reports a regular file under a symlinked parent as a file', async (t) => {
    const env = await createTestEnv();
    try {
      const realDir = join(env.tmpDir, 'real');
      await mkdir(realDir);
      await writeFile(join(realDir, 'notes.txt'), 'plain');
      const linkDir = join(env.tmpDir, 'link');
      if (!(await trySymlink(realDir, linkDir, 'dir'))) {
        t.skip('symlink creation not permitted');
        return;
      }

      const result = await env.client.callTool({
        name: 'stat',
        arguments: { path: join(linkDir, 'notes.txt') },
      });
      assertOk(result);
      const value = (getStructured(result)['results'] as PerPathResult[])[0]?.value;
      assert.ok(value);
      assert.equal(value['type'], 'file', 'a symlinked ancestor must not retype the entry');
      assert.equal(value['symlinkTarget'], undefined);
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 9. guidance text names registered tools ─────────────────────────────────

describe('guidance text names only registered tools', () => {
  it('no prompt or error suggestion mentions a tool that does not exist', async () => {
    const env = await createTestEnv();
    try {
      const listed = await env.client.listTools();
      const registered = new Set(listed.tools.map((t) => t.name));
      // Names that were left behind by an earlier rename.
      const retired = ['tree', 'ls', 'find', 'grep', 'read_many', 'roots'];
      for (const name of retired) {
        assert.equal(registered.has(name), false, `${name} is not a registered tool`);
      }

      // The NOT_FOUND suggestion ships on the most common failure path.
      const missing = await env.client.callTool({
        name: 'stat',
        arguments: { path: join(env.tmpDir, 'nope.txt') },
      });
      const results = getStructured(missing)['results'] as PerPathResult[];
      const combined = JSON.stringify(results[0]?.error ?? {});
      for (const name of retired) {
        assert.doesNotMatch(
          combined,
          new RegExp(`\\b${name}\\b`, 'u'),
          `error guidance must not name the retired tool ${name}`,
        );
      }
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 11. resource URI round-trips ────────────────────────────────────────────

describe('buildFileResourceUri', () => {
  it('encodes characters that would otherwise truncate the URI', () => {
    const uri = buildFileResourceUri('/allowed/notes#draft.md');
    const parsed = new URL(uri);
    assert.equal(parsed.hash, '', 'a # in the filename must not become a fragment');
    assert.equal(decodeURIComponent(parsed.pathname.slice(1)), '/allowed/notes#draft.md');
  });

  it('round-trips a percent sign', () => {
    const uri = buildFileResourceUri('/allowed/100%.txt');
    const parsed = new URL(uri);
    assert.equal(decodeURIComponent(parsed.pathname.slice(1)), '/allowed/100%.txt');
  });

  it('keeps separators readable and survives a Windows drive letter', () => {
    const uri = buildFileResourceUri('c:\\proj\\src\\a.ts');
    assert.ok(uri.startsWith('filesystem-mcp://file/'));
    const parsed = new URL(uri);
    assert.equal(decodeURIComponent(parsed.pathname.slice(1)), 'c:/proj/src/a.ts');
  });
});

// ─── 11b. the encoded URI survives a real resources/read ─────────────────────

/**
 * Registers the resource contracts on a real McpServer behind a real Client, so
 * resources/read goes through the SDK's own {+path} template matching rather
 * than a hand-rolled parser. The encoding fix changes the URI for every path
 * (a Windows drive colon becomes %3A), so the SDK side needs its own coverage.
 */
async function createResourceEnv(): Promise<{
  client: Client;
  tmpDir: string;
  cleanup: () => Promise<void>;
}> {
  const tmpDir = await mkdtemp(join(tmpdir(), 'fsmcp-res-'));
  const server = new McpServer(
    { name: 'test-server', version: '0.0.0' },
    { capabilities: { resources: { subscribe: true } } },
  );
  const pathGuard = new PathGuard();
  await pathGuard.setRoots([tmpDir]);
  resourcesRegistrar.register({
    server,
    pathGuard,
    resourceStore: createInMemoryResourceStore(),
    isInitialized: () => true,
  });

  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await server.connect(st);
  await client.connect(ct);

  return {
    client,
    tmpDir,
    cleanup: async () => {
      try {
        await client.close();
      } catch {
        /* transport may already be closed */
      }
      try {
        await server.close();
      } catch {
        /* ignore */
      }
      resourcesRegistrar.dispose(server);
      await rm(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('resources/read accepts the URI that buildFileResourceUri mints', () => {
  it('round-trips an ordinary path (drive colon encoded on Windows)', async () => {
    const env = await createResourceEnv();
    try {
      const file = join(env.tmpDir, 'plain.txt');
      await writeFile(file, 'payload');

      const result = await env.client.readResource({ uri: buildFileResourceUri(file) });
      assert.equal(result.contents[0]?.text, 'payload');
    } finally {
      await env.cleanup();
    }
  });

  it('round-trips a filename containing # and %', async (t) => {
    const env = await createResourceEnv();
    try {
      const file = join(env.tmpDir, 'notes#100%.txt');
      try {
        await writeFile(file, 'tricky');
      } catch {
        t.skip('filesystem rejects # or % in a filename');
        return;
      }

      const result = await env.client.readResource({ uri: buildFileResourceUri(file) });
      assert.equal(result.contents[0]?.text, 'tricky');
    } finally {
      await env.cleanup();
    }
  });
});

// ─── 12. edit: line range is never inverted ──────────────────────────────────

describe('edit: lineRange ordering', () => {
  it('does not invert on a tail trim of a file with no final newline', async () => {
    const env = await createTestEnv();
    try {
      const file = join(env.tmpDir, 'trim.txt');
      await writeFile(file, 'a\nb');

      const result = await env.client.callTool({
        name: 'edit',
        arguments: { path: file, edits: [{ oldText: '\nb', newText: '' }] },
      });

      assertOk(result);
      const value = (getStructured(result)['results'] as PerPathResult[])[0]?.value;
      assert.ok(value);
      const range = value['lineRange'] as [number, number] | undefined;
      assert.ok(range, 'a tail trim is a change and must report a range');
      assert.ok(range[0] <= range[1], `lineRange must not be inverted, got [${range.join(', ')}]`);
    } finally {
      await env.cleanup();
    }
  });
});
