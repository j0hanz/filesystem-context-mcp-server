import { describe, expect, it } from 'vitest';

import type { ContentMatch, DirectoryEntry } from '../../config/types.js';
import {
  formatAllowedDirectories,
  formatContentMatches,
  formatDirectoryAnalysis,
  formatDirectoryListing,
  formatFileInfo,
  formatOperationSummary,
  formatSearchResults,
  formatTreeEntry,
} from '../../lib/formatters.js';

describe('formatters', () => {
  describe('formatDirectoryListing', () => {
    it('should format an empty directory', () => {
      const result = formatDirectoryListing([], '/test/path');
      expect(result).toContain('empty');
    });

    it('should format directory with files', () => {
      const entries: DirectoryEntry[] = [
        {
          name: 'file.txt',
          path: '/test/path/file.txt',
          relativePath: 'file.txt',
          type: 'file',
          size: 1024,
        },
        {
          name: 'folder',
          path: '/test/path/folder',
          relativePath: 'folder',
          type: 'directory',
        },
      ];
      const result = formatDirectoryListing(entries, '/test/path');
      expect(result).toContain('file.txt');
      expect(result).toContain('folder');
      expect(result).toContain('[FILE]');
      expect(result).toContain('[DIR]');
    });

    it('should format different file types', () => {
      const entries: DirectoryEntry[] = [
        {
          name: 'doc.txt',
          path: '/test/doc.txt',
          relativePath: 'doc.txt',
          type: 'file',
        },
        {
          name: 'dir',
          path: '/test/dir',
          relativePath: 'dir',
          type: 'directory',
        },
        {
          name: 'link',
          path: '/test/link',
          relativePath: 'link',
          type: 'symlink',
        },
      ];
      const result = formatDirectoryListing(entries, '/test');
      expect(result).toContain('[FILE]'); // file
      expect(result).toContain('[DIR]'); // directory
      expect(result).toContain('[LINK]'); // symlink
    });

    it('should format file sizes', () => {
      const entries: DirectoryEntry[] = [
        {
          name: 'small.txt',
          path: '/test/small.txt',
          relativePath: 'small.txt',
          type: 'file',
          size: 100,
        },
        {
          name: 'medium.txt',
          path: '/test/medium.txt',
          relativePath: 'medium.txt',
          type: 'file',
          size: 1024 * 500,
        },
        {
          name: 'large.txt',
          path: '/test/large.txt',
          relativePath: 'large.txt',
          type: 'file',
          size: 1024 * 1024 * 5,
        },
      ];
      const result = formatDirectoryListing(entries, '/test');
      expect(result).toContain('100 B');
      expect(result).toContain('KB');
      expect(result).toContain('MB');
    });

    it('should include symlink targets when provided', () => {
      const entries: DirectoryEntry[] = [
        {
          name: 'link',
          path: '/test/link',
          relativePath: 'link',
          type: 'symlink',
          symlinkTarget: '/actual/target',
        },
      ];
      const result = formatDirectoryListing(entries, '/test');
      expect(result).toContain('link');
      expect(result).toContain('/actual/target');
    });
  });

  describe('formatSearchResults', () => {
    it('should handle empty results', () => {
      const result = formatSearchResults([]);
      expect(result).toContain('No matches found');
    });

    it('should format search results', () => {
      const results = [
        { path: 'src/index.ts', type: 'file' as const },
        { path: 'src/utils.ts', type: 'file' as const },
      ];
      const output = formatSearchResults(results);
      expect(output).toContain('src/index.ts');
      expect(output).toContain('src/utils.ts');
    });

    it('should include file sizes when available', () => {
      const results = [{ path: 'file.ts', type: 'file' as const, size: 2048 }];
      const output = formatSearchResults(results);
      expect(output).toContain('file.ts');
      expect(output).toContain('KB');
    });
  });

  describe('formatFileInfo', () => {
    const baseDate = new Date('2024-01-01');

    it('should format basic file info', () => {
      const info = {
        name: 'test.txt',
        path: '/test/path/test.txt',
        type: 'file' as const,
        size: 1234,
        created: baseDate,
        modified: new Date('2024-06-15'),
        accessed: new Date('2024-06-15'),
        permissions: 'rw-r--r--',
        isHidden: false,
      };
      const result = formatFileInfo(info);
      expect(result).toContain('test.txt');
      expect(result).toContain('/test/path/test.txt');
      expect(result).toContain('file');
      expect(result).toContain('1.21 KB');
      expect(result).toContain('rw-r--r--');
    });

    it('should include MIME type when available', () => {
      const info = {
        name: 'image.png',
        path: '/test/image.png',
        type: 'file' as const,
        size: 5000,
        created: baseDate,
        modified: baseDate,
        accessed: baseDate,
        permissions: 'rw-r--r--',
        isHidden: false,
        mimeType: 'image/png',
      };
      const result = formatFileInfo(info);
      expect(result).toContain('image/png');
    });

    it('should include symlink target when available', () => {
      const info = {
        name: 'link',
        path: '/test/link',
        type: 'symlink' as const,
        size: 0,
        created: baseDate,
        modified: baseDate,
        accessed: baseDate,
        permissions: 'lrwxrwxrwx',
        isHidden: false,
        symlinkTarget: '/actual/path',
      };
      const result = formatFileInfo(info);
      expect(result).toContain('/actual/path');
    });

    it('should indicate hidden files', () => {
      const info = {
        name: '.hidden',
        path: '/test/.hidden',
        type: 'file' as const,
        size: 100,
        created: baseDate,
        modified: baseDate,
        accessed: baseDate,
        permissions: 'rw-------',
        isHidden: true,
      };
      const result = formatFileInfo(info);
      expect(result).toContain('Yes'); // isHidden: Yes
    });
  });

  describe('formatContentMatches', () => {
    it('should handle empty matches', () => {
      const result = formatContentMatches([]);
      expect(result).toContain('No matches found');
    });

    it('should format content matches', () => {
      const matches: ContentMatch[] = [
        {
          file: '/test/src/index.ts',
          line: 10,
          content: 'const x = 1;',
          matchCount: 1,
        },
        {
          file: '/test/src/index.ts',
          line: 20,
          content: 'const y = 2;',
          matchCount: 1,
        },
      ];
      const result = formatContentMatches(matches);
      expect(result).toContain('index.ts');
      expect(result).toContain('10');
      expect(result).toContain('20');
      expect(result).toContain('const x = 1;');
      expect(result).toContain('const y = 2;');
    });

    it('should include context lines when available', () => {
      const matches: ContentMatch[] = [
        {
          file: '/test/file.ts',
          line: 10,
          content: 'target line',
          contextBefore: ['before line 1', 'before line 2'],
          contextAfter: ['after line 1'],
          matchCount: 1,
        },
      ];
      const result = formatContentMatches(matches);
      expect(result).toContain('before line 1');
      expect(result).toContain('before line 2');
      expect(result).toContain('target line');
      expect(result).toContain('after line 1');
    });

    it('should group matches by file', () => {
      const matches: ContentMatch[] = [
        { file: '/test/file1.ts', line: 1, content: 'line 1', matchCount: 1 },
        { file: '/test/file1.ts', line: 5, content: 'line 5', matchCount: 1 },
        { file: '/test/file2.ts', line: 3, content: 'line 3', matchCount: 1 },
      ];
      const result = formatContentMatches(matches);
      // Should contain both file names
      expect(result).toContain('file1.ts');
      expect(result).toContain('file2.ts');
    });
  });

  describe('formatDirectoryAnalysis', () => {
    it('should format summary and file types', () => {
      const analysis = {
        path: '/test',
        totalFiles: 3,
        totalDirectories: 1,
        totalSize: 1024,
        fileTypes: { '.ts': 2, '.json': 1 },
        largestFiles: [{ path: '/test/a.ts', size: 800 }],
        recentlyModified: [
          { path: '/test/a.ts', modified: new Date('2024-01-02') },
        ],
        maxDepth: 2,
      };
      const result = formatDirectoryAnalysis(analysis);
      expect(result).toContain('Directory Analysis');
      expect(result).toContain('Total Files: 3');
      expect(result).toContain('.ts: 2');
      expect(result).toContain('Largest Files:');
    });
  });

  describe('formatAllowedDirectories', () => {
    it('should handle empty allowed directories', () => {
      const result = formatAllowedDirectories([]);
      expect(result).toContain('No directories');
    });

    it('should list allowed directories', () => {
      const result = formatAllowedDirectories(['/a', '/b']);
      expect(result).toContain('/a');
      expect(result).toContain('/b');
    });
  });

  describe('formatOperationSummary', () => {
    it('should include truncation notice and tips', () => {
      const result = formatOperationSummary({
        truncated: true,
        truncatedReason: 'limit reached',
        tip: 'Reduce scope',
        skippedInaccessible: 2,
        symlinksNotFollowed: 1,
        skippedTooLarge: 3,
        skippedBinary: 4,
        linesSkippedDueToRegexTimeout: 5,
      });
      expect(result).toContain('PARTIAL RESULTS');
      expect(result).toContain('Reduce scope');
      expect(result).toContain('inaccessible');
      expect(result).toContain('symlink');
      expect(result).toContain('too large');
      expect(result).toContain('binary');
      expect(result).toContain('regex timeout');
    });
  });

  describe('formatTreeEntry', () => {
    it('should format tree entries recursively', () => {
      const tree = {
        name: 'root',
        type: 'directory' as const,
        children: [{ name: 'file.txt', type: 'file' as const, size: 100 }],
      };
      const result = formatTreeEntry(tree);
      expect(result).toContain('[DIR]');
      expect(result).toContain('[FILE]');
      expect(result).toContain('file.txt');
    });
  });
});
