#!/usr/bin/env node
 
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

function quote(value) {
  const text = String(value ?? '');
  return /[\s"]/u.test(text) ? `"${text.replaceAll('"', '\\"')}"` : text;
}

function formatCommand(command, args) {
  return `${command} ${args.map(quote).join(' ')}`.trim();
}

function run(command, args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: 'inherit',
      shell: false,
      windowsHide: true,
      env: process.env,
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      if (signal) {
        reject(
          new Error(
            `Command terminated by signal ${signal}: ${formatCommand(command, args)}`
          )
        );
        return;
      }
      if (code !== 0) {
        reject(
          new Error(
            `Command failed with exit code ${code}: ${formatCommand(command, args)}`
          )
        );
        return;
      }
      resolve();
    });
  });
}

async function assertExists(filePath) {
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat) {
    throw new Error(`Required path not found: ${filePath}`);
  }
}

async function writeFile(filePath, content) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, content, 'utf8');
}

async function createInvocationFixtures(outDir) {
  const fixturesDir = path.join(outDir, 'fixtures');
  const filesDir = path.join(fixturesDir, 'files');
  const fileA = path.join(filesDir, 'a.txt');
  const fileB = path.join(filesDir, 'b.txt');
  const patchFile = path.join(fixturesDir, 'apply_patch.patch');
  const fixtureManifest = path.join(outDir, 'invocation-fixtures.json');

  await writeFile(fileA, 'alpha\nbeta\n');
  await writeFile(fileB, 'one\ntwo\n');
  await writeFile(
    patchFile,
    [
      '--- a/files/a.txt',
      '+++ b/files/a.txt',
      '@@ -1,2 +1,2 @@',
      ' alpha',
      '-beta',
      '+BETA',
      '--- a/files/b.txt',
      '+++ b/files/b.txt',
      '@@ -1,2 +1,2 @@',
      ' one',
      '-two',
      '+TWO',
      '',
    ].join('\n')
  );

  const manifest = {
    fixtures: [
      {
        id: 'tool-read-many',
        method: 'tools/call',
        toolName: 'read_many',
        extraFlags: [
          '--tool-arg',
          `paths=["${fileA.replaceAll('\\', '/')}","${fileB.replaceAll('\\', '/')}"]`,
        ],
      },
      {
        id: 'tool-stat-many',
        method: 'tools/call',
        toolName: 'stat_many',
        extraFlags: [
          '--tool-arg',
          `paths=["${fileA.replaceAll('\\', '/')}","${fileB.replaceAll('\\', '/')}"]`,
        ],
      },
      {
        id: 'tool-apply-patch',
        method: 'tools/call',
        toolName: 'apply_patch',
        extraFlags: [
          '--tool-arg',
          `path=${fixturesDir.replaceAll('\\', '/')}`,
          '--tool-arg',
          'dryRun=true',
          '--tool-arg',
          `patch=@file:${patchFile.replaceAll('\\', '/')}`,
        ],
      },
      {
        id: 'prompt-analyze-path',
        method: 'prompts/get',
        promptName: 'analyze-path',
        extraFlags: ['--prompt-arg', `path=${fileA.replaceAll('\\', '/')}`],
      },
      {
        id: 'prompt-get-tool-help',
        method: 'prompts/get',
        promptName: 'get-tool-help',
        extraFlags: ['--prompt-arg', 'name=read_many'],
      },
    ],
  };

  await writeFile(fixtureManifest, `${JSON.stringify(manifest, null, 2)}\n`);
  return { fixtureManifest };
}

async function main() {
  const repoRoot = process.cwd();
  const codexHome =
    process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
  const skillScriptsDir = path.join(
    codexHome,
    'skills',
    'mcp-inspector-cli',
    'scripts'
  );
  const surfaceScript = path.join(skillScriptsDir, 'surface.mjs');
  const smokeScript = path.join(skillScriptsDir, 'smoke-test.mjs');
  const outDir = path.join(repoRoot, '.tmp', 'inspector');
  const surfaceJson = path.join(outDir, 'mcp-inspector-surface.json');
  const surfaceMd = path.join(outDir, 'mcp-inspector-surface.md');
  const smokeJson = path.join(outDir, 'smoke-test-results.json');
  const smokeMd = path.join(outDir, 'smoke-test-results.md');

  await assertExists(surfaceScript);
  await assertExists(smokeScript);
  await run('node', ['scripts/tasks.mjs', 'build'], repoRoot);
  await fs.mkdir(outDir, { recursive: true });
  const { fixtureManifest } = await createInvocationFixtures(outDir);
  await run(
    'node',
    [
      surfaceScript,
      '-Target',
      'node',
      '-TargetArgsJson',
      JSON.stringify(['dist/index.js', repoRoot]),
      '-OutFile',
      surfaceJson,
      '-MarkdownOutFile',
      surfaceMd,
    ],
    repoRoot
  );
  await run(
    'node',
    [
      smokeScript,
      '-ArtifactPath',
      surfaceJson,
      '-InvocationFixturesFile',
      fixtureManifest,
      '-FixtureOnly',
      '-MaxToolCalls',
      '10',
      '-MaxPromptGets',
      '10',
      '-MaxResourceReads',
      '3',
      '-OutFile',
      smokeJson,
      '-MarkdownOutFile',
      smokeMd,
    ],
    repoRoot
  );

  console.log(`Inspector discovery: ${surfaceJson}`);
  console.log(`Inspector smoke: ${smokeJson}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
