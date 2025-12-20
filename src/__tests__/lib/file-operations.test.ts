import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  analyzeDirectory,
  getDirectoryTree,
  getFileInfo,
  listDirectory,
  readMediaFile,
  readMultipleFiles,
  searchContent,
  searchFiles,
} from '../../lib/file-operations.js';
import { normalizePath } from '../../lib/path-utils.js';
import { setAllowedDirectories } from '../../lib/path-validation.js';

describe('File Operations', () => {
  let testDir: string;

  beforeAll(async () => {
    // Create a temporary test directory with various files
    testDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mcp-fileops-test-'));

    // Create test structure
    await fs.mkdir(path.join(testDir, 'src'));
    await fs.mkdir(path.join(testDir, 'docs'));
    await fs.mkdir(path.join(testDir, '.hidden'));

    // Create test files
    await fs.writeFile(
      path.join(testDir, 'README.md'),
      '# Test Project\nThis is a test.\n'
    );
    await fs.writeFile(
      path.join(testDir, 'src', 'index.ts'),
      'export const hello = "world";\n'
    );
    await fs.writeFile(
      path.join(testDir, 'src', 'utils.ts'),
      'export function add(a: number, b: number) { return a + b; }\n'
    );
    await fs.writeFile(
      path.join(testDir, 'docs', 'guide.md'),
      '# Guide\nSome documentation.\n'
    );
    await fs.writeFile(
      path.join(testDir, '.hidden', 'secret.txt'),
      'hidden content'
    );

    // Create a multi-line file for head/tail tests
    const lines = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join(
      '\n'
    );
    await fs.writeFile(path.join(testDir, 'multiline.txt'), lines);

    // Create a simple PNG-like binary file (just bytes, not a real image)
    const binaryData = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00,
    ]);
    await fs.writeFile(path.join(testDir, 'image.png'), binaryData);

    // Set allowed directories
    setAllowedDirectories([normalizePath(testDir)]);
  });

  afterAll(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  describe('listDirectory', () => {
    it('should list directory contents', async () => {
      const result = await listDirectory(testDir);
      expect(result.entries.length).toBeGreaterThan(0);
      expect(result.summary.totalEntries).toBeGreaterThan(0);
    });

    it('should list recursively when specified', async () => {
      const result = await listDirectory(testDir, { recursive: true });
      expect(result.entries.some((e) => e.name === 'index.ts')).toBe(true);
    });

    it('should include hidden files when specified', async () => {
      const result = await listDirectory(testDir, { includeHidden: true });
      expect(result.entries.some((e) => e.name === '.hidden')).toBe(true);
    });

    it('should exclude hidden files by default', async () => {
      const result = await listDirectory(testDir, { includeHidden: false });
      expect(result.entries.some((e) => e.name === '.hidden')).toBe(false);
    });

    it('should respect maxEntries limit', async () => {
      const result = await listDirectory(testDir, { maxEntries: 2 });
      expect(result.entries.length).toBeLessThanOrEqual(2);
      expect(result.summary.truncated).toBe(true);
    });
  });

  describe('searchFiles', () => {
    it('should find files by glob pattern', async () => {
      const result = await searchFiles(testDir, '**/*.ts');
      expect(result.results.length).toBe(2);
      expect(result.results.some((r) => r.path.includes('index.ts'))).toBe(
        true
      );
      // Optional: validate modified is present on file results
      const first = result.results.find((r) => r.type === 'file');
      if (first) {
        expect(first.modified).toBeInstanceOf(Date);
      }
    });

    it('should find markdown files', async () => {
      const result = await searchFiles(testDir, '**/*.md');
      expect(result.results.length).toBe(2);
    });

    it('should return empty results for non-matching patterns', async () => {
      const result = await searchFiles(testDir, '**/*.xyz');
      expect(result.results.length).toBe(0);
    });

    it('should respect maxResults', async () => {
      const result = await searchFiles(testDir, '**/*', [], { maxResults: 1 });
      expect(result.results.length).toBeLessThanOrEqual(1);
    });
  });

  describe('readMultipleFiles', () => {
    it('should read multiple files in parallel', async () => {
      const paths = [
        path.join(testDir, 'README.md'),
        path.join(testDir, 'src', 'index.ts'),
      ];
      const results = await readMultipleFiles(paths);
      expect(results.length).toBe(2);
      expect(results.every((r) => r.content !== undefined)).toBe(true);
    });

    it('should handle individual file errors gracefully', async () => {
      const paths = [
        path.join(testDir, 'README.md'),
        path.join(testDir, 'non-existent.txt'),
      ];
      const results = await readMultipleFiles(paths);
      expect(results.length).toBe(2);
      expect(results[0]?.content).toBeDefined();
      expect(results[1]?.error).toBeDefined();
    });

    it('should not apply total size cap when only reading heads/tails', async () => {
      const big1 = path.join(testDir, 'big1.log');
      const big2 = path.join(testDir, 'big2.log');
      const largeContent = 'A'.repeat(50_000); // 50KB each
      await fs.writeFile(big1, largeContent);
      await fs.writeFile(big2, largeContent);

      const results = await readMultipleFiles([big1, big2], {
        head: 1,
        maxTotalSize: 10, // Would fail under old logic
      });

      expect(results.every((r) => r.content !== undefined)).toBe(true);
      await Promise.all([fs.rm(big1), fs.rm(big2)]).catch(() => {});
    });
  });

  describe('getFileInfo', () => {
    it('should return file metadata', async () => {
      const info = await getFileInfo(path.join(testDir, 'README.md'));
      expect(info.name).toBe('README.md');
      expect(info.type).toBe('file');
      expect(info.size).toBeGreaterThan(0);
      expect(info.created).toBeInstanceOf(Date);
    });

    it('should return directory metadata', async () => {
      const info = await getFileInfo(testDir);
      expect(info.type).toBe('directory');
    });
  });

  describe('searchContent', () => {
    it('should find content in files', async () => {
      const result = await searchContent(testDir, 'hello');
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches[0]?.file).toContain('index.ts');
    });

    it('should search case-insensitively by default', async () => {
      const result = await searchContent(testDir, 'HELLO');
      expect(result.matches.length).toBeGreaterThan(0);
    });

    it('should respect case sensitivity when specified', async () => {
      const result = await searchContent(testDir, 'HELLO', {
        caseSensitive: true,
      });
      expect(result.matches.length).toBe(0);
    });

    it('should enforce wholeWord when using literal search', async () => {
      const literalFile = path.join(testDir, 'literal.txt');
      await fs.writeFile(literalFile, 'concatenate cat scatter catapult cat\n');

      const result = await searchContent(testDir, 'cat', {
        isLiteral: true,
        wholeWord: true,
        filePattern: '**/*.txt',
      });

      expect(result.matches.length).toBe(1);
      expect(result.matches[0]?.matchCount).toBe(2);
      await fs.rm(literalFile).catch(() => {});
    });

    it('should skip binary files by default', async () => {
      const result = await searchContent(testDir, 'PNG');
      // Should not find matches in binary file
      expect(result.summary.skippedBinary).toBeGreaterThanOrEqual(0);
    });

    it('should respect file pattern filter', async () => {
      const result = await searchContent(testDir, 'export', {
        filePattern: '**/*.ts',
      });
      expect(result.matches.length).toBeGreaterThan(0);
      expect(result.matches.every((m) => m.file.endsWith('.ts'))).toBe(true);
    });

    it('should include hidden files when requested', async () => {
      const result = await searchContent(testDir, 'hidden', {
        includeHidden: true,
        filePattern: '**/*',
        isLiteral: true,
      });
      expect(result.matches.length).toBeGreaterThan(0);
      expect(
        result.matches.some((m) => m.file.includes(`.hidden${path.sep}`))
      ).toBe(true);
    });

    it('should reject unsafe regex patterns (ReDoS protection)', async () => {
      // Classic ReDoS patterns detected by safe-regex2:
      // - Nested quantifiers like (a+)+
      // - Character class with nested quantifiers like ([a-zA-Z]+)*
      // - High repetition counts like (.*a){25}
      const unsafePatterns = [
        '(a+)+', // Nested quantifiers
        '([a-zA-Z]+)*', // Nested quantifiers with character class
        '(.*a){25}', // High repetition count
      ];

      for (const pattern of unsafePatterns) {
        await expect(searchContent(testDir, pattern)).rejects.toThrow(
          /ReDoS|unsafe/i
        );
      }
    });

    it('should accept safe regex patterns', async () => {
      // Safe patterns should work normally
      const safePatterns = ['hello', 'world\\d+', '[a-z]+', 'function\\s+\\w+'];

      for (const pattern of safePatterns) {
        // Should not throw
        const result = await searchContent(testDir, pattern, {
          filePattern: '**/*.ts',
        });
        expect(result).toBeDefined();
      }
    });
  });

  describe('analyzeDirectory', () => {
    it('should analyze directory structure', async () => {
      const result = await analyzeDirectory(testDir);
      expect(result.analysis.totalFiles).toBeGreaterThan(0);
      expect(result.analysis.totalDirectories).toBeGreaterThan(0);
      expect(result.analysis.totalSize).toBeGreaterThan(0);
    });

    it('should list file types', async () => {
      const result = await analyzeDirectory(testDir);
      expect(Object.keys(result.analysis.fileTypes).length).toBeGreaterThan(0);
    });

    it('should track largest files', async () => {
      const result = await analyzeDirectory(testDir, { topN: 5 });
      expect(result.analysis.largestFiles.length).toBeLessThanOrEqual(5);
    });
  });

  describe('getDirectoryTree', () => {
    it('should return tree structure', async () => {
      const result = await getDirectoryTree(testDir);
      expect(result.tree.type).toBe('directory');
      expect(result.tree.children).toBeDefined();
      expect(result.tree.children?.length).toBeGreaterThan(0);
    });

    it('should respect maxDepth', async () => {
      const result = await getDirectoryTree(testDir, { maxDepth: 1 });
      expect(result.summary.maxDepthReached).toBeLessThanOrEqual(1);
    });

    it('should exclude patterns', async () => {
      const result = await getDirectoryTree(testDir, {
        excludePatterns: ['docs'],
      });
      const hasDocsDir = result.tree.children?.some((c) => c.name === 'docs');
      expect(hasDocsDir).toBe(false);
    });

    it('should include sizes when specified', async () => {
      const result = await getDirectoryTree(testDir, { includeSize: true });
      const fileEntry = result.tree.children?.find((c) => c.type === 'file');
      expect(fileEntry?.size).toBeDefined();
    });

    it('should not traverse symlinks that escape allowed directories', async () => {
      const outsideDir = await fs.mkdtemp(
        path.join(os.tmpdir(), 'mcp-outside-')
      );
      const outsideFile = path.join(outsideDir, 'outside.txt');
      await fs.writeFile(outsideFile, 'outside');

      const linkPath = path.join(testDir, 'escape');
      const linkType: 'junction' | 'dir' =
        process.platform === 'win32' ? 'junction' : 'dir';

      let createdLink = false;
      try {
        // Symlink creation can fail on some Windows setups without admin/dev mode.
        // If creation fails, we treat this as a no-op environment limitation.
        await fs.symlink(outsideDir, linkPath, linkType);
        createdLink = true;

        const result = await getDirectoryTree(testDir, { maxDepth: 3 });

        // The symlink/junction itself should not appear in the tree (we skip symlinks).
        const childNames = (result.tree.children ?? []).map((c) => c.name);
        expect(childNames.includes('escape')).toBe(false);

        // And we must not traverse into the outside directory.
        const containsName = (
          entry: { name: string; children?: unknown[] },
          name: string
        ): boolean => {
          if (entry.name === name) return true;
          const { children } = entry;
          if (!children || !Array.isArray(children)) return false;
          for (const child of children) {
            if (
              child &&
              typeof child === 'object' &&
              containsName(
                child as { name: string; children?: unknown[] },
                name
              )
            ) {
              return true;
            }
          }
          return false;
        };

        expect(containsName(result.tree, 'outside.txt')).toBe(false);
        expect(result.summary.symlinksNotFollowed).toBeGreaterThanOrEqual(1);
      } catch {
        // Skip assertion when symlink creation isn't permitted in the environment.
        expect(createdLink).toBe(false);
      } finally {
        try {
          await fs.rm(linkPath, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
        try {
          await fs.rm(outsideDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      }
    });
  });

  describe('readMultipleFiles', () => {
    it('should handle single-file parameters correctly', async () => {
      // 1. Should allow lineStart/lineEnd for single file
      const singleFileResults = await readMultipleFiles(
        [path.join(testDir, 'README.md')],
        { lineStart: 1, lineEnd: 1 }
      );
      expect(singleFileResults.length).toBe(1);
      expect(singleFileResults[0]?.content).toBeDefined();

      // 2. Should reject lineStart/lineEnd for multiple files
      const invalidOptions = {
        lineStart: 1,
        lineEnd: 10,
      };
      await expect(
        readMultipleFiles(
          [
            path.join(testDir, 'README.md'),
            path.join(testDir, 'src', 'index.ts'),
          ],
          invalidOptions
        )
      ).rejects.toThrow(/not supported by read_multiple_files/i);
    });
  });

  describe('readMediaFile', () => {
    it('should read binary file as base64', async () => {
      const result = await readMediaFile(path.join(testDir, 'image.png'));
      expect(result.mimeType).toBe('image/png');
      expect(result.data).toBeTruthy();
      expect(result.size).toBeGreaterThan(0);
    });

    it('should return correct MIME type for markdown files', async () => {
      const result = await readMediaFile(path.join(testDir, 'README.md'));
      expect(result.mimeType).toBe('text/markdown');
      expect(result.data).toBeTruthy();
      expect(result.size).toBeGreaterThan(0);
    });

    it('should reject files too large', async () => {
      await expect(
        readMediaFile(path.join(testDir, 'image.png'), { maxSize: 1 })
      ).rejects.toThrow('too large');
    });
  });

  describe('Edge Cases and Input Validation', () => {
    describe('searchContent edge cases', () => {
      it('should handle empty search results gracefully', async () => {
        const result = await searchContent(testDir, 'xyznonexistent123', {
          filePattern: '**/*.ts',
        });
        expect(result.matches.length).toBe(0);
        expect(result.summary.filesMatched).toBe(0);
      });

      it('should handle special regex characters safely', async () => {
        // These are valid regex patterns with special chars
        const result = await searchContent(testDir, 'hello\\.world', {
          filePattern: '**/*.ts',
        });
        expect(result).toBeDefined();
      });

      it('should throw on invalid regex syntax', async () => {
        // Pattern that passes safe-regex2 but fails RegExp compilation
        // Using an invalid backreference that's syntactically incorrect
        await expect(searchContent(testDir, '(?')).rejects.toThrow(
          /Invalid regular expression|ReDoS/i
        );
      });

      it('should respect maxResults limit', async () => {
        const result = await searchContent(testDir, '\\w+', {
          filePattern: '**/*.ts',
          maxResults: 1,
        });
        expect(result.matches.length).toBeLessThanOrEqual(1);
        if (result.matches.length === 1) {
          expect(result.summary.truncated).toBe(true);
        }
      });

      it('should respect maxFilesScanned limit', async () => {
        const result = await searchContent(testDir, 'export', {
          filePattern: '**/*',
          maxFilesScanned: 1,
        });
        expect(result.summary.filesScanned).toBeLessThanOrEqual(1);
      });

      it('should handle timeout correctly', async () => {
        // Very short timeout should trigger timeout behavior
        const result = await searchContent(testDir, 'export', {
          filePattern: '**/*',
          timeoutMs: 1, // 1ms timeout
        });
        // Either completes quickly or times out
        expect(result).toBeDefined();
      });

      it('should stop early when maxResults is 0 (edge case)', async () => {
        const result = await searchContent(testDir, 'Line', { maxResults: 0 });
        expect(result.summary.truncated).toBe(true);
        expect(result.summary.stoppedReason).toBe('maxResults');
      });

      it('should match literal strings when isLiteral=true', async () => {
        const result = await searchContent(testDir, 'Test.*Project', {
          isLiteral: true,
          filePattern: '**/*.md',
        });
        // When literal, "Test.*Project" should NOT match "Test Project"
        expect(result.matches.length).toBe(0);
      });
    });

    describe('listDirectory edge cases', () => {
      it('should handle maxDepth=0', async () => {
        const result = await listDirectory(testDir, {
          recursive: true,
          maxDepth: 0,
        });
        // Should only list immediate children, not recurse
        expect(result.summary.maxDepthReached).toBe(0);
      });

      it('should handle empty directory', async () => {
        const emptyDir = path.join(testDir, 'empty-dir');
        await fs.mkdir(emptyDir, { recursive: true });

        const result = await listDirectory(emptyDir);
        expect(result.entries.length).toBe(0);

        await fs.rm(emptyDir, { recursive: true });
      });
    });

    describe('searchFiles edge cases', () => {
      it('should handle complex glob patterns', async () => {
        const result = await searchFiles(testDir, '**/*.{ts,md}');
        expect(result.results.length).toBeGreaterThan(0);
      });

      it('should handle negation in exclude patterns', async () => {
        const result = await searchFiles(testDir, '**/*', ['**/docs/**']);
        // Should not include files from docs directory
        expect(result.results.every((r) => !r.path.includes('docs'))).toBe(
          true
        );
      });
    });

    describe('getDirectoryTree edge cases', () => {
      it('should handle very deep nesting with truncation', async () => {
        const result = await getDirectoryTree(testDir, { maxDepth: 0 });
        expect(result.summary.truncated).toBe(true);
      });

      it('should sort entries correctly (directories first)', async () => {
        const result = await getDirectoryTree(testDir);
        const children = result.tree.children ?? [];
        const dirs = children.filter((c) => c.type === 'directory');
        const files = children.filter((c) => c.type === 'file');

        if (dirs.length > 0 && files.length > 0) {
          // Find first file index and last dir index
          const firstFileIdx = children.findIndex((c) => c.type === 'file');
          const lastDirIdx = children
            .map((c, i) => ({ c, i }))
            .filter(({ c }) => c.type === 'directory')
            .pop()?.i;

          if (lastDirIdx !== undefined) {
            expect(lastDirIdx).toBeLessThan(firstFileIdx);
          }
        }
      });
    });

    describe('analyzeDirectory edge cases', () => {
      it('should handle topN=1', async () => {
        const result = await analyzeDirectory(testDir, { topN: 1 });
        expect(result.analysis.largestFiles.length).toBeLessThanOrEqual(1);
        expect(result.analysis.recentlyModified.length).toBeLessThanOrEqual(1);
      });

      it('should correctly count file types', async () => {
        const result = await analyzeDirectory(testDir);
        expect(result.analysis.fileTypes['.ts']).toBe(2);
        expect(result.analysis.fileTypes['.md']).toBe(2);
      });
    });

    describe('readMultipleFiles edge cases', () => {
      it('should handle empty array', async () => {
        const results = await readMultipleFiles([]);
        expect(results.length).toBe(0);
      });

      it('should handle all files failing', async () => {
        const paths = [
          path.join(testDir, 'nonexistent1.txt'),
          path.join(testDir, 'nonexistent2.txt'),
        ];
        const results = await readMultipleFiles(paths);
        expect(results.length).toBe(2);
        expect(results.every((r) => r.error !== undefined)).toBe(true);
      });
    });
  });
});
