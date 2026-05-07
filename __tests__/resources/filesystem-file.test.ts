import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { SENSITIVE_FILE_DENYLIST } from '../../src/lib/constants.js';
import { PathGuard } from '../../src/lib/path-guard.js';
import { resolveAllowedDirectoriesState } from '../../src/lib/paths.js';
import {
  createFileSubscription,
  FILESYSTEM_FILE_URI_TEMPLATE,
} from '../../src/resources/filesystem-file.js';

// ── createFileSubscription unit tests ──────────────────────────────────────

describe('createFileSubscription', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fsmcp-fs-res-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('fires notify when watched file changes', async () => {
    const filePath = join(tmpDir, 'watched.txt');
    await writeFile(filePath, 'initial');

    const notified: string[] = [];
    const lc = createFileSubscription((uri) => {
      notified.push(uri);
    });

    const uri = `filesystem-mcp://file/${encodeURIComponent(filePath)}`;
    lc.onSubscribe(uri);

    await writeFile(filePath, 'changed');

    // fs.watch fires asynchronously — wait up to 500ms
    await new Promise<void>((resolve) => {
      const deadline = setTimeout(resolve, 500);
      const check = setInterval(() => {
        if (notified.length > 0) {
          clearInterval(check);
          clearTimeout(deadline);
          resolve();
        }
      }, 10);
    });

    assert.ok(
      notified.includes(uri),
      'expected notify to be called with the file URI'
    );
    lc.destroy();
  });

  it('ignores URIs that do not match the filesystem-mcp://file/ prefix', () => {
    const notified: string[] = [];
    const lc = createFileSubscription((uri) => notified.push(uri));
    lc.onSubscribe('internal://instructions'); // wrong scheme
    assert.strictEqual(notified.length, 0);
    lc.destroy();
  });

  it('onUnsubscribe stops the watcher', async () => {
    const filePath = join(tmpDir, 'unsub.txt');
    await writeFile(filePath, 'initial');

    const notified: string[] = [];
    const lc = createFileSubscription((uri) => notified.push(uri));

    const uri = `filesystem-mcp://file/${encodeURIComponent(filePath)}`;
    lc.onSubscribe(uri);
    lc.onUnsubscribe(uri);

    await writeFile(filePath, 'changed');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(
      notified.length,
      0,
      'no notifications after unsubscribe'
    );
    lc.destroy();
  });

  it('destroy closes all watchers', async () => {
    const filePath = join(tmpDir, 'destroy.txt');
    await writeFile(filePath, 'initial');

    const notified: string[] = [];
    const lc = createFileSubscription((uri) => notified.push(uri));

    const uri = `filesystem-mcp://file/${encodeURIComponent(filePath)}`;
    lc.onSubscribe(uri);
    lc.destroy();

    await writeFile(filePath, 'changed');
    await new Promise<void>((resolve) => setTimeout(resolve, 100));

    assert.strictEqual(notified.length, 0, 'no notifications after destroy');
  });
});

// ── PathGuard integration ───────────────────────────────────────────────────

describe('FILESYSTEM_FILE_URI_TEMPLATE', () => {
  it('is the expected template string', () => {
    assert.strictEqual(
      FILESYSTEM_FILE_URI_TEMPLATE,
      'filesystem-mcp://file/{+path}'
    );
  });
});

describe('PathGuard rejects unsafe paths', () => {
  let tmpDir: string;
  let outsideDir: string;
  let pathGuard: PathGuard;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'fsmcp-pg-'));
    outsideDir = await mkdtemp(join(tmpdir(), 'fsmcp-outside-'));
    const state = await resolveAllowedDirectoriesState([tmpDir]);
    pathGuard = new PathGuard(SENSITIVE_FILE_DENYLIST);
    pathGuard.initialize(state);
  });

  after(async () => {
    await Promise.all([
      rm(tmpDir, { recursive: true, force: true }),
      rm(outsideDir, { recursive: true, force: true }),
    ]);
  });

  it('rejects a path outside allowed roots', async () => {
    const outsidePath = join(outsideDir, 'secret.txt');
    await writeFile(outsidePath, 'secret');
    await assert.rejects(
      () => pathGuard.validateExistingPath(outsidePath),
      /ACCESS_DENIED|not allowed|outside/i
    );
  });

  it('resolves a path inside the allowed root', async () => {
    const insidePath = join(tmpDir, 'ok.txt');
    await writeFile(insidePath, 'hello');
    const resolved = await pathGuard.validateExistingPath(insidePath);
    assert.ok(resolved.length > 0);
  });
});
