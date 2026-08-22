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

  it('find_files uses progressDone to report match counts', async () => {
    const src = await readFile('src/tools/search-files.ts', 'utf8');
    assert.match(src, /\bprogressDone\s*:\s*\(_args, result\)\s*=>/u);
    assert.match(src, /formatCount\(result\.totalMatches \?\? 0, 'match', 'matches'\)/u);
  });

  it('search_text uses progressDone to report match and file counts', async () => {
    const src = await readFile('src/tools/search-content.ts', 'utf8');
    assert.match(src, /\bprogressDone\s*:\s*\(_args, result\)\s*=>/u);
    assert.match(
      src,
      /buildSearchMatchDetail\(result\.totalMatches \?\? 0, result\.filesMatched \?\? 0\)/u,
    );
    assert.match(src, /formatCount\(totalMatches, 'match', 'matches'\)/u);
    assert.match(src, /formatCount\(filesMatched, 'file', 'files'\)/u);
  });

  it('delete progress formats single vs batch paths correctly', async () => {
    const src = await readFile('src/tools/delete-file.ts', 'utf8');
    assert.match(
      src,
      /subject:\s*args\.paths\.length === 1\s*\?\s*basename\(args\.paths\[0\] \?\? ''\)\s*:\s*`\$\{String\(args\.paths\.length\)\} paths`/u,
    );
  });
});
