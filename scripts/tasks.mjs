/* eslint-disable */
import { spawn } from 'node:child_process';
import { access, chmod, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

// --- Configuration (Single Source of Truth) ---
const BIN = {
  tsc: join('node_modules', 'typescript', 'bin', 'tsc'),
};

const CONFIG = {
  paths: {
    dist: 'dist',
    assets: 'assets',
    executable: 'dist/index.js',
    tsBuildInfo: [
      '.tmp',
      '.tsbuildinfo',
      'tsconfig.tsbuildinfo',
      'tsconfig.build.tsbuildinfo',
    ],
    get distAssets() {
      return join(this.dist, 'assets');
    },
  },
  commands: {
    tsc: ['node', [BIN.tsc, '-p', 'tsconfig.build.json']],
    tscCheckSrc: ['node', [BIN.tsc, '-p', 'tsconfig.json', '--noEmit']],
    tscCheckTests: ['node', [BIN.tsc, '-p', 'tsconfig.test.json', '--noEmit']],
  },
  test: {
    patterns: [
      'src/__tests__/**/*.test.ts',
      'tests/**/*.test.ts',
      'node-tests/**/*.test.ts',
    ],
  },
};

// --- Infrastructure Layer (IO & System) ---
const Logger = {
  startGroup: (name) => process.stdout.write(`> ${name}... `),
  endGroupSuccess: (duration) => console.log(`✅ (${duration}s)`),
  endGroupFail: (err) =>
    console.log(`❌${err?.message ? ` (${err.message})` : ''}`),
  shellSuccess: (name, duration) => console.log(`> ${name} ✅ (${duration}s)`),
  info: (msg) => console.log(msg),
  error: (err) => console.error(err),
  newLine: () => console.log(),
};

const System = {
  async exists(path) {
    try {
      await access(path);
      return true;
    } catch {
      return false;
    }
  },

  async remove(paths) {
    const targets = Array.isArray(paths) ? paths : [paths];
    await Promise.all(
      targets.map((p) => rm(p, { recursive: true, force: true }))
    );
  },

  async copy(src, dest, opts = {}) {
    await cp(src, dest, opts);
  },

  async makeDir(path) {
    await mkdir(path, { recursive: true });
  },

  async changeMode(path, mode) {
    await chmod(path, mode);
  },

  exec(command, args = []) {
    return new Promise((resolve, reject) => {
      const resolvedCommand = command === 'node' ? process.execPath : command;

      const proc = spawn(resolvedCommand, args, {
        stdio: 'inherit',
        shell: false,
        windowsHide: true,
      });

      proc.on('error', (error) => {
        reject(error);
      });

      proc.on('close', (code, signal) => {
        if (code === 0) return resolve();
        const suffix = signal ? ` (signal ${signal})` : '';
        reject(new Error(`${command} exited with code ${code}${suffix}`));
      });
    });
  },
};

// --- Domain Layer (Build & Test Actions) ---
const BuildTasks = {
  async clean() {
    await System.remove(CONFIG.paths.dist);
    await System.remove(CONFIG.paths.tsBuildInfo);
  },

  async compile() {
    const [cmd, args] = CONFIG.commands.tsc;
    await System.exec(cmd, args);
  },

  async assets() {
    await System.makeDir(CONFIG.paths.dist);

    if (await System.exists(CONFIG.paths.assets)) {
      await System.copy(CONFIG.paths.assets, CONFIG.paths.distAssets, {
        recursive: true,
      });
    }
  },

  async makeExecutable() {
    await System.changeMode(CONFIG.paths.executable, '755');
  },
};

// --- Test Helpers (Pure Functions) ---
async function detectTestLoader() {
  if (await System.exists('node_modules/tsx')) {
    return ['--import', 'tsx/esm'];
  }
  if (await System.exists('node_modules/ts-node')) {
    return ['--loader', 'ts-node/esm'];
  }
  return [];
}

function getCoverageArgs(args) {
  return args.includes('--coverage') ? ['--experimental-test-coverage'] : [];
}

async function findTestPatterns() {
  const existing = [];
  for (const pattern of CONFIG.test.patterns) {
    const basePath = pattern.split('/')[0];
    if (await System.exists(basePath)) {
      existing.push(pattern);
    }
  }
  return existing;
}

const TestTasks = {
  async typeCheck() {
    await Runner.runShellTask('Type-checking src', async () => {
      const [cmd, args] = CONFIG.commands.tscCheckSrc;
      await System.exec(cmd, args);
    });
    await Runner.runShellTask('Type-checking tests', async () => {
      const [cmd, args] = CONFIG.commands.tscCheckTests;
      await System.exec(cmd, args);
    });
  },

  async test(args = []) {
    await Pipeline.fullBuild();

    const patterns = await findTestPatterns();
    if (patterns.length === 0) {
      throw new Error(
        `No test directories found. Expected one of: ${CONFIG.test.patterns.join(
          ', '
        )}`
      );
    }

    const loader = await detectTestLoader();
    const coverage = getCoverageArgs(args);

    await Runner.runShellTask('Running tests', async () => {
      await System.exec('node', [
        '--test',
        ...loader,
        ...coverage,
        ...patterns,
      ]);
    });
  },
};

// --- Application Layer (Task Running & Orchestration) ---
class Runner {
  static async #run(name, fn, logSuccess) {
    Logger.startGroup(name);
    Logger.newLine();
    const start = performance.now();

    try {
      await fn();
      logSuccess(((performance.now() - start) / 1000).toFixed(2));
    } catch (err) {
      Logger.endGroupFail(err);
      throw err;
    }
  }

  static runTask(name, fn) {
    return this.#run(name, fn, Logger.endGroupSuccess);
  }

  static runShellTask(name, fn) {
    return this.#run(name, fn, (d) => Logger.shellSuccess(name, d));
  }
}

const Pipeline = {
  async fullBuild() {
    Logger.info('🚀 Starting build...');
    const start = performance.now();

    await Runner.runTask('Cleaning dist', BuildTasks.clean);
    await Runner.runShellTask('Compiling TypeScript', BuildTasks.compile);
    await Runner.runTask('Copying assets', BuildTasks.assets);
    await Runner.runTask('Making executable', BuildTasks.makeExecutable);

    Logger.info(
      `\n✨ Build completed in ${((performance.now() - start) / 1000).toFixed(
        2
      )}s`
    );
  },
};

// --- Interface Layer (CLI) ---
const CLI = {
  routes: {
    clean: () => Runner.runTask('Cleaning', BuildTasks.clean),
    'copy:assets': () => Runner.runTask('Copying assets', BuildTasks.assets),
    'make-executable': () =>
      Runner.runTask('Making executable', BuildTasks.makeExecutable),
    build: Pipeline.fullBuild,
    'type-check': () => TestTasks.typeCheck(),
    test: (args) => TestTasks.test(args),
  },

  async main(args) {
    const taskName = args[2] ?? 'build';
    const restArgs = args.slice(3);
    const action = this.routes[taskName];

    if (!action) {
      Logger.error(`Unknown task: ${taskName}`);
      Logger.error(`Available tasks: ${Object.keys(this.routes).join(', ')}`);
      process.exitCode = 1;
      return;
    }

    try {
      await action(restArgs);
    } catch {
      process.exitCode = 1;
    }
  },
};

CLI.main(process.argv);
