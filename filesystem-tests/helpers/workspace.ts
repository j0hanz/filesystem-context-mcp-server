import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { normalizePath } from '../../src/core/path.js';

const IS_WINDOWS = process.platform === 'win32';

/**
 * Isolated temporary directory workspace for filesystem test fixtures.
 * Encapsulates Windows-safe teardown, relative path resolution, and fixture creation.
 */
export class DisposableWorkspace {
  readonly root: string;
  readonly normalizedRoot: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.normalizedRoot = normalizePath(this.root);
  }

  static async create(prefix = 'fsmcp-qa-'): Promise<DisposableWorkspace> {
    const root = await mkdtemp(join(tmpdir(), `${prefix}${randomUUID().slice(0, 8)}-`));
    return new DisposableWorkspace(root);
  }

  path(...segments: string[]): string {
    return join(this.root, ...segments);
  }

  normPath(...segments: string[]): string {
    return normalizePath(this.path(...segments));
  }

  async dir(...segments: string[]): Promise<string> {
    const fullPath = this.path(...segments);
    await mkdir(fullPath, { recursive: true });
    return fullPath;
  }

  async file(relPath: string, content: string | Buffer = ''): Promise<string> {
    const fullPath = this.path(relPath);
    await mkdir(dirname(fullPath), { recursive: true });
    await writeFile(fullPath, content);
    return fullPath;
  }

  async symlink(target: string, relPath: string, type?: 'dir' | 'file'): Promise<boolean> {
    const linkPath = this.path(relPath);
    await mkdir(dirname(linkPath), { recursive: true });
    try {
      await symlink(
        target,
        linkPath,
        IS_WINDOWS ? (type === 'dir' ? 'junction' : 'file') : undefined,
      );
      return true;
    } catch {
      return false;
    }
  }

  async populate(tree: Record<string, string | Buffer>): Promise<void> {
    for (const [relPath, content] of Object.entries(tree)) {
      await this.file(relPath, content);
    }
  }

  async cleanup(): Promise<void> {
    await rm(this.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }).catch(
      () => {},
    );
  }
}
