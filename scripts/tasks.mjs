#!/usr/bin/env node
/**
 * tasks.mjs — orchestrates the dev-loop checks (format, lint, type-check, knip, test, rebuild).
 *
 * Modes:
 *   default     format → [lint, type-check, knip] parallel → [test, rebuild] parallel  (fail-fast; stops on first phase failure)
 *   --fix       sequential, auto-fix format/lint/knip then re-run
 *   --quick     skip test + rebuild
 *   --all       continue past failures across all tasks (disables fail-fast)
 *   --json      machine-readable single-line JSON to stdout (suppresses human output)
 *   --llm       append failure-detail JSON block to stdout (also written to .tasks-last-failure.json)
 *   --detail [N] post-mortem source-window detail for the Nth test failure of the previous run
 *
 * Side-effect files (both .gitignored):
 *   .tasks-history.json       rolling window of the last MAX_DURATIONS=5 test durations per test name.
 *                             Used to derive an adaptive silence timeout: max(MIN_SILENCE_MS, 10 × max-historical).
 *   .tasks-last-failure.json  written on any non-zero exit, deleted on a green run.
 *                             Schema: { ok, mode, wallMs, tasks[], slowestTests[], failureSummary[], timestamp }.
 *
 * Exit codes: 0 ok | 1 failed | 2 cli error | 130 SIGINT | 143 SIGTERM | 128+N other signals.
 *
 * Honors NO_COLOR (https://no-color.org) and non-TTY stdout — ANSI escapes are suppressed in CI logs.
 *
 * Concurrency: not safe to run two instances in parallel against the same workspace
 * (history / failure JSON files race). Bounded internal parallelism is the static task list (≤3).
 *
 * Requires Node ≥22 (Promise.withResolvers, AbortSignal.any). Repo pins Node ≥24.
 */
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { createInterface as createLineReader } from 'node:readline';
import { createInterface as createPromptInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, stripVTControlCharacters } from 'node:util';

const runController = new AbortController();

const Config = Object.freeze({
  HISTORY_FILE: '.tasks-history.json',
  FAILURE_FILE: '.tasks-last-failure.json',
  MAX_DURATIONS: 5,
  MIN_SILENCE_MS: 30_000,
  STARTUP_MIN_MS: 30_000,
  MAX_STDERR_CHARS: 256 * 1024,
  MAX_STDOUT_CHARS: 1024 * 1024,
  MAX_STDERR_CHARS_EXEC: 256 * 1024,
  KILL_GRACE_MS: 5_000,
  RAW_OUTPUT_MAX_LINES: 40,
  MAX_ERRORS_IN_FILE: 1000,
  MAX_FAILURE_CARDS: 50,
  IS_WINDOWS: process.platform === 'win32',
});

const COLOR_ENABLED =
  !!process.stdout.isTTY &&
  !process.env.NO_COLOR &&
  process.env.TERM !== 'dumb' &&
  process.env.CI !== 'true';

const ansi = (code) => (COLOR_ENABLED ? code : '');

const Theme = Object.freeze({
  R: ansi('\x1b[0m'),
  BOLD: ansi('\x1b[1m'),
  DIM: ansi('\x1b[2m'),
  GREEN: ansi('\x1b[32m'),
  RED: ansi('\x1b[31m'),
  YELLOW: ansi('\x1b[33m'),
  CYAN: ansi('\x1b[36m'),
  BLUE: ansi('\x1b[34m'),
  CLEAR_EOL: ansi('\x1b[K'),
});

const Icons = Object.freeze({
  PASS: `${Theme.GREEN}✔${Theme.R}`,
  FAIL: `${Theme.RED}✖${Theme.R}`,
  RUN: `${Theme.BLUE}❯${Theme.R}`,
  SKIP: `${Theme.YELLOW}⊘${Theme.R}`,
  HANG: `${Theme.YELLOW}⧖${Theme.R}`,
  FIX: `${Theme.CYAN}↻${Theme.R}`,
});

const SignalExitCodes = Object.freeze({ SIGINT: 130, SIGTERM: 143 });

function signalExitCode(signalName) {
  return SignalExitCodes[signalName] ?? 128;
}

const HELP_TEXT = [
  'Usage: node scripts/tasks.mjs <command> [options]',
  '',
  'Commands:',
  '  check        Run validation (format → [lint, type, knip] → [test, rebuild])',
  '  fix          Auto-fix (format, lint, knip) then run validation',
  '  test         Run tests directly (bypasses orchestrator)',
  '  detail [n]   Show source-window detail for the Nth test failure',
  '',
  'Options for check / fix:',
  '  --quick      Skip test + rebuild (static checks only)',
  '  --all        Continue past failures across all tasks',
  '  --json       Emit single JSON object to stdout',
  '  --llm        Echo failure detail to stdout',
  '',
  'Options for test:',
  '  --watch                 Run node --test in watch mode',
  '  --timeout <ms>          Forward to node --test-timeout',
  '  --name-pattern <regex>   Forward to node --test-name-pattern',
  '  --shard <i/n>            Forward to node --test-shard',
  '  --update-snapshots      Forward to node --test-update-snapshots',
  '  --json                  Emit single JSON object to stdout',
  '  --llm                   Echo failure detail to stdout',
  '',
  'Options for detail:',
  '  --json                  Emit failure context as JSON',
  '  --llm                   Emit failure context as LLM-friendly markdown',
  '',
  'Note: when running under --permission, this script needs --allow-fs-read,',
  '  --allow-fs-write, and --allow-child-process to spawn npm/npx/tsc/node test runs.',
  '',
].join('\n');

class OutputBuffer {
  constructor(maxChars) {
    this.maxChars = maxChars;
    this.chunks = [];
    this.length = 0;
    this.isTruncated = false;
  }

  append(chunk) {
    if (this.isTruncated || !chunk) return;

    if (this.length + chunk.length > this.maxChars) {
      const remaining = this.maxChars - this.length;
      if (remaining > 0) {
        this.chunks.push(chunk.slice(0, remaining));
        this.length += remaining;
      }
      this.isTruncated = true;
    } else {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
  }

  toString() {
    if (this.chunks.length === 0) return '';
    if (this.chunks.length === 1) return this.chunks[0];
    return this.chunks.join('');
  }
}

const Text = {
  normalizePath(value) {
    return String(value || '').replaceAll('\\', '/');
  },

  joinOutput(stdout = '', stderr = '') {
    return `${stdout}\n${stderr}`.trim();
  },

  cap(value, maxChars) {
    const text = String(value || '');
    return text.length > maxChars ? text.slice(0, maxChars) : text;
  },

  elapsed(ms) {
    return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
  },

  plural(count, singular) {
    return `${count} ${singular}${count === 1 ? '' : 's'}`;
  },
};

const Json = {
  parse(value, fallback = null) {
    try {
      return JSON.parse(value);
    } catch {
      return fallback;
    }
  },
};

const FileStore = {
  async readJson(file, fallback) {
    let raw;
    try {
      raw = await readFile(file, 'utf8');
    } catch {
      return fallback;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      process.stderr.write(
        `${Theme.YELLOW}warning${Theme.R} corrupt JSON at ${file} (${err?.message || err}); using defaults\n`,
      );
      return fallback;
    }
  },

  async writeJsonAtomic(file, payload) {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(payload, null, 2) + '\n', 'utf8');
    await rename(tmp, file);
  },
};

const Results = {
  pass(extra = {}) {
    return { ok: true, ...extra };
  },

  fail(extra = {}) {
    return { ok: false, ...extra };
  },

  skip(reason = 'skipped') {
    return { ok: null, skipped: true, skipReason: reason };
  },

  raw(stdout = '', stderr = '', prefix = '', meta = {}) {
    const output = Text.joinOutput(stdout, stderr);
    const rawOutput = prefix ? `${prefix}\n${output}`.trim() : output;
    return this.fail({
      rawOutput,
      ...(meta.truncatedStdout ? { truncatedStdout: true } : {}),
      ...(meta.truncatedStderr ? { truncatedStderr: true } : {}),
      ...(meta.status !== undefined && meta.status !== null ? { status: meta.status } : {}),
      ...(meta.signal ? { signal: meta.signal } : {}),
      ...(meta.command ? { command: meta.command } : {}),
    });
  },

  diagnostics(errors) {
    const counts = countDiagnostics(errors);
    return this.fail({ errors, counts });
  },
};

function countDiagnostics(errors) {
  let errorCount = 0;
  let warningCount = 0;
  for (const diagnostic of errors || []) {
    if (diagnostic.severity === 'warning') warningCount++;
    else errorCount++;
  }
  return { errors: errorCount, warnings: warningCount };
}

function rejectForbiddenFlags(values, forbidden, command) {
  for (const flag of forbidden) {
    if (values[flag] !== undefined) {
      process.stderr.write(`Flag --${flag} is not supported for command '${command}'.\n`);
      process.exitCode = 2;
      return true;
    }
  }
  return false;
}

function parseCliConfig(args) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      options: {
        quick: { type: 'boolean' },
        all: { type: 'boolean' },
        json: { type: 'boolean' },
        llm: { type: 'boolean' },
        watch: { type: 'boolean' },
        timeout: { type: 'string' },
        'name-pattern': { type: 'string' },
        shard: { type: 'string' },
        'update-snapshots': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
      strict: true,
      allowPositionals: true,
    });
  } catch (err) {
    process.stderr.write(`${err?.message || String(err)}\n\n${HELP_TEXT}`);
    process.exitCode = 2;
    return null;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(HELP_TEXT);
    process.exitCode = 0;
    return null;
  }

  const command = positionals[0] ?? 'check';

  if (command === 'check' || command === 'fix') {
    if (
      rejectForbiddenFlags(
        values,
        ['watch', 'timeout', 'name-pattern', 'shard', 'update-snapshots'],
        command,
      )
    ) {
      return null;
    }
    return {
      command,
      quick: !!values.quick,
      all: values.all ?? false,
      json: !!values.json,
      llm: !!values.llm,
    };
  }

  if (command === 'test') {
    if (rejectForbiddenFlags(values, ['quick', 'all'], 'test')) return null;

    if (values.timeout !== undefined) {
      const n = Number(values.timeout);
      if (!Number.isInteger(n) || n < 1) {
        process.stderr.write(`--timeout requires a positive integer ms.\n`);
        process.exitCode = 2;
        return null;
      }
    }

    if (values.shard !== undefined && !/^\d+\/\d+$/.test(values.shard)) {
      process.stderr.write(`--shard requires <index>/<total>.\n`);
      process.exitCode = 2;
      return null;
    }

    return {
      command: 'test',
      watch: !!values.watch,
      testTimeout: values.timeout ? Number(values.timeout) : null,
      testNamePattern: values['name-pattern'] ?? null,
      testShard: values.shard ?? null,
      updateSnapshots: !!values['update-snapshots'],
      json: !!values.json,
      llm: !!values.llm,
    };
  }

  if (command === 'detail') {
    const rawIndex = positionals[1];
    const n = rawIndex === undefined ? null : Number(rawIndex);
    if (rawIndex !== undefined && (!Number.isInteger(n) || n < 1)) {
      process.stderr.write(`'detail' requires a positive integer failure index.\n`);
      process.exitCode = 2;
      return null;
    }

    if (
      rejectForbiddenFlags(
        values,
        ['quick', 'all', 'watch', 'timeout', 'name-pattern', 'shard', 'update-snapshots'],
        'detail',
      )
    ) {
      return null;
    }

    return {
      command: 'detail',
      index: n,
      json: !!values.json,
      llm: !!values.llm,
    };
  }

  process.stderr.write(`Unknown command '${command}'.\n\n${HELP_TEXT}`);
  process.exitCode = 2;
  return null;
}

function describeSpawnError(err, cmd) {
  const code = err?.code;
  const base = err?.message || String(err);
  if (code === 'ENOENT') {
    return `${base}\nhint: '${cmd}' was not found on PATH. Run 'npm install' (or ensure Node ≥24 / corepack is set up).`;
  }
  if (code === 'ERR_ACCESS_DENIED' || code === 'EACCES' || code === 'EPERM') {
    return `${base}\nhint: spawn was denied. If running under --permission, pass --allow-fs-read --allow-fs-write --allow-child-process.`;
  }
  return base;
}

const ProcessUtils = {
  forceKill(child) {
    if (!child) return;
    try {
      if (Config.IS_WINDOWS) {
        if (child.pid !== undefined) {
          spawn('taskkill', ['/F', '/T', '/PID', String(child.pid)], {
            stdio: 'ignore',
            windowsHide: true,
          }).on('error', noop);
        } else {
          child.kill();
        }
      } else {
        child.kill('SIGKILL');
      }
    } catch {
      // ignore kill errors
    }
  },

  forceKillAfterGrace(child, graceMs = Config.KILL_GRACE_MS) {
    return setTimeout(() => {
      this.forceKill(child);
    }, graceMs).unref();
  },
};

const ProcessRunner = {
  command(cmd, args) {
    if (Config.IS_WINDOWS && (cmd === 'npm' || cmd === 'npx')) {
      return {
        cmd: 'cmd.exe',
        args: ['/d', '/c', cmd, ...args],
        windowsVerbatimArguments: true,
      };
    }
    return { cmd, args, windowsVerbatimArguments: false };
  },

  spawnOptions(command, { signal, stdio = ['ignore', 'pipe', 'pipe'], encoding } = {}) {
    return {
      ...(stdio ? { stdio } : {}),
      ...(encoding ? { encoding } : {}),
      ...(signal ? { signal } : {}),
      ...(Config.IS_WINDOWS ? { windowsHide: true } : {}),
      ...(command.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {}),
    };
  },

  async execAsync(cmd, args, options = {}) {
    const {
      signal = runController.signal,
      maxStdout = Config.MAX_STDOUT_CHARS,
      maxStderr = Config.MAX_STDERR_CHARS_EXEC,
    } = options;
    const command = this.command(cmd, args);

    return new Promise((resolve) => {
      let settled = false;
      const stdoutBuf = new OutputBuffer(maxStdout);
      const stderrBuf = new OutputBuffer(maxStderr);

      const settle = (payload) => {
        if (settled) return;
        settled = true;
        resolve(payload);
      };

      let child;
      try {
        child = spawn(command.cmd, command.args, this.spawnOptions(command, { signal }));
      } catch (err) {
        settle({
          ok: false,
          stdout: '',
          stderr: describeSpawnError(err, cmd),
          status: null,
          signal: null,
          truncatedStdout: false,
          truncatedStderr: false,
        });
        return;
      }

      child.stdout?.setEncoding('utf8');
      child.stderr?.setEncoding('utf8');
      child.stdout?.on('error', noop);
      child.stderr?.on('error', noop);
      child.stdout?.on('data', (chunk) => {
        stdoutBuf.append(chunk);
      });
      child.stderr?.on('data', (chunk) => {
        stderrBuf.append(chunk);
      });
      child.on('close', (code, signalName) => {
        settle({
          ok: code === 0,
          stdout: stdoutBuf.toString(),
          stderr: stderrBuf.toString(),
          status: code,
          signal: signalName,
          truncatedStdout: stdoutBuf.isTruncated,
          truncatedStderr: stderrBuf.isTruncated,
        });
      });
      child.on('error', (err) => {
        if (err?.name === 'AbortError') return;
        settle({
          ok: false,
          stdout: stdoutBuf.toString(),
          stderr: describeSpawnError(err, cmd),
          status: null,
          signal: null,
          truncatedStdout: stdoutBuf.isTruncated,
          truncatedStderr: stderrBuf.isTruncated,
        });
      });
    });
  },
};

const HistoryManager = {
  async load(file = Config.HISTORY_FILE) {
    const parsed = await FileStore.readJson(file, null);
    return this.sanitize(parsed);
  },

  sanitize(parsed) {
    const test_durations = Object.create(null);
    const src = parsed && typeof parsed === 'object' ? parsed.test_durations : null;
    if (!src || typeof src !== 'object') return { test_durations };

    for (const [key, value] of Object.entries(src)) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
      if (!Array.isArray(value)) continue;
      test_durations[key] = value.filter((n) => typeof n === 'number' && Number.isFinite(n));
    }
    return { test_durations };
  },

  async save(history, newDurations, file = Config.HISTORY_FILE) {
    for (const [name, ms] of newDurations || []) {
      const arr = history.test_durations[name] || [];
      arr.push(ms);
      history.test_durations[name] = arr.slice(-Config.MAX_DURATIONS);
    }
    await FileStore.writeJsonAtomic(file, history);
  },

  getSilenceTimeout(history) {
    const all = Object.values(history.test_durations).flat();
    if (all.length === 0) return Config.MIN_SILENCE_MS;
    return Math.max(Config.MIN_SILENCE_MS, 10 * Math.max(...all));
  },
};

const EslintParser = {
  parse(jsonText, cwd) {
    const results = Json.parse(jsonText, []);
    if (!Array.isArray(results)) return [];

    const errors = [];
    for (const file of results) {
      const messages = Array.isArray(file?.messages) ? file.messages : [];
      if (messages.length === 0) continue;
      const rel = Text.normalizePath(path.relative(cwd, file.filePath || ''));
      for (const msg of messages) errors.push(this.toDiagnostic(msg, rel));
    }
    return errors;
  },

  toDiagnostic(msg, file) {
    const col = msg.column || 1;
    return {
      file,
      line: msg.line || 1,
      col,
      endCol: msg.endColumn || col + 3,
      rule: msg.ruleId || 'unknown',
      severity: msg.severity === 1 ? 'warning' : 'error',
      message: msg.message,
    };
  },
};

const TscParser = {
  RE: /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.+)$/,

  parse(text) {
    const errors = [];
    for (const line of String(text || '').split('\n')) {
      const match = this.RE.exec(line);
      if (!match) continue;
      errors.push({
        file: Text.normalizePath(match[1]),
        line: Number(match[2]),
        col: Number(match[3]),
        endCol: Number(match[3]) + 3,
        rule: match[5],
        severity: match[4],
        message: match[6],
      });
    }
    return errors;
  },
};

const KnipParser = {
  RULES: Object.freeze({
    files: { rule: 'unused-file', label: 'unused file' },
    dependencies: { rule: 'unused-dep', label: 'unused dependency' },
    devDependencies: { rule: 'unused-dev-dep', label: 'unused devDependency' },
    optionalPeerDependencies: {
      rule: 'unused-peer-dep',
      label: 'unused optional peer dependency',
    },
    unlisted: { rule: 'unlisted-dep', label: 'unlisted dependency' },
    binaries: { rule: 'unlisted-binary', label: 'unlisted binary' },
    unresolved: { rule: 'unresolved-import', label: 'unresolved import' },
    exports: { rule: 'unused-export', label: 'unused export' },
    types: { rule: 'unused-type', label: 'unused exported type' },
    nsExports: {
      rule: 'unused-ns-export',
      label: 'unused export in namespace',
    },
    nsTypes: { rule: 'unused-ns-type', label: 'unused type in namespace' },
    duplicates: { rule: 'duplicate-export', label: 'duplicate export' },
    enumMembers: { rule: 'unused-enum-member', label: 'unused enum member' },
    namespaceMembers: {
      rule: 'unused-ns-member',
      label: 'unused namespace member',
    },
    catalog: { rule: 'catalog-issue', label: 'catalog issue' },
  }),

  FIXABLE_RULES: new Set([
    'unused-dep',
    'unused-dev-dep',
    'unused-peer-dep',
    'unused-export',
    'unused-ns-export',
    'unused-enum-member',
    'unused-ns-member',
    'unused-type',
    'unused-ns-type',
  ]),

  RULE_ENTRIES: null,

  isFixable(errors) {
    return Array.isArray(errors) && errors.some((error) => this.FIXABLE_RULES.has(error.rule));
  },

  parse(jsonText) {
    const parsed = Json.parse(jsonText, {});
    const rows = Array.isArray(parsed?.issues) ? parsed.issues : [];
    const errors = [];
    for (const row of rows) this.parseRow(row, errors);
    return errors;
  },

  extractJson(stdout) {
    const text = String(stdout || '').trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    return start >= 0 && end > start ? text.slice(start, end + 1) : '';
  },

  parseRow(row, errors) {
    const file = row?.file ? Text.normalizePath(row.file) : '';
    if (!file) return;

    for (const [category, meta] of this.RULE_ENTRIES) {
      const list = row[category];
      if (!Array.isArray(list) || list.length === 0) continue;
      if (category === 'duplicates') this.pushDuplicateErrors(errors, file, list);
      else for (const entry of list) this.pushError(errors, file, category, meta, entry);
    }
  },

  pushDuplicateErrors(errors, file, groups) {
    for (const group of groups) {
      if (!Array.isArray(group) || group.length === 0) continue;
      const names = group
        .map((item) => item?.name)
        .filter(Boolean)
        .join(', ');
      const first = group[0] || {};
      this.pushError(errors, file, 'duplicates', this.RULES.duplicates, {
        name: names || 'duplicate',
        line: first.line,
        col: first.col,
      });
    }
  },

  parsePos(val) {
    return Number.isInteger(val) && val > 0 ? val : 1;
  },

  normalizeEntry(entry) {
    const line = this.parsePos(entry?.line);
    const col = this.parsePos(entry?.col);
    const name = entry?.name || '';
    const namespace = entry?.namespace ? `${entry.namespace}.` : '';
    return { line, col, name, namespace };
  },

  pushError(errors, file, category, meta, entry) {
    const { line, col, name, namespace } = this.normalizeEntry(entry);
    const message =
      category === 'files'
        ? 'Unused file (no references found)'
        : `${meta.label}: ${namespace}${name}`;

    errors.push({
      file,
      line,
      col,
      endCol: col + Math.max(3, String(name).length || 3),
      rule: meta.rule,
      severity: 'error',
      message,
    });
  },
};

// Cache rule entries once; `KnipParser.RULES` is frozen so the entries list is stable.
KnipParser.RULE_ENTRIES = Object.freeze(Object.entries(KnipParser.RULES));

const JsonLParser = {
  parseLine(line) {
    if (!line.trim()) return null;
    try {
      return JSON.parse(line);
    } catch {
      return null;
    }
  },
};

class TestJsonState {
  constructor() {
    this.seenFirstOk = false;
    this.lastCompleted = null;
    this.testDurations = new Map();
    this.failures = [];
    this.stderrBuf = new OutputBuffer(Config.MAX_STDERR_CHARS);
  }

  appendStderr(chunk) {
    this.stderrBuf.append(chunk);
  }

  handleLine(line) {
    const ev = JsonLParser.parseLine(line);
    if (!ev) return;

    if (ev.type === 'test:pass') {
      this.seenFirstOk = true;
      const ms = ev.data.details?.duration_ms || 0;
      this.testDurations.set(ev.data.name, ms);
      this.lastCompleted = { name: ev.data.name, duration: ms };
    } else if (ev.type === 'test:fail') {
      this.seenFirstOk = true;
      this.failures.push(this.enrichFailure(ev.data));
    }
  }

  enrichFailure(data) {
    const errorObj = data.details?.error || {};
    const cause = errorObj.cause || {};

    // Parse stack for the specific frame if available
    let frame = errorObj.stack || null;
    let errorMessage = errorObj.message || 'unknown test failure';

    // Fallbacks for assertion errors where exact operator / diff is used
    let expected = cause.expected;
    let actual = cause.actual;

    if (cause.name === 'AssertionError') {
      errorMessage = cause.message || 'AssertionError';
      frame = cause.stack || frame;
    } else if (errorObj.failureType === 'testTimeoutFailure') {
      errorMessage = errorObj.cause || 'Test timed out';
    } else if (errorObj.failureType === 'subtestsFailed') {
      errorMessage = 'Subtests failed';
    }

    return {
      name: data.name,
      file: data.file ? path.relative(process.cwd(), data.file) : '',
      expected: expected !== undefined ? String(expected) : undefined,
      actual: actual !== undefined ? String(actual) : undefined,
      errorMessage,
      frame,
      rawEvent: data,
    };
  }
}

class TestRunner {
  constructor({
    historyManager = HistoryManager,
    signal = runController.signal,
    testConfig = {},
  } = {}) {
    this.historyManager = historyManager;
    this.signal = signal;
    this.testConfig = testConfig;
  }

  buildArgv() {
    const argv = [
      '--enable-source-maps',
      '--import',
      'tsx/esm',
      '--env-file-if-exists=.env',
      '--test',
      '--no-warnings',
      '--test-reporter=./scripts/test-reporter.mjs',
    ];
    if (!Config.IS_WINDOWS) {
      argv.push(
        '--report-on-signal',
        '--report-signal=SIGUSR2',
        '--report-filename=.tasks-test-hang.json',
        '--report-exclude-env',
        '--report-exclude-network',
      );
    }
    if (this.testConfig.testTimeout) {
      argv.push(`--test-timeout=${this.testConfig.testTimeout}`);
    }
    if (this.testConfig.testNamePattern) {
      argv.push(`--test-name-pattern=${this.testConfig.testNamePattern}`);
    }
    if (this.testConfig.testShard) {
      argv.push(`--test-shard=${this.testConfig.testShard}`);
    }
    if (this.testConfig.updateSnapshots) {
      argv.push('--test-update-snapshots');
    }
    return argv;
  }

  async run() {
    const history = await this.historyManager.load();
    const silenceMs = this.historyManager.getSilenceTimeout(history);
    const startupMs = Math.max(silenceMs, Config.STARTUP_MIN_MS);
    const abortController = new AbortController();
    const state = new TestJsonState();

    const child = spawn(
      process.execPath,
      this.buildArgv(),
      ProcessRunner.spawnOptions(
        {},
        { signal: AbortSignal.any([abortController.signal, this.signal]) },
      ),
    );

    child.stdout?.on('error', noop);
    child.stderr?.on('error', noop);
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk) => state.appendStderr(chunk));

    const lines = createLineReader({
      input: child.stdout,
      crlfDelay: Infinity,
    });
    lines.on('error', noop);
    const { promise, resolve } = Promise.withResolvers();
    let resolved = false;
    let activeTimerMs = startupMs;
    let silenceTimer;

    const settle = (value) => {
      if (resolved) return;
      resolved = true;
      if (silenceTimer) clearTimeout(silenceTimer);
      lines.close();
      resolve(value);
    };

    const forceKillAfterGrace = () => ProcessUtils.forceKillAfterGrace(child);

    const handleTimeout = async () => {
      const maxHistorical = Math.max(0, ...Object.values(history.test_durations).flat());
      const phase = state.seenFirstOk ? 'between-tests' : 'startup';
      const ms = state.seenFirstOk ? silenceMs : startupMs;

      // Ask the test child to write its own diagnostic report (active handles, native stacks)
      // via --report-on-signal=SIGUSR2 (POSIX only). Wait briefly for it to flush, then abort.
      if (!Config.IS_WINDOWS && child.pid !== undefined) {
        try {
          child.kill('SIGUSR2');
        } catch {
          // ignore signal errors
        }
        try {
          await once(child, 'close', { signal: AbortSignal.timeout(500) });
        } catch {
          // ignore drain/timeout errors
        }
      }

      try {
        abortController.abort(new Error('test silence timeout'));
      } catch {
        // ignore abort errors
      }

      const killTimer = forceKillAfterGrace();
      try {
        await once(child, 'close');
      } catch {
        // ignore close errors
      }
      clearTimeout(killTimer);
      settle({
        ok: false,
        timeout: true,
        silenceMs: ms,
        phase,
        lastCompletedTest: state.lastCompleted,
        suiteMaxHistoricalMs: maxHistorical,
        rawOutput: state.stderrBuf.toString() || undefined,
        environment: {
          memoryAtFailure: process.memoryUsage(),
          activeHandles: process.getActiveResourcesInfo(),
          cpuUsage: process.cpuUsage(),
        },
      });
    };

    silenceTimer = setTimeout(handleTimeout, activeTimerMs).unref();

    const armTimer = () => {
      if (state.seenFirstOk && activeTimerMs !== silenceMs) {
        clearTimeout(silenceTimer);
        activeTimerMs = silenceMs;
        silenceTimer = setTimeout(handleTimeout, activeTimerMs).unref();
        return;
      }
      silenceTimer.refresh();
    };

    lines.on('line', (line) => {
      armTimer();
      state.handleLine(line);
    });

    child.on('error', (err) => {
      if (err?.name === 'AbortError') return;
      settle(Results.fail({ rawOutput: err?.message || String(err) }));
    });

    child.on('close', async (code) => {
      if (state.failures.length > 0) {
        settle(
          Results.fail({
            failures: state.failures,
            testDurations: state.testDurations,
            environment: {
              memoryAtFailure: process.memoryUsage(),
              activeHandles: process.getActiveResourcesInfo(),
              cpuUsage: process.cpuUsage(),
            },
          }),
        );
        return;
      }

      if (code !== 0) {
        settle(
          Results.fail({
            rawOutput: state.stderrBuf.toString() || `test runner exited with code ${code}`,
            environment: {
              memoryAtFailure: process.memoryUsage(),
              activeHandles: process.getActiveResourcesInfo(),
              cpuUsage: process.cpuUsage(),
            },
          }),
        );
        return;
      }

      try {
        await this.historyManager.save(history, state.testDurations);
      } catch {
        // best-effort: history write must never fail a green run
      }
      settle(Results.pass({ testDurations: state.testDurations }));
    });

    return promise;
  }
}

const TaskCommands = {
  format(config) {
    return ['npm', ['run', config.fix ? 'format' : 'format:check']];
  },

  lintCheck() {
    return ['npx', ['eslint', '.', '--max-warnings=0', '--format=json']];
  },

  lintFix() {
    return ['npm', ['run', 'lint:fix']];
  },

  typeCheck() {
    return ['npx', ['tsc', '-p', 'tsconfig.json', '--noEmit', '--pretty', 'false']];
  },

  knipCheck() {
    return ['npx', ['knip', '--reporter', 'json', '--no-progress']];
  },

  knipFix() {
    // NOTE: knip ignores comma-separated values passed to a single `--fix-type` flag
    // (it parses the whole string as one type and silently disables all fixes).
    // Repeating the flag is the only reliable form, so keep this as multiple `--fix-type` args.
    // `--format` is intentionally omitted: on Windows knip spawns `npx prettier`
    // without a shell and crashes with ENOENT. We run `npm run format` ourselves
    // after a successful knip --fix (see TaskOrchestrator.attemptAutoFix).
    return [
      'npx',
      [
        'knip',
        '--fix',
        '--fix-type',
        'exports',
        '--fix-type',
        'types',
        '--fix-type',
        'dependencies',
      ],
    ];
  },

  build() {
    return ['npm', ['run', 'build']];
  },
};

const TaskRunners = {
  async command(cmd, args) {
    const result = await ProcessRunner.execAsync(cmd, args);
    if (result.ok) return Results.pass();
    return Results.raw(result.stdout, result.stderr, '', {
      truncatedStdout: result.truncatedStdout,
      truncatedStderr: result.truncatedStderr,
      status: result.status,
      signal: result.signal,
      command: `${cmd} ${args.join(' ')}`.trim(),
    });
  },

  async diagnosticCommand({ command, parse, output = (result) => result.stdout }) {
    const [cmd, args] = command;
    const result = await ProcessRunner.execAsync(cmd, args);
    if (result.ok) return Results.pass();

    const text = output(result);
    const errors = parse(text);
    if (errors.length === 0) {
      return Results.raw(result.stdout, result.stderr, '', {
        truncatedStdout: result.truncatedStdout,
        truncatedStderr: result.truncatedStderr,
        status: result.status,
        signal: result.signal,
        command: `${cmd} ${args.join(' ')}`.trim(),
      });
    }
    return Results.diagnostics(errors);
  },

  async runFormat(config) {
    return this.command(...TaskCommands.format(config));
  },

  async runLint(fix) {
    if (fix) {
      const result = await this.command(...TaskCommands.lintFix());
      if (!result.ok) return result;
      // Validate after mutating so a green --fix cannot hide residual lint errors.
    }
    return this.diagnosticCommand({
      command: TaskCommands.lintCheck(),
      parse: (stdout) => EslintParser.parse(stdout || '[]', process.cwd()),
    });
  },

  async runTypeCheck() {
    return this.diagnosticCommand({
      command: TaskCommands.typeCheck(),
      parse: (text) => TscParser.parse(text),
      output: (result) => Text.joinOutput(result.stdout, result.stderr),
    });
  },

  async runKnip() {
    return this.diagnosticCommand({
      command: TaskCommands.knipCheck(),
      parse: (stdout) => KnipParser.parse(KnipParser.extractJson(stdout)),
      output: (result) => result.stdout,
    });
  },

  async runBuild() {
    try {
      await rm('dist', { recursive: true, force: true });
    } catch (err) {
      return Results.fail({
        rawOutput: `dist removal failed: ${err?.message || String(err)}`,
      });
    }
    return this.command(...TaskCommands.build());
  },

  async runTest(testConfig = {}) {
    return new TestRunner({ testConfig }).run();
  },
};

function parseFrame(frame) {
  let f = String(frame || '');
  if (f.startsWith('file:')) {
    const suffix = /(:\d+:\d+)$/.exec(f);
    if (suffix) {
      try {
        f = fileURLToPath(f.slice(0, f.length - suffix[0].length)) + suffix[0];
      } catch {
        // not a valid file URL; fall through to plain path parsing
      }
    }
  }
  const m3 = /^(.+):(\d+):(\d+)$/.exec(f);
  if (m3) return { file: m3[1], line: Number(m3[2]), col: Number(m3[3]) };
  const m2 = /^(.+):(\d+)$/.exec(f);
  if (m2) return { file: m2[1], line: Number(m2[2]), col: 1 };
  return null;
}

class SourceCache {
  constructor() {
    this.cache = new Map();
  }

  clear() {
    this.cache.clear();
  }

  lines(filePath) {
    if (this.cache.has(filePath)) return this.cache.get(filePath);
    let lines;
    try {
      lines = readFileSync(filePath, 'utf8').split('\n');
    } catch {
      lines = [];
    }
    this.cache.set(filePath, lines);
    return lines;
  }
}

const sourceCache = new SourceCache();

const OutputRenderer = {
  clearCache() {
    sourceCache.clear();
  },

  renderSourceWindow(filePath, line, col) {
    const src = filePath ? sourceCache.lines(path.resolve(process.cwd(), filePath)) : [];
    const BEFORE = 4;
    const AFTER = 5;
    const startLine = Math.max(1, line - BEFORE);
    const endLine = Math.min(src.length || line, line + AFTER);
    const gutterW = String(endLine).length;
    const pad = ' '.repeat(gutterW);
    const output = [];

    output.push(`${Theme.DIM}${pad} |${Theme.R}`);
    for (let n = startLine; n <= endLine; n++) {
      const srcLine = src[n - 1] || '';
      const gutter = String(n).padStart(gutterW);
      if (n === line) {
        output.push(`${Theme.BOLD}${gutter}${Theme.R} ${Theme.DIM}│${Theme.R} ${srcLine}`);
        output.push(
          `${Theme.DIM}${pad} │${Theme.R} ${' '.repeat(Math.max(0, col - 1))}${Theme.RED}^^^${Theme.R}`,
        );
      } else {
        output.push(`${Theme.DIM}${gutter} │ ${srcLine}${Theme.R}`);
      }
    }
    output.push(`${Theme.DIM}${pad} |${Theme.R}`);
    return output.join('\n');
  },

  formatDetailView(failure, index, environment = null) {
    const { name, frame, errorMessage, expected, actual } = failure;
    let errorLabel;
    if (expected !== undefined && actual !== undefined) {
      errorLabel = 'AssertionError';
    } else if (errorMessage) {
      errorLabel = errorMessage;
    } else {
      errorLabel = 'unknown error';
    }

    const output = [];
    output.push(`\n  ${Theme.BOLD}Failure ${index}${Theme.R} — ${name}\n`);
    output.push(`  ${Theme.RED}error${Theme.R}  ${Theme.DIM}${errorLabel}${Theme.R}`);

    if (expected !== undefined && actual !== undefined) {
      const expLines = String(expected).split('\n');
      const actLines = String(actual).split('\n');
      output.push(`\n    ${Theme.DIM}Expected:${Theme.R}`);
      for (const line of expLines) output.push(`    ${Theme.RED}- ${line}${Theme.R}`);
      output.push(`    ${Theme.DIM}Actual:${Theme.R}`);
      for (const line of actLines) output.push(`    ${Theme.GREEN}+ ${line}${Theme.R}`);
      output.push('');
    }

    if (frame) {
      output.push(`    ${Theme.DIM}-->${Theme.R} ${frame}\n`);
      const parsed = parseFrame(frame);
      if (parsed) {
        output.push(this.renderSourceWindow(parsed.file, parsed.line, parsed.col));
      }
    } else {
      output.push(`  ${Theme.DIM}(no source location available)${Theme.R}`);
    }

    if (environment) {
      output.push(`\n  ${Theme.DIM}Environment at failure:${Theme.R}`);
      if (environment.memoryAtFailure) {
        const mem = environment.memoryAtFailure;
        output.push(
          `  ${Theme.DIM}  Memory: ${Math.round(mem.rss / 1024 / 1024)}MB RSS, ${Math.round(mem.heapUsed / 1024 / 1024)}MB Heap${Theme.R}`,
        );
      }
      if (environment.activeHandles) {
        output.push(
          `  ${Theme.DIM}  Active Handles: ${environment.activeHandles.length}${Theme.R}`,
        );
      }
    }
    return output.join('\n');
  },

  renderDetailView(failure, index, environment = null) {
    process.stdout.write(this.formatDetailView(failure, index, environment) + '\n');
  },

  renderDiagnostic(error, cwd = process.cwd()) {
    const { file, line, col, endCol, rule, severity, message } = error;
    const color = severity === 'warning' ? Theme.YELLOW : Theme.RED;
    const output = [];

    output.push(`${color}${severity}[${rule}]${Theme.R}  ${message}`);
    output.push(`  ${Theme.DIM}-->${Theme.R} ${file}:${line}:${col}`);

    const src = sourceCache.lines(path.resolve(cwd, file));
    const gutterW = String(line + 1).length;
    const pad = ' '.repeat(gutterW);
    const underlineLen = Math.max(3, (endCol || col + 3) - col);
    const underline = '^'.repeat(underlineLen);

    output.push(`${Theme.DIM}${pad} |${Theme.R}`);
    this.renderSourceContext(output, src, line, col, pad, gutterW, color, underline);
    return output.join('\n');
  },

  renderSourceContext(output, src, line, col, pad, gutterW, color, underline) {
    if (line < 1 || line > src.length) {
      output.push(
        `${Theme.DIM}${pad} │${Theme.R} ${' '.repeat(col - 1)}${color}${underline}${Theme.R}`,
      );
      return;
    }

    for (const n of [line - 1, line, line + 1]) {
      if (n < 1 || n > src.length) continue;
      const srcLine = src[n - 1] || '';
      const gutter = String(n).padStart(gutterW);
      if (n === line) {
        output.push(`${Theme.BOLD}${gutter}${Theme.R} ${Theme.DIM}│${Theme.R} ${srcLine}`);
        output.push(
          `${Theme.DIM}${pad} │${Theme.R} ${' '.repeat(col - 1)}${color}${underline}${Theme.R}`,
        );
      } else {
        output.push(`${Theme.DIM}${gutter} │ ${srcLine}${Theme.R}`);
      }
    }
  },

  formatDiagnosticsGrouped(errors, cwd = process.cwd()) {
    const byFile = new Map();
    for (const err of errors) {
      const list = byFile.get(err.file) || [];
      list.push(err);
      byFile.set(err.file, list);
    }

    const output = [];
    for (const [file, list] of byFile) {
      output.push(`  ${Theme.BOLD}${file}${Theme.R}\n`);
      for (const err of list) {
        const block = this.renderDiagnostic(err, cwd)
          .split('\n')
          .map((line) => `    ${line}`)
          .join('\n');
        output.push(`${block}\n`);
      }
    }
    return output.join('\n');
  },

  renderDiagnosticsGrouped(errors, cwd = process.cwd()) {
    process.stdout.write(this.formatDiagnosticsGrouped(errors, cwd) + '\n');
  },

  emitLlmBlock(data) {
    const HR = '─'.repeat(53);
    process.stdout.write(
      `\n${HR}\n## LLM CONTEXT\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n${HR}\n\n`,
    );
  },
};

class Aggregate {
  constructor(mode) {
    this.mode = mode;
    this.tasks = [];
    this.passed = 0;
    this.failed = 0;
    this.skipped = 0;
    this.slowestTests = [];
    this.wallStart = Date.now();
  }

  record(label, result, ms) {
    if (result.skipped) return this.recordSkip(label, result.skipReason);
    if (result.ok) return this.recordPass(label, ms, result.annotation);
    return this.recordFail(label, result, ms);
  }

  recordPass(label, ms, annotation) {
    this.tasks.push({
      label,
      ok: true,
      ms,
      skipped: false,
      ...(annotation ? { annotation } : {}),
    });
    this.passed++;
  }

  recordFail(label, result, ms) {
    this.tasks.push({
      label,
      ok: false,
      ms,
      skipped: false,
      ...(result.counts ? { counts: result.counts } : {}),
      ...(result.errors ? { errors: result.errors.slice(0, Config.MAX_ERRORS_IN_FILE) } : {}),
      ...(result.failures ? { failures: result.failures.slice(0, Config.MAX_ERRORS_IN_FILE) } : {}),
      ...(result.timeout
        ? {
            timeout: true,
            phase: result.phase,
            silenceMs: result.silenceMs,
            ...(result.lastCompletedTest ? { lastCompletedTest: result.lastCompletedTest } : {}),
            ...(result.suiteMaxHistoricalMs
              ? { suiteMaxHistoricalMs: result.suiteMaxHistoricalMs }
              : {}),
          }
        : {}),
      ...(result.environment ? { environment: result.environment } : {}),
      ...(result.rawOutput ? { rawOutput: Text.cap(result.rawOutput, 4000) } : {}),
      ...(result.truncatedStdout ? { truncatedStdout: true } : {}),
      ...(result.truncatedStderr ? { truncatedStderr: true } : {}),
      ...(result.status !== undefined && result.status !== null ? { status: result.status } : {}),
      ...(result.signal ? { signal: result.signal } : {}),
      ...(result.command ? { command: result.command } : {}),
    });
    this.failed++;
  }

  recordSkip(label, reason) {
    this.tasks.push({
      label,
      ok: null,
      ms: 0,
      skipped: true,
      skipReason: reason,
    });
    this.skipped++;
  }

  setSlowestTests(testDurations) {
    if (!testDurations || testDurations.size === 0) return;
    this.slowestTests = [...testDurations.entries()]
      .map(([name, ms]) => ({ name, ms: typeof ms === 'number' ? ms : 0 }))
      .sort((a, b) => b.ms - a.ms)
      .slice(0, 5);
  }

  wallMs() {
    return Date.now() - this.wallStart;
  }

  failures() {
    return this.tasks.filter((task) => task.ok === false);
  }

  failureSummary() {
    const failed = this.failures();
    if (failed.length === 0) return null;
    return failed
      .map((task) => {
        if (task.timeout) return `${task.label}: timeout`;
        if (task.counts?.errors)
          return `${task.label}: ${Text.plural(task.counts.errors, 'error')}`;
        if (task.failures) return `${task.label}: ${Text.plural(task.failures.length, 'failure')}`;
        return `${task.label}: failed`;
      })
      .join(', ');
  }
}

class BaseReporter {
  constructor(config, colWidth) {
    this.config = config;
    this.col = colWidth;
    this.tickerHandle = null;
  }

  header() {
    // no-op
  }
  taskStart() {
    // no-op
  }
  taskEnd() {
    // no-op
  }
  groupStart() {
    // no-op
  }
  groupTaskEnd() {
    // no-op
  }
  groupEnd() {
    // no-op
  }
  failureDetail() {
    // no-op
  }
  summary() {
    // no-op
  }
}

class TtyReporter extends BaseReporter {
  constructor(config, colWidth) {
    super(config, colWidth);
    this.useTicker = !!process.stdout.isTTY;
    this.tickerStart = 0;
    this.groupLabels = null;
    this.groupDone = null;
    this.groupStartMs = 0;
  }

  header() {
    const cmd = `${Theme.CYAN}${this.config.command}${Theme.R}`;
    const flags = ['quick', 'all']
      .filter((flag) => this.config[flag])
      .map((flag) => `${Theme.YELLOW}--${flag}${Theme.R}`);
    const suffix = flags.length > 0 ? ` ${flags.join(' ')}` : '';
    process.stdout.write(`\n  ${Theme.BOLD}Filesystem MCP Server${Theme.R} ${cmd}${suffix}\n\n`);
  }

  taskStart(label) {
    this.tickerStart = Date.now();
    if (this.useTicker) {
      this.writeTaskLine(Icons.RUN, label, '');
      this.tickerHandle = setInterval(() => {
        this.writeTaskLine(
          Icons.RUN,
          label,
          `${Theme.DIM}${Text.elapsed(Date.now() - this.tickerStart)}${Theme.R}`,
        );
      }, 1000).unref();
    }
    // In non-TTY mode we wait until taskEnd to emit a single final line.
  }

  taskEnd(label, result, ms) {
    this.stopTicker();
    const icon = this.resultIcon(result);
    const right = this.resultRight(result, ms);
    this.writeTaskLine(icon, label, right, true);
  }

  writeTaskLine(icon, label, right = '', newline = false) {
    if (!this.useTicker) {
      process.stdout.write(
        `  ${icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}${right ? `  ${right}` : ''}\n`,
      );
      return;
    }
    process.stdout.write(
      `\x1b[2K\r  ${icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}${right ? `  ${right}` : ''}${newline ? '\n' : ''}`,
    );
  }

  resultIcon(result) {
    if (result.skipped) return Icons.SKIP;
    if (result.ok) return Icons.PASS;
    if (result.timeout) return Icons.HANG;
    return Icons.FAIL;
  }

  resultRight(result, ms) {
    if (result.skipped) return `${Theme.DIM}${result.skipReason || 'skipped'}${Theme.R}`;
    const time = `${Theme.DIM}${Text.elapsed(ms)}${Theme.R}`;
    const counts = this.formatCounts(result.counts);
    let right = counts ? `${time}  ${counts}` : time;
    if (result.annotation) right += `  ${Theme.DIM}(${result.annotation})${Theme.R}`;
    return right;
  }

  formatCounts(counts) {
    if (!counts) return null;
    const parts = [];
    if (counts.errors) parts.push(`${Theme.RED}${Text.plural(counts.errors, 'error')}${Theme.R}`);
    if (counts.warnings)
      parts.push(`${Theme.YELLOW}${Text.plural(counts.warnings, 'warning')}${Theme.R}`);
    return parts.join(' · ') || null;
  }

  stopTicker() {
    if (!this.tickerHandle) return;
    clearInterval(this.tickerHandle);
    this.tickerHandle = null;
  }

  groupStart(labels) {
    this.groupLabels = [...labels];
    this.groupDone = new Map();
    this.groupStartMs = Date.now();
    if (!this.useTicker) return;

    for (const label of labels) {
      process.stdout.write(
        `  ${Icons.RUN}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}${Theme.CLEAR_EOL}\n`,
      );
    }
    this.tickerHandle = setInterval(() => this.redrawGroup(), 1000).unref();
  }

  groupTaskEnd(label, result, ms) {
    const icon = this.resultIcon(result);
    const right = this.resultRight(result, ms);
    this.groupDone.set(label, { icon, right });
    if (this.useTicker) {
      this.redrawGroup();
      return;
    }
    process.stdout.write(
      `  ${icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}  ${right}${Theme.CLEAR_EOL}\n`,
    );
  }

  groupEnd() {
    this.stopTicker();
    if (this.useTicker && this.groupLabels) this.redrawGroup();
    this.groupLabels = null;
    this.groupDone = null;
  }

  redrawGroup() {
    if (!this.groupLabels || !this.groupDone) return;
    if (!this.useTicker) return;
    const elapsed = `${Theme.DIM}${Text.elapsed(Date.now() - this.groupStartMs)}${Theme.R}`;
    let out = `\x1b[${this.groupLabels.length}A`;
    for (const label of this.groupLabels) {
      const done = this.groupDone.get(label);
      const icon = done?.icon || Icons.RUN;
      const right = done?.right || elapsed;
      out += `\x1b[2K\r  ${icon}  ${Theme.BOLD}${label.padEnd(this.col)}${Theme.R}  ${right}\n`;
    }
    process.stdout.write(out);
  }

  failureDetail(failedTasks) {
    for (const task of failedTasks) {
      if (task.timeout) {
        this.renderTimeout(task);
        continue;
      }
      if (task.failures?.length > 0) {
        this.renderTestFailures(task.failures);
        continue;
      }
      if (task.errors?.length > 0) {
        process.stdout.write('\n');
        const total = task.errors.length;
        const shown = task.errors.slice(0, Config.MAX_FAILURE_CARDS);
        OutputRenderer.renderDiagnosticsGrouped(shown);
        if (total > shown.length) {
          process.stdout.write(
            `  ${Theme.DIM}… ${total - shown.length} more diagnostics; full list in ${Config.FAILURE_FILE}${Theme.R}\n\n`,
          );
        }
        continue;
      }
      if (task.rawOutput) this.renderRawOutput(task.rawOutput, task);
    }
  }

  renderTimeout(task) {
    const startupPhase = task.phase === 'startup';
    process.stdout.write('\n');
    process.stdout.write(
      `  ${Icons.HANG}  ${Theme.BOLD}TIMED OUT${Theme.R} — ${
        startupPhase
          ? `no TAP output during startup window (${Text.elapsed(task.silenceMs)})`
          : `no TAP output for ${Text.elapsed(task.silenceMs)} between tests`
      }\n\n`,
    );

    if (task.lastCompletedTest) {
      process.stdout.write(`  ${Theme.DIM}Last completed test:${Theme.R}\n`);
      process.stdout.write(`  ${Theme.GREEN}✔${Theme.R}  ${task.lastCompletedTest.name}\n\n`);
      process.stdout.write(
        `  ${Theme.DIM}→ The hang likely occurred in the next test after this one.\n` +
          `    Check for: unclosed handles, unresolved promises, missing mock teardown.${Theme.R}\n\n`,
      );
    } else if (startupPhase) {
      process.stdout.write(
        `  ${Theme.DIM}→ Test process produced no TAP lines before the startup window expired.\n` +
          `    Check for: top-level await deadlocks, missing .env / config, slow cold start.${Theme.R}\n\n`,
      );
    }

    if (task.environment) {
      process.stdout.write(`  ${Theme.DIM}Environment at timeout:${Theme.R}\n`);
      if (task.environment.memoryAtFailure) {
        const mem = task.environment.memoryAtFailure;
        process.stdout.write(
          `  ${Theme.DIM}  Memory: ${Math.round(mem.rss / 1024 / 1024)}MB RSS, ${Math.round(mem.heapUsed / 1024 / 1024)}MB Heap${Theme.R}\n`,
        );
      }
      if (task.environment.activeHandles) {
        process.stdout.write(
          `  ${Theme.DIM}  Active Handles: ${task.environment.activeHandles.length}${Theme.R}\n`,
        );
      }
      process.stdout.write('\n');
    }
  }

  renderTestFailures(failures) {
    process.stdout.write('\n');
    const total = failures.length;
    const shown = failures.slice(0, Config.MAX_FAILURE_CARDS);
    const maxIdx = String(total).length;
    for (let i = 0; i < shown.length; i++) {
      const f = shown[i];
      const idx = String(i + 1).padStart(maxIdx);
      const fileRef = f.frame ? f.frame.replace(/:(\d+):(\d+)$/, ':$1') : f.file || '';
      const nameStr = Text.cap(f.name, 60);
      process.stdout.write(
        `    ${Theme.BOLD}${idx}${Theme.R}  ${nameStr.padEnd(62)}  ${Theme.DIM}${fileRef}${Theme.R}\n`,
      );
    }
    if (total > shown.length) {
      process.stdout.write(
        `    ${Theme.DIM}… ${total - shown.length} more failures; full list in ${Config.FAILURE_FILE}${Theme.R}\n`,
      );
    }
    process.stdout.write(`\n  ${Theme.DIM}→ node scripts/tasks.mjs detail [n]${Theme.R}\n\n`);
  }

  renderRawOutput(rawOutput, task = {}) {
    process.stdout.write('\n');
    const cleanOutput = stripVTControlCharacters(rawOutput);
    const lines = cleanOutput.trim().split('\n');
    const shown = lines.slice(0, Config.RAW_OUTPUT_MAX_LINES);
    for (const line of shown) process.stdout.write(`      ${Theme.DIM}${line}${Theme.R}\n`);
    if (lines.length > shown.length) {
      process.stdout.write(
        `      ${Theme.DIM}… ${lines.length - shown.length} more lines${Theme.R}\n`,
      );
    }
    if (task.truncatedStdout || task.truncatedStderr) {
      const which = [task.truncatedStdout ? 'stdout' : null, task.truncatedStderr ? 'stderr' : null]
        .filter(Boolean)
        .join(' + ');
      process.stdout.write(`      ${Theme.DIM}[${which} truncated]${Theme.R}\n`);
    }
    process.stdout.write('\n');
  }

  summary(aggregate) {
    process.stdout.write('\n');
    this.renderSlowestTests(aggregate.slowestTests);

    const total = aggregate.tasks.length - aggregate.skipped;
    const wall = Text.elapsed(aggregate.wallMs());
    if (aggregate.failed === 0) {
      const skippedNote =
        aggregate.skipped > 0 ? `  ${Theme.DIM}(${aggregate.skipped} skipped)${Theme.R}` : '';
      process.stdout.write(
        `  ${Theme.GREEN}${Theme.BOLD}✓${Theme.R}  ${aggregate.passed}/${total} passed${skippedNote}  ${Theme.DIM}${wall}${Theme.R}\n\n`,
      );
      return;
    }

    process.stdout.write(
      `  ${Theme.RED}${Theme.BOLD}✗${Theme.R}  ${aggregate.failed} failed: ${aggregate.failureSummary() || 'failed'}  ${Theme.DIM}·${Theme.R}  ${aggregate.passed}/${total} ran  ${Theme.DIM}${wall}${Theme.R}\n`,
    );
    process.stdout.write(`  ${Theme.DIM}✎  failure details → ${Config.FAILURE_FILE}${Theme.R}\n\n`);
  }

  renderSlowestTests(slowestTests) {
    if (!slowestTests || slowestTests.length === 0) return;
    process.stdout.write(`  ${Theme.DIM}Slowest tests:${Theme.R}\n`);
    for (const test of slowestTests) {
      process.stdout.write(
        `    ${Text.elapsed(test.ms).padStart(5)}  ${Theme.DIM}${test.name}${Theme.R}\n`,
      );
    }
    process.stdout.write('\n');
  }
}

const JSON_SCHEMA_VERSION = 1;

class JsonReporter extends BaseReporter {
  summary(aggregate) {
    process.stdout.write(
      JSON.stringify({
        schemaVersion: JSON_SCHEMA_VERSION,
        ok: aggregate.failed === 0,
        mode: aggregate.mode,
        wallMs: aggregate.wallMs(),
        tasks: aggregate.tasks,
        slowestTests: aggregate.slowestTests,
        failureSummary: aggregate.failureSummary(),
      }) + '\n',
    );
  }
}

function noop() {
  // intentionally empty
}

async function promptForDetailIndex(maxFailures) {
  if (maxFailures < 1) return null;
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    process.stderr.write(`'detail' requires a positive integer failure index.\n`);
    return null;
  }

  const rl = createPromptInterface({ input: process.stdin, output: process.stdout });
  try {
    const raw = await rl.question(`Select failure index [1-${maxFailures}] (press Enter for 1): `);
    const answer = raw.trim();
    const index = answer.length === 0 ? 1 : Number(answer);
    if (!Number.isInteger(index) || index < 1 || index > maxFailures) {
      process.stderr.write(`Failure index must be an integer between 1 and ${maxFailures}.\n`);
      return null;
    }
    return index;
  } finally {
    rl.close();
  }
}

async function renderDetailCommand(config) {
  let { index } = config;
  const { llm, json } = config;

  const data = await FileStore.readJson(Config.FAILURE_FILE, null);
  if (!data) {
    process.stderr.write(`No failure data found. Run node scripts/tasks.mjs first.\n`);
    process.exitCode = 1;
    return;
  }

  const testTask = Array.isArray(data.tasks)
    ? data.tasks.find(
        (t) => t.label === 'test' && !t.ok && Array.isArray(t.failures) && t.failures.length > 0,
      )
    : null;
  const failures = testTask?.failures ?? [];

  if (failures.length === 0) {
    process.stderr.write(`No test failures in last run.\n`);
    process.exitCode = 1;
    return;
  }

  if (index == null) {
    index = await promptForDetailIndex(failures.length);
    if (index == null) {
      process.exitCode = 2;
      return;
    }
  }

  if (index < 1 || index > failures.length) {
    process.stderr.write(
      `Failure ${index} not found. Last run had ${Text.plural(failures.length, 'failure')}.\n`,
    );
    process.exitCode = 1;
    return;
  }

  const failure = failures[index - 1];

  if (llm || json) {
    const parsed = failure.frame ? parseFrame(failure.frame) : null;
    const src = parsed ? sourceCache.lines(path.resolve(process.cwd(), parsed.file)) : [];
    const BEFORE = 4;
    const AFTER = 5;
    const startLine = parsed ? Math.max(1, parsed.line - BEFORE) : 1;
    const endLine = parsed ? Math.min(src.length || parsed.line, parsed.line + AFTER) : 1;
    const windowLines = src.slice(startLine - 1, endLine);

    const payload = {
      schemaVersion: JSON_SCHEMA_VERSION,
      index,
      name: failure.name,
      file: failure.file || '',
      frame: failure.frame || null,
      errorMessage: failure.errorMessage ?? null,
      expected: failure.expected ?? null,
      actual: failure.actual ?? null,
      sourceWindow: parsed
        ? {
            startLine,
            highlightLine: parsed.line,
            col: parsed.col,
            lines: windowLines,
          }
        : null,
    };

    process.stdout.write(JSON.stringify(payload) + '\n');
  } else {
    OutputRenderer.renderDetailView(failure, index, testTask?.environment);
    process.stdout.write('\n');
  }
}

async function writeFailureFile(aggregate, file = Config.FAILURE_FILE) {
  const payload = {
    ok: false,
    mode: aggregate.mode,
    wallMs: aggregate.wallMs(),
    tasks: aggregate.tasks,
    slowestTests: aggregate.slowestTests,
    failureSummary: aggregate.failureSummary(),
    timestamp: new Date().toISOString(),
  };

  try {
    await FileStore.writeJsonAtomic(file, payload);
  } catch {
    // best-effort: do not mask the actual task failure
  }
}

async function clearFailureFile(file = Config.FAILURE_FILE) {
  try {
    await rm(file, { force: true });
  } catch {
    // best-effort cleanup only
  }
}

function installSignalHandlers(reporter, config) {
  const signals = Config.IS_WINDOWS ? ['SIGINT'] : ['SIGINT', 'SIGTERM'];
  let interrupted = false;

  const handler = (signalName) => {
    runController.abort();
    const exitCode = signalExitCode(signalName);

    if (interrupted) {
      process.exit(exitCode);
      return;
    }
    interrupted = true;

    if (reporter?.tickerHandle) clearInterval(reporter.tickerHandle);
    if (config?.json) {
      process.stderr.write('\n  interrupted\n\n');
      process.stdout.write(
        JSON.stringify({
          schemaVersion: JSON_SCHEMA_VERSION,
          ok: false,
          interrupted: true,
        }) + '\n',
      );
    } else {
      if (process.stdout.isTTY) {
        process.stdout.write('\x1b[?25h');
      }
      process.stdout.write(`\n  ${Theme.YELLOW}interrupted${Theme.R}\n\n`);
    }
    process.exitCode = exitCode;
    // Allow tasks already in-flight to settle before truly exiting; second signal forces exit.
  };

  for (const signalName of signals) {
    if (process.listenerCount(signalName) > 0) continue;
    process.on(signalName, () => handler(signalName));
  }
}

class TaskOrchestrator {
  constructor(config) {
    this.config = config;
    this.tasks = this.createTasks(config);
    this.col = Math.max(...this.tasks.map((task) => task.label.length)) + 2;
  }

  createTasks(config) {
    const isFix = config.command === 'fix';
    return [
      { label: 'format', runner: () => TaskRunners.runFormat({ fix: isFix }) },
      { label: 'lint', runner: () => TaskRunners.runLint(isFix) },
      { label: 'type-check', runner: () => TaskRunners.runTypeCheck() },
      { label: 'knip', runner: () => TaskRunners.runKnip() },
      {
        label: 'test',
        runner: () =>
          TaskRunners.runTest({
            testTimeout: null,
            testNamePattern: null,
            testShard: null,
            updateSnapshots: false,
          }),
        skip: config.quick,
      },
      {
        label: 'rebuild',
        runner: () => TaskRunners.runBuild(),
        skip: config.quick,
      },
    ];
  }

  async run() {
    const reporter = this.config.json
      ? new JsonReporter(this.config, this.col)
      : new TtyReporter(this.config, this.col);
    installSignalHandlers(reporter, this.config);
    reporter.header();

    const aggregate = new Aggregate(this.config.all ? 'run-all' : 'fail-fast');
    const isFix = this.config.command === 'fix';
    const testDurations = isFix
      ? await this.runSequential(aggregate, reporter)
      : await this.runPhased(aggregate, reporter);

    return await this.finish(aggregate, reporter, testDurations);
  }

  async runSequential(aggregate, reporter) {
    let testDurations = null;
    const isFix = this.config.command === 'fix';
    for (const task of this.tasks) {
      const result = await this.executeTask(task, aggregate, reporter, {
        allowAutoFix: isFix,
      });
      if (result?.testDurations) testDurations = result.testDurations;
      if (!this.config.all && aggregate.failed > 0) break;
    }
    return testDurations;
  }

  async runPhased(aggregate, reporter) {
    let testDurations = null;
    const [formatTask, ...rest] = this.tasks;
    const staticTasks = rest.slice(0, 3);
    const deepTasks = rest.slice(3);

    await this.executeTask(formatTask, aggregate, reporter, {
      allowAutoFix: true,
    });
    if (this.shouldStop(aggregate)) return null;

    await this.executeGroup(staticTasks, aggregate, reporter);
    if (this.shouldStop(aggregate)) return null;

    const results = await this.executeGroup(deepTasks, aggregate, reporter);
    for (const result of results) {
      if (result?.result?.testDurations) testDurations = result.result.testDurations;
    }
    return testDurations;
  }

  shouldStop(aggregate) {
    return aggregate.failed > 0 && !this.config.all;
  }

  shouldGate(task, aggregate) {
    return (
      !this.config.all &&
      aggregate.failed > 0 &&
      (task.label === 'test' || task.label === 'rebuild')
    );
  }

  async executeTask(task, aggregate, reporter, options = {}) {
    const result = await this.runTaskWithReporting(task, aggregate, reporter, options);
    aggregate.record(task.label, result, result.ms || 0);
    return result;
  }

  _checkSkip(task, aggregate) {
    if (task.skip) return Results.skip('skipped');
    if (this.shouldGate(task, aggregate)) return Results.skip('gated on prior failure');
    return null;
  }

  async runTaskWithReporting(task, aggregate, reporter, options = {}) {
    const skipResult = this._checkSkip(task, aggregate);
    if (skipResult) {
      reporter.taskStart(task.label);
      reporter.taskEnd(task.label, skipResult, 0);
      return { ...skipResult, ms: 0 };
    }

    reporter.taskStart(task.label);
    const { result, ms } = await this.runMeasured(task, options);
    reporter.taskEnd(task.label, result, ms);
    return { ...result, ms };
  }

  async executeGroup(tasks, aggregate, reporter) {
    const activeTasks = [];
    const completed = [];

    for (const task of tasks) {
      const skipResult = this._checkSkip(task, aggregate);
      if (skipResult) {
        reporter.taskStart(task.label);
        reporter.taskEnd(task.label, skipResult, 0);
        aggregate.record(task.label, skipResult, 0);
        completed.push({ task, result: skipResult, ms: 0 });
      } else {
        activeTasks.push(task);
      }
    }

    if (activeTasks.length === 0) return completed;

    reporter.groupStart(activeTasks.map((task) => task.label));
    const results = await Promise.all(
      activeTasks.map(async (task) => {
        const { result, ms } = await this.runMeasured(task, {
          allowAutoFix: true,
        });
        reporter.groupTaskEnd(task.label, result, ms);
        return { task, result, ms };
      }),
    );
    reporter.groupEnd();

    for (const { task, result, ms } of results) aggregate.record(task.label, result, ms);
    return [...completed, ...results];
  }

  async runMeasured(task, options = {}) {
    const start = Date.now();
    let result = await task.runner();
    if (!result.ok && options.allowAutoFix) {
      const fixed = await this.attemptAutoFix(task, result);
      if (fixed) result = fixed;
    }
    return { result, ms: Date.now() - start };
  }

  async _applyFixAndRerun(task, fixResult) {
    if (!fixResult.ok) {
      return Results.fail({
        rawOutput:
          `auto-fix failed:\n${Text.joinOutput(fixResult.stdout, fixResult.stderr)}`.trim(),
      });
    }
    const rerun = await task.runner();
    return rerun.ok ? Results.pass({ annotation: 'auto-fixed' }) : rerun;
  }

  async attemptAutoFix(task, result) {
    if (task.label === 'format') {
      const fixResult = await ProcessRunner.execAsync('npm', ['run', 'format']);
      return this._applyFixAndRerun(task, fixResult);
    }

    if (!result.errors || result.errors.length === 0) return null;
    if (task.label !== 'lint' && task.label !== 'knip') return null;
    if (task.label === 'knip' && !KnipParser.isFixable(result.errors)) return null;

    const fixResult =
      task.label === 'lint'
        ? await ProcessRunner.execAsync(...TaskCommands.lintFix())
        : await ProcessRunner.execAsync(...TaskCommands.knipFix());

    if (task.label === 'knip' && fixResult.ok) {
      // knip --fix may leave files unformatted (we drop knip's own --format because
      // it crashes on Windows). Format the workspace ourselves so the rerun passes.
      const formatResult = await ProcessRunner.execAsync('npm', ['run', 'format']);
      if (!formatResult.ok) return this._applyFixAndRerun(task, formatResult);
      const check = await task.runner();
      return check.ok ? Results.pass({ annotation: 'auto-fixed' }) : check;
    }

    return this._applyFixAndRerun(task, fixResult);
  }

  async finish(aggregate, reporter, testDurations = null) {
    if (testDurations) aggregate.setSlowestTests(testDurations);
    reporter.failureDetail(aggregate.failures());
    reporter.summary(aggregate);

    if (aggregate.failed > 0) {
      await writeFailureFile(aggregate);
      if (this.config.llm && !this.config.json) {
        OutputRenderer.emitLlmBlock({
          ok: false,
          mode: aggregate.mode,
          tasks: aggregate.tasks,
          failureSummary: aggregate.failureSummary(),
        });
      }
    } else {
      await clearFailureFile();
    }

    return aggregate.failed === 0 ? 0 : 1;
  }
}

export {
  Config,
  Theme,
  Icons,
  Text,
  Json,
  FileStore,
  Results,
  ProcessRunner,
  ProcessUtils,
  HistoryManager,
  EslintParser,
  TscParser,
  KnipParser,
  JsonLParser,
  TestJsonState,
  TestRunner,
  TaskCommands,
  TaskRunners,
  OutputRenderer,
  Aggregate,
  TaskOrchestrator,
  OutputBuffer,
};

if (import.meta.main) {
  const config = parseCliConfig(process.argv.slice(2));
  if (config !== null) {
    if (config.command === 'detail') {
      await renderDetailCommand(config);
    } else if (config.command === 'test') {
      if (config.watch) {
        const runner = new TestRunner({ testConfig: config });
        const argv = [...runner.buildArgv(), '--watch'];
        const command = ProcessRunner.command(process.execPath, argv);
        const child = spawn(
          command.cmd,
          command.args,
          ProcessRunner.spawnOptions(command, { stdio: 'inherit' }),
        );
        child.on('error', (err) => {
          process.stderr.write(`${describeSpawnError(err, 'node')}\n`);
          process.exitCode = 1;
        });
        child.on('close', (code, signalName) => {
          process.exitCode = code ?? (signalName ? signalExitCode(signalName) : 1);
        });
      } else {
        const reporter = config.json ? new JsonReporter(config, 0) : new TtyReporter(config, 0);
        const start = Date.now();
        const result = await TaskRunners.runTest(config);
        const ms = Date.now() - start;

        const aggregate = new Aggregate('test');
        aggregate.record('test', result, ms);
        aggregate.setSlowestTests(result.testDurations);

        if (!config.json && !result.ok) {
          reporter.failureDetail([{ label: 'test', ...result }]);
        }

        reporter.summary(aggregate);

        if (!result.ok) {
          await writeFailureFile(aggregate);
        } else {
          await clearFailureFile();
        }

        process.exitCode = result.ok ? 0 : 1;
      }
    } else {
      process.exitCode = await new TaskOrchestrator(config).run();
    }
  }
}
