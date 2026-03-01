/* eslint-disable */
import { spawn } from 'node:child_process';
import { access, chmod, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

const TSC = join('node_modules', 'typescript', 'bin', 'tsc');

const PATHS = {
  dist: 'dist',
  tmp: '.tmp',
  assets: 'assets',
  executable: 'dist/index.js',
  distAssets: join('dist', 'assets'),
};

const TEST_PATTERNS = [
  'src/__tests__/**/*.test.ts',
  'tests/**/*.test.ts',
  'node-tests/**/*.test.ts',
];

// --- Helpers ---

function pathExists(p) {
  return access(p).then(
    () => true,
    () => false
  );
}

function elapsed(start) {
  return ((performance.now() - start) / 1000).toFixed(2);
}

function run(args, { stdio = 'inherit' } = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, args, {
      stdio,
      shell: false,
      windowsHide: true,
    });

    const out = [];
    const err = [];
    if (stdio === 'pipe') {
      proc.stdout.on('data', (d) => out.push(d));
      proc.stderr.on('data', (d) => err.push(d));
    }

    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) return resolve(Buffer.concat(out).toString());
      const stderr = Buffer.concat(err).toString();
      const stdout = Buffer.concat(out).toString();
      reject(
        new Error(
          `node ${args[0]} exited with code ${code}\n${stderr || stdout}`
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
    console.log(`> ${name} ✅ (${elapsed(start)}s)`);
  } catch (err) {
    console.error(`> ${name} ❌\n${err.message || err}`);
    throw err;
  }
}

// --- Tasks ---

function clean() {
  return Promise.all([
    rm(PATHS.dist, { recursive: true, force: true }),
    rm(PATHS.tmp, { recursive: true, force: true }),
  ]);
}

function compile() {
  return run([TSC, '-p', 'tsconfig.build.json']);
}

async function copyAssets() {
  await mkdir(PATHS.dist, { recursive: true });
  if (await pathExists(PATHS.assets)) {
    await cp(PATHS.assets, PATHS.distAssets, { recursive: true });
  }
}

function makeExecutable() {
  return chmod(PATHS.executable, '755').catch(() => {});
}

async function build() {
  const start = performance.now();
  console.log('🚀 Starting build...');
  await runTask('Cleaning dist', clean);
  await runTask('Compiling TypeScript', compile);
  await runTask('Copying assets', copyAssets);
  await runTask('Making executable', makeExecutable);
  console.log(`\n✨ Build completed in ${elapsed(start)}s`);
}

async function typeCheck() {
  const start = performance.now();
  console.log('🚀 Starting concurrent type checks...');

  const results = await Promise.allSettled([
    run([TSC, '-p', 'tsconfig.json', '--noEmit'], { stdio: 'pipe' }),
    run([TSC, '-p', 'tsconfig.test.json', '--noEmit'], { stdio: 'pipe' }),
  ]);

  const labels = ['src', 'tests'];
  let failed = false;
  for (const [i, r] of results.entries()) {
    if (r.status === 'rejected') {
      console.error(
        `\n❌ Type-check ${labels[i]} failed:\n${r.reason.message}`
      );
      failed = true;
    } else {
      console.log(`> Type-check ${labels[i]} ✅`);
    }
  }

  if (failed) throw new Error('Type checks failed');
  console.log(`✨ Type checks passed in ${elapsed(start)}s`);
}

async function test(args) {
  await build();

  const dirResults = await Promise.all(
    TEST_PATTERNS.map(async (p) => ({
      pattern: p,
      ok: await pathExists(p.split('/')[0]),
    }))
  );
  const patterns = dirResults.filter((d) => d.ok).map((d) => d.pattern);

  if (patterns.length === 0) throw new Error('No test directories found.');

  const [hasTsx, hasTsNode] = await Promise.all([
    pathExists('node_modules/tsx'),
    pathExists('node_modules/ts-node'),
  ]);

  const loader = hasTsx
    ? ['--import', 'tsx/esm']
    : hasTsNode
      ? ['--loader', 'ts-node/esm']
      : [];

  const coverage = args.includes('--coverage')
    ? ['--experimental-test-coverage']
    : [];

  await runTask('Running tests', () =>
    run(['--test', ...loader, ...coverage, ...patterns])
  );
}

// --- Router ---

const ROUTES = {
  clean: () => runTask('Cleaning dist', clean),
  'copy:assets': () => runTask('Copying assets', copyAssets),
  'make-executable': () => runTask('Making executable', makeExecutable),
  build,
  'type-check': typeCheck,
  test: (restArgs) => test(restArgs),
};

const taskName = process.argv[2] ?? 'build';
const action = ROUTES[taskName];

if (!action) {
  console.error(
    `Unknown task: ${taskName}\nAvailable tasks: ${Object.keys(ROUTES).join(', ')}`
  );
  process.exitCode = 1;
} else {
  try {
    await action(process.argv.slice(3));
  } catch {
    process.exitCode = 1;
  }
}
