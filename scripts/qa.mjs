#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { render } from './qa-report.mjs';

const HELP = `Usage: npm run qa [-- options]

Runs the manual QA cases through the MCP Inspector CLI against dist/index.js
and writes reports/qa/<timestamp>/{transcript.json,report.html}.

  --case <id>  Run only the case with this id; repeatable
  -h, --help   Show this help
`;

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_ENTRY = join(REPO_ROOT, 'dist', 'index.js');

const HEALTH_TIMEOUT_MS = 15_000;
const HEALTH_POLL_MS = 100;
const STEP_TIMEOUT_MS = 30_000;

// --- Inspector -------------------------------------------------------------

/**
 * Absolute path to the Inspector CLI entry, resolved through its own bin field.
 * `__tests__/inspector-harness.ts` duplicates this deliberately — this script
 * imports nothing from the test suite.
 */
function resolveInspectorBin() {
  const req = createRequire(import.meta.url);
  const pkgPath = req.resolve('@modelcontextprotocol/inspector/package.json');
  const pkg = req(pkgPath);
  return resolve(
    dirname(pkgPath),
    pkg.bin?.['mcp-inspector'] ?? './clients/launcher/build/index.js',
  );
}

// --- Fixture ---------------------------------------------------------------

/** Files the cases operate on, keyed by path relative to the fixture root. */
const FIXTURE_FILES = {
  'src/ten.txt': Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n') + '\n',
  'src/app.ts': 'const a = 1;\nconst b = 2;\n// TODO: fix\n',
  'src/app.copy.ts': 'const a = 1;\nconst b = 3;\n',
  'src/nested/deep.txt': 'ignored\n',
  '.env': 'SECRET=1\n',
  '.gitignore': 'node_modules/\n',
  'key.pem': 'not a real key\n',
  id_rsa: 'not a real key\n',
  'notes.secret': 'custom deny target\n',
  // Over the `limited` profile's 1 MiB cap. That is the smallest value
  // --max-file-size accepts; below it the server warns and uses its 10 MiB
  // default, so a smaller fixture could not exercise the limit.
  'big.txt': 'x'.repeat(1_200_000) + '\n',
  'bulk/a.txt': 'foo bar\nfoobar\n',
  'bulk/b.txt': 'foo bar\nfoobar\n',
  'del/a.txt': 'delete me\n',
  'redos.txt': 'a'.repeat(40) + '!\n',
  'page/p1.txt': 'x\n',
  'page/p2.txt': 'x\n',
  'page/p3.txt': 'x\n',
  'page/p4.txt': 'x\n',
  'page/p5.txt': 'x\n',
  // A 1x1 PNG, so the image content-block path has a real file to read.
  'pic.png': Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64',
  ),
};

async function buildFixture() {
  const root = join(tmpdir(), `fsqa-${randomUUID()}`);
  for (const [relative, content] of Object.entries(FIXTURE_FILES)) {
    const target = join(root, relative);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return root;
}

// --- Server profile --------------------------------------------------------

/** An OS-assigned free port on loopback. */
function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const probe = createServer();
    probe.on('error', rejectPort);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address();
      probe.close(() => {
        resolvePort(port);
      });
    });
  });
}

async function waitForHealth(port) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let lastError = 'no attempt made';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`);
      const body = await response.json();
      if (body?.status === 'ok') return;
      lastError = `unexpected body ${JSON.stringify(body)}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((tick) => setTimeout(tick, HEALTH_POLL_MS));
  }
  throw new Error(`server on port ${port} never became healthy: ${lastError}`);
}

/**
 * Start one long-lived HTTP server. Its stderr is captured as timestamped
 * chunks so a step can slice the window it ran in — the server outlives every
 * individual call, so its output cannot be attributed any other way.
 */
async function startProfile(name, serverArgs, runDir, env = {}) {
  const port = await freePort();
  const args = [SERVER_ENTRY, '--port', String(port), ...serverArgs];
  const child = spawn(process.execPath, args, {
    shell: false,
    windowsHide: true,
    env: { ...process.env, ...env },
  });
  const stderrChunks = [];
  child.stderr.on('data', (chunk) => {
    stderrChunks.push({ atMs: Date.now(), text: chunk.toString() });
  });
  child.stdout.resume();

  const configPath = join(runDir, `config-${name}.json`);
  await writeFile(
    configPath,
    JSON.stringify(
      {
        mcpServers: {
          fs: { protocolEra: 'modern', type: 'http', url: `http://127.0.0.1:${port}/mcp` },
        },
      },
      null,
      2,
    ),
    'utf-8',
  );

  try {
    await waitForHealth(port);
  } catch (error) {
    child.kill();
    throw error;
  }

  // Everything the server wrote before it was healthy belongs to the profile,
  // not to any step — the startup banner lands here (E4).
  const healthyAtMs = Date.now();

  return {
    name,
    port,
    args,
    configPath,
    startupStderr: () =>
      stderrChunks
        .filter((entry) => entry.atMs < healthyAtMs)
        .map((entry) => entry.text)
        .join(''),
    stderrSince: (fromMs) =>
      stderrChunks
        .filter((entry) => entry.atMs >= fromMs)
        .map((entry) => entry.text)
        .join(''),
    stop: () => {
      child.kill();
    },
  };
}

/**
 * Start every profile the selection needs, before any case runs. One retry per
 * profile: `freePort` releases the port before the server binds it, so a lost
 * race gets a fresh port on the second attempt.
 */
async function startProfiles(names, suite, fixtureDir, runDir) {
  const started = new Map();
  const failed = new Map();

  const attempt = async (name) => {
    const definition = suite.profiles[name];
    if (!definition) throw new Error(`case data names unknown profile '${name}'`);
    // No steps have run yet, so a step reference in a profile argument throws.
    const serverArgs = definition.args.map((arg) => substitute(arg, fixtureDir, []));
    const env = substitute(definition.env ?? {}, fixtureDir, []);
    try {
      return await startProfile(name, serverArgs, runDir, env);
    } catch {
      return await startProfile(name, serverArgs, runDir, env);
    }
  };

  await Promise.all(
    names.map(async (name) => {
      try {
        started.set(name, await attempt(name));
      } catch (error) {
        // Recorded, never thrown: one unusable profile must not cost the run
        // every case that could still have executed.
        failed.set(name, error instanceof Error ? error.message : String(error));
      }
    }),
  );

  return { started, failed };
}

// --- Case data -------------------------------------------------------------

/** Case files in the order their cases appear in a transcript. */
const CASE_GROUPS = ['func', 'int', 'sec', 'perf', 'smoke'];

/** Merge `scripts/qa-cases/` into one suite, split by id prefix. */
function loadSuite() {
  const req = createRequire(import.meta.url);
  const { profiles } = req('./qa-cases/profiles.json');
  const cases = CASE_GROUPS.flatMap((group) => req(`./qa-cases/${group}.json`).cases);
  return { profiles, cases };
}

// --- Case data contract ----------------------------------------------------

const SUITE_KEYS = ['profiles', 'cases'];
const PROFILE_KEYS = ['args', 'env'];
const CASE_KEYS = ['id', 'title', 'traceability', 'profile', 'steps'];
const STEP_KEYS = [
  'name',
  'method',
  'tool',
  'args',
  'expect',
  'skip',
  'prompt',
  'promptArgs',
  'uri',
];
const EXPECT_KEYS = ['isError', 'has', 'cliErrorCode'];

function unknownKey(object, allowed) {
  return Object.keys(object ?? {}).find((key) => !allowed.includes(key));
}

/**
 * Reject an unrecognised key before anything runs. Every field is read
 * positionally, so a typo does not crash — it drops the field and produces a
 * weaker check that still reports green.
 */
function validateSuite(suite) {
  const bad = unknownKey(suite, SUITE_KEYS);
  if (bad) return `qa-cases: unknown top-level key '${bad}'`;

  for (const [name, profile] of Object.entries(suite.profiles ?? {})) {
    const key = unknownKey(profile, PROFILE_KEYS);
    if (key) return `qa-cases: profile '${name}' has unknown key '${key}'`;
  }

  for (const testCase of suite.cases) {
    const where = testCase.id ?? '<case with no id>';
    if (!testCase.id) return 'qa-cases: a case is missing its id';
    const caseKey = unknownKey(testCase, CASE_KEYS);
    if (caseKey) return `qa-cases: case '${where}' has unknown key '${caseKey}'`;

    for (const step of testCase.steps) {
      const at = `case '${where}', step '${step.name ?? '<unnamed>'}'`;
      const stepKey = unknownKey(step, STEP_KEYS);
      if (stepKey) return `qa-cases: ${at} has unknown key '${stepKey}'`;
      if (!step.name) return `qa-cases: ${at} is missing its name`;
      if (!step.skip && !step.method) return `qa-cases: ${at} needs either method or skip`;
      const expectKey = unknownKey(step.expect, EXPECT_KEYS);
      if (expectKey) return `qa-cases: ${at} has unknown expect key '${expectKey}'`;
    }
  }

  return null;
}

// --- Substitution ----------------------------------------------------------

const STEP_REF = /^\$\{steps\[(\d+)\]\.(.+)\}$/;

/** Read a dot-path out of a value, returning undefined at the first gap. */
function readPath(source, path) {
  return path.split('.').reduce((node, key) => (node == null ? undefined : node[key]), source);
}

/**
 * Resolve `${FIXTURE}` and `${steps[N].dot.path}` inside a step's arguments.
 * An unresolvable reference throws rather than sending the literal token or a
 * null: a silently wrong argument reads as a server fault in the transcript.
 */
function substitute(value, fixtureDir, recordedSteps) {
  if (Array.isArray(value)) {
    return value.map((entry) => substitute(entry, fixtureDir, recordedSteps));
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [
        key,
        substitute(entry, fixtureDir, recordedSteps),
      ]),
    );
  }
  if (typeof value !== 'string') return value;

  const reference = STEP_REF.exec(value);
  if (reference) {
    const index = Number(reference[1]);
    const previous = recordedSteps[index];
    if (!previous) {
      throw new Error(`${value} refers to step ${index}, which has not run in this case`);
    }
    const resolved = readPath(previous.result, reference[2]);
    if (resolved === undefined) {
      throw new Error(`${value} resolved to undefined on step ${index}`);
    }
    return resolved;
  }

  return value.replaceAll('${FIXTURE}', fixtureDir.split('\\').join('/'));
}

// --- Expectations ----------------------------------------------------------

/**
 * Evaluate a step's optional expectations. Every check is soft: a mismatch is
 * recorded, never thrown, and never changes the process exit code.
 */
function evaluate(expect, recorded) {
  // No result at all is a failed call, whatever was expected of it — a
  // tool-level error still returns one, restated on stderr rather than
  // replacing stdout. Only a step expecting the envelope itself survives this.
  if (recorded.result === null && expect?.cliErrorCode === undefined) {
    return { checks: [], status: 'ERROR' };
  }
  if (!expect) return { checks: [], status: 'UNCHECKED' };
  const checks = [];

  if (expect.isError !== undefined) {
    const actual = recorded.result?.isError ?? false;
    checks.push({
      path: 'isError',
      expected: expect.isError,
      actual,
      ok: actual === expect.isError,
    });
  }

  for (const path of expect.has ?? []) {
    const actual = readPath(recorded.result, path);
    checks.push({ path, expected: 'defined', actual: actual ?? null, ok: actual !== undefined });
  }

  // A tool the server never registered produces no result at all, only a
  // stderr envelope — the shape the --read-only gate has to be checked against.
  if (expect.cliErrorCode !== undefined) {
    const actual = recorded.cliError?.code ?? null;
    checks.push({
      path: 'cliError.code',
      expected: expect.cliErrorCode,
      actual,
      ok: actual === expect.cliErrorCode,
    });
  }

  return { checks, status: checks.every((check) => check.ok) ? 'MATCH' : 'MISMATCH' };
}

// --- Step execution --------------------------------------------------------

/** Build the Inspector CLI argument vector for one step. */
function buildArgv(step, configPath) {
  const argv = ['--cli', '--method', step.method, '--format', 'json', '--stored-auth-only'];
  if (step.tool) argv.push('--tool-name', step.tool);
  if (step.args) argv.push('--tool-args-json', JSON.stringify(step.args));
  if (step.uri) argv.push('--uri', step.uri);
  if (step.prompt) argv.push('--prompt-name', step.prompt);
  for (const [key, value] of Object.entries(step.promptArgs ?? {})) {
    argv.push('--prompt-args', `${key}=${String(value)}`);
  }
  argv.push('--config', configPath, '--server', 'fs');
  return argv;
}

function runInspector(inspectorBin, argv) {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [inspectorBin, ...argv], {
      shell: false,
      windowsHide: true,
      timeout: STEP_TIMEOUT_MS,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('close', (code) => {
      settle({ exitCode: code ?? 1, stdout, stderr });
    });
    child.on('error', (error) => {
      settle({ exitCode: 1, stdout, stderr: `${stderr}\n${error.message}`.trim() });
    });
  });
}

/**
 * Split the CLI's two channels. stdout is authoritative: a tool-level error
 * arrives there with `isError: true` and is *also* restated on stderr, so only
 * a missing result means the call failed. The exit code classifies nothing.
 */
function classify(raw) {
  let result = null;
  const trimmedOut = raw.stdout.trim();
  if (trimmedOut) {
    try {
      const parsed = JSON.parse(trimmedOut);
      result = parsed.result !== undefined ? parsed.result : parsed;
    } catch {
      // Not JSON; `result` stays null and the step grades ERROR.
    }
  }

  let cliError = null;
  for (const line of raw.stderr.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed.error) cliError = parsed.error;
    } catch {
      // Not an envelope; the server's own banner shares this stream.
    }
  }

  return { result, cliError };
}

async function runStep(step, profile, inspectorBin, fixtureDir, recordedSteps) {
  const base = {
    name: step.name,
    method: step.method,
    ...(step.tool ? { tool: step.tool } : {}),
  };

  if (step.skip) {
    return { ...base, request: null, skipReason: step.skip, status: 'SKIPPED' };
  }

  // Only the three fields that carry references. Walking the whole step also
  // resolved `expect`, which is graded from the raw step — so a reference there
  // was silently discarded, or threw before the call was ever made.
  let resolved;
  try {
    resolved = {
      ...step,
      ...(step.args ? { args: substitute(step.args, fixtureDir, recordedSteps) } : {}),
      ...(step.uri ? { uri: substitute(step.uri, fixtureDir, recordedSteps) } : {}),
      ...(step.promptArgs
        ? { promptArgs: substitute(step.promptArgs, fixtureDir, recordedSteps) }
        : {}),
    };
  } catch (error) {
    return {
      ...base,
      request: null,
      error: error instanceof Error ? error.message : String(error),
      status: 'ERROR',
    };
  }

  const argv = buildArgv(resolved, profile.configPath);
  const startedMs = Date.now();
  const raw = await runInspector(inspectorBin, argv);
  const durationMs = Date.now() - startedMs;
  const { result, cliError } = classify(raw);

  const recorded = {
    ...base,
    request: { ...(resolved.args ? { args: resolved.args } : {}), argv },
    exitCode: raw.exitCode,
    durationMs,
    result,
    cliError,
    serverStderr: profile.stderrSince(startedMs),
  };

  const { checks, status } = evaluate(step.expect, recorded);
  return { ...recorded, expect: step.expect ?? null, checks, status };
}

// --- Run -------------------------------------------------------------------

/** A case is as bad as its worst step, but SKIPPED among healthy steps is PARTIAL. */
function caseStatus(statuses) {
  if (statuses.includes('ERROR')) return 'ERROR';
  if (statuses.includes('MISMATCH')) return 'MISMATCH';
  if (statuses.includes('SKIPPED')) {
    return statuses.every((status) => status === 'SKIPPED') ? 'SKIPPED' : 'PARTIAL';
  }
  return statuses.includes('MATCH') ? 'MATCH' : 'UNCHECKED';
}

/** Counts from the statuses actually present; the known ones seeded at zero. */
function summarize(cases) {
  const summary = { cases: cases.length, match: 0, mismatch: 0, partial: 0, skipped: 0, error: 0 };
  for (const entry of cases) {
    const key = entry.status.toLowerCase();
    summary[key] = (summary[key] ?? 0) + 1;
  }
  return summary;
}

/** Parse arguments, refusing anything unrecognised — as tasks.mjs does. */
function parseArgs(args) {
  const only = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] !== '--case') return { error: `Unknown option: ${args[i]}` };
    const value = args[i + 1];
    if (!value || value.startsWith('-')) return { error: '--case requires a case id' };
    only.push(value);
    i += 1;
  }
  return { only };
}

async function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }
  const { only, error: argError } = parseArgs(args);
  if (argError) {
    process.stderr.write(`${argError}\n\n${HELP}`);
    return 2;
  }

  // The server under test is a build artifact. Without this the failure is a
  // 15-second health timeout and a message about a port.
  let serverEntryModifiedAt;
  try {
    serverEntryModifiedAt = statSync(SERVER_ENTRY).mtime.toISOString();
  } catch {
    process.stderr.write(`${SERVER_ENTRY} is missing. Run npm run build first.\n`);
    return 2;
  }

  const inspectorBin = resolveInspectorBin();
  const suite = loadSuite();

  const suiteError = validateSuite(suite);
  if (suiteError) {
    process.stderr.write(`${suiteError}\n`);
    return 2;
  }

  if (only.length > 0) {
    const known = new Set(suite.cases.map((entry) => entry.id));
    const missing = only.filter((id) => !known.has(id));
    if (missing.length > 0) {
      process.stderr.write(`No such case id: ${missing.join(', ')}\n`);
      return 2;
    }
  }

  const startedAt = new Date().toISOString();
  const runDir = join(REPO_ROOT, 'reports', 'qa', startedAt.replace(/[:.]/g, '-'));
  await mkdir(runDir, { recursive: true });

  const fixtureDir = await buildFixture();
  let started = new Map();

  try {
    const selected = only.length
      ? suite.cases.filter((entry) => only.includes(entry.id))
      : suite.cases;

    const needed = [...new Set(selected.map((entry) => entry.profile ?? 'default'))];
    const profiles = await startProfiles(needed, suite, fixtureDir, runDir);
    started = profiles.started;

    const cases = [];
    for (const testCase of selected) {
      const profileName = testCase.profile ?? 'default';
      const base = {
        caseId: testCase.id,
        title: testCase.title,
        traceability: testCase.traceability ?? null,
        profile: profileName,
      };

      // A profile that never started takes its cases down with it, and no
      // further. The transcript still records why, for every case affected.
      const profileError = profiles.failed.get(profileName);
      if (profileError !== undefined) {
        cases.push({ ...base, steps: [], error: profileError, status: 'ERROR' });
        continue;
      }

      const profile = started.get(profileName);
      const steps = [];
      try {
        for (const step of testCase.steps) {
          steps.push(await runStep(step, profile, inspectorBin, fixtureDir, steps));
        }
      } catch (error) {
        cases.push({
          ...base,
          steps,
          error: error instanceof Error ? error.message : String(error),
          status: 'ERROR',
        });
        continue;
      }
      cases.push({ ...base, steps, status: caseStatus(steps.map((step) => step.status)) });
    }

    const transcript = {
      startedAt,
      finishedAt: new Date().toISOString(),
      serverEntryModifiedAt,
      fixtureDir,
      profiles: Object.fromEntries(
        [...started.values()].map((entry) => [
          entry.name,
          { port: entry.port, args: entry.args, startupStderr: entry.startupStderr() },
        ]),
      ),
      cases,
      summary: summarize(cases),
    };

    await writeFile(join(runDir, 'transcript.json'), JSON.stringify(transcript, null, 2), 'utf-8');
    // After the transcript, so a render failure throws with the record already
    // on disk. The standalone entry in qa-report.mjs re-renders an old run.
    await writeFile(join(runDir, 'report.html'), render(transcript, runDir), 'utf-8');
    process.stdout.write(`${runDir}\n`);
    return 0;
  } finally {
    for (const profile of started.values()) profile.stop();
    await rm(fixtureDir, { recursive: true, force: true });
  }
}

process.exitCode = await main(process.argv.slice(2));
