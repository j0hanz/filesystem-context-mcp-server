/* eslint-disable */
import { spawn } from 'node:child_process';
import { access, chmod, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import process from 'node:process';

const BIN_TSC = join('node_modules', 'typescript', 'bin', 'tsc');

const PATHS = {
  dist: 'dist',
  assets: 'assets',
  executable: 'dist/index.js',
  distAssets: join('dist', 'assets'),
  tsBuildInfo: [
    '.tsbuildinfo',
    'tsconfig.tsbuildinfo',
    'tsconfig.build.tsbuildinfo',
  ],
};

const TEST_PATTERNS = [
  'src/__tests__/**/*.test.ts',
  'tests/**/*.test.ts',
  'node-tests/**/*.test.ts',
];

async function exists(p) {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
}

function exec(command, args = [], capture = false) {
  return new Promise((resolve, reject) => {
    const resolvedCmd = command === 'node' ? process.execPath : command;
    const proc = spawn(resolvedCmd, args, {
      stdio: capture ? 'pipe' : 'inherit',
      shell: false,
      windowsHide: true,
    });

    let stdout = '',
      stderr = '';
    if (capture) {
      proc.stdout.on('data', (d) => (stdout += d));
      proc.stderr.on('data', (d) => (stderr += d));
    }

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve(stdout);
      else
        reject(
          new Error(
            `Command ${command} exited with code ${code}\n${stderr || stdout}`
          )
        );
    });
  });
}

async function runTask(name, fn) {
  const start = performance.now();
  console.log(`> ${name}...`);
  try {
    await fn();
    console.log(
      `> ${name} ✅ (${((performance.now() - start) / 1000).toFixed(2)}s)`
    );
  } catch (err) {
    console.error(`> ${name} ❌\n${err.message || err}`);
    throw err;
  }
}

const Tasks = {
  async clean() {
    await Promise.all([
      rm(PATHS.dist, { recursive: true, force: true }),
      ...PATHS.tsBuildInfo.map((p) => rm(p, { force: true })),
    ]);
  },

  async compile() {
    await exec('node', [BIN_TSC, '-p', 'tsconfig.build.json']);
  },

  async assets() {
    await mkdir(PATHS.dist, { recursive: true });
    if (await exists(PATHS.assets)) {
      await cp(PATHS.assets, PATHS.distAssets, { recursive: true });
    }
  },

  async makeExecutable() {
    await chmod(PATHS.executable, '755').catch(() => {});
  },

  async build() {
    const start = performance.now();
    console.log('🚀 Starting build...');
    await runTask('Cleaning dist', Tasks.clean);
    await runTask('Compiling TypeScript', Tasks.compile);
    await runTask('Copying assets', Tasks.assets);
    await runTask('Making executable', Tasks.makeExecutable);
    console.log(
      `\n✨ Build completed in ${((performance.now() - start) / 1000).toFixed(2)}s`
    );
  },

  async typeCheck() {
    const start = performance.now();
    console.log('🚀 Starting concurrent type checks...');

    const [src, tests] = await Promise.allSettled([
      exec('node', [BIN_TSC, '-p', 'tsconfig.json', '--noEmit'], true),
      exec('node', [BIN_TSC, '-p', 'tsconfig.test.json', '--noEmit'], true),
    ]);

    if (src.status === 'rejected')
      console.error(`\n❌ Type-check src failed:\n${src.reason.message}`);
    else console.log(`> Type-check src ✅`);

    if (tests.status === 'rejected')
      console.error(`\n❌ Type-check tests failed:\n${tests.reason.message}`);
    else console.log(`> Type-check tests ✅`);

    if (src.status === 'rejected' || tests.status === 'rejected') {
      throw new Error('Type checks failed');
    }

    console.log(
      `✨ Type checks passed in ${((performance.now() - start) / 1000).toFixed(2)}s`
    );
  },

  async test(args) {
    await Tasks.build();

    const patterns = [];
    for (const p of TEST_PATTERNS)
      if (await exists(p.split('/')[0])) patterns.push(p);

    if (patterns.length === 0) throw new Error('No test directories found.');

    const loader = (await exists('node_modules/tsx'))
      ? ['--import', 'tsx/esm']
      : (await exists('node_modules/ts-node'))
        ? ['--loader', 'ts-node/esm']
        : [];

    const coverage = args.includes('--coverage')
      ? ['--experimental-test-coverage']
      : [];

    await runTask('Running tests', async () => {
      await exec('node', ['--test', ...loader, ...coverage, ...patterns]);
    });
  },
};

async function main(args) {
  const taskName = args[2] ?? 'build';
  const restArgs = args.slice(3);

  const routes = {
    clean: () => runTask('Cleaning dist', Tasks.clean),
    'copy:assets': () => runTask('Copying assets', Tasks.assets),
    'make-executable': () => runTask('Making executable', Tasks.makeExecutable),
    build: Tasks.build,
    'type-check': Tasks.typeCheck,
    test: () => Tasks.test(restArgs),
  };

  const action = routes[taskName];
  if (!action) {
    console.error(
      `Unknown task: ${taskName}\nAvailable tasks: ${Object.keys(routes).join(', ')}`
    );
    process.exitCode = 1;
    return;
  }

  try {
    await action();
  } catch {
    process.exitCode = 1;
  }
}

main(process.argv);
