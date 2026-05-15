import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

describe('progress message contract (tool shaping)', () => {
  it('find_files progress does not include scope/path', async () => {
    const src = await readFile('src/tools/search-files.ts', 'utf8');
    assert.match(
      src,
      /progress:\s*\(args\)\s*=>\s*\(\{[\s\S]*label:\s*'Find'[\s\S]*subject:\s*truncateProgressPattern\(args\.pattern\)/u,
    );
    assert.doesNotMatch(src, /progress:[\s\S]*scope:/u);
  });

  it('search_text progress does not include scope/path', async () => {
    const src = await readFile('src/tools/search-content.ts', 'utf8');
    assert.match(
      src,
      /progress:\s*\(args\)\s*=>\s*\(\{[\s\S]*label:\s*'Search'[\s\S]*subject:\s*truncateProgressPattern\(args\.searchPattern\)/u,
    );
    assert.doesNotMatch(src, /progress:[\s\S]*scope:/u);
  });

  it('replace_text progress format is unquoted A → B with no scope/path', async () => {
    const src = await readFile('src/tools/replace-in-files.ts', 'utf8');
    assert.match(
      src,
      /subject:\s*`\$\{truncateProgressPattern\(args\.searchPattern\)\}\s*→\s*\$\{truncateProgressPattern\(args\.replacement\)\}`/u,
    );
    assert.doesNotMatch(src, /subject:\s*`"\$\{/u);
    assert.doesNotMatch(src, /progress:[\s\S]*scope:/u);
  });

  it('read line-range progress uses separate scope segment (no filename:range subject)', async () => {
    const src = await readFile('src/tools/read.ts', 'utf8');
    assert.match(
      src,
      /else if \(args\.startLine !== undefined\)[\s\S]*scope = `\$\{args\.startLine\}-\$\{String\(end\)\}`/u,
    );
    assert.doesNotMatch(
      src,
      /const subject = `\$\{name\}:\$\{args\.startLine\}-\$\{String\(end\)\}`/u,
    );
  });

  it('tool definitions do not use progressDone augmentation', async () => {
    const files = [
      'src/tools/read.ts',
      'src/tools/create.ts',
      'src/tools/move.ts',
      'src/tools/delete-file.ts',
      'src/tools/edit.ts',
      'src/tools/list.ts',
      'src/tools/stat.ts',
      'src/tools/calculate-hash.ts',
      'src/tools/replace-in-files.ts',
      'src/tools/search-content.ts',
      'src/tools/search-files.ts',
    ];

    for (const file of files) {
      const src = await readFile(file, 'utf8');
      assert.doesNotMatch(src, /\bprogressDone\s*:/u, `${file} still defines progressDone`);
    }
  });
});
