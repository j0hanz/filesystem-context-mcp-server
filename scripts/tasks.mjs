#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const HELP = `Usage: node scripts/tasks.mjs [command] [options]

Commands:
  check        Run the full repository check (default)
  fix          Format and lint-fix, then run the full check
  test         Run tests; remaining arguments are passed to node --test

Options:
  --quick      Run static checks only
  -h, --help   Show this help

Examples:
  node scripts/tasks.mjs
  node scripts/tasks.mjs --quick
  node scripts/tasks.mjs fix
  node scripts/tasks.mjs test --test-name-pattern="resources"
`;

function run(command, args) {
  // Windows resolves npm via npm.cmd; spawning .cmd directly needs the shell, so
  // route npm through ComSpec (shell + args array trips DEP0190).
  const isWindowsNpm = process.platform === 'win32' && command === 'npm';
  const executable = isWindowsNpm ? process.env.ComSpec : command;
  const adjusted = isWindowsNpm ? ['/d', '/c', 'npm', ...args] : args;
  const result = spawnSync(executable, adjusted, { stdio: 'inherit' });
  if (result.error) {
    console.error(result.error.message);
    return 1;
  }
  return result.status ?? 1;
}

function runNpm(script) {
  return run('npm', ['run', script]);
}

function main(args) {
  if (args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP);
    return 0;
  }

  const first = args[0];
  const hasExplicitCommand = first !== undefined && !first.startsWith('-');
  const command = hasExplicitCommand ? first : 'check';
  const commandArgs = hasExplicitCommand ? args.slice(1) : args;

  switch (command) {
    case 'check':
      if (commandArgs.some((arg) => arg !== '--quick')) {
        process.stderr.write(`Unknown option for check: ${commandArgs.join(' ')}\n\n${HELP}`);
        return 2;
      }
      return runNpm(commandArgs.includes('--quick') ? 'check:static' : 'check');

    case 'fix': {
      if (commandArgs.length > 0) {
        process.stderr.write(`The fix command takes no options.\n\n${HELP}`);
        return 2;
      }
      const formatStatus = runNpm('format');
      if (formatStatus !== 0) return formatStatus;
      const lintStatus = runNpm('lint:fix');
      if (lintStatus !== 0) return lintStatus;
      return runNpm('check');
    }

    case 'test':
      return run(process.execPath, [
        '--test',
        '--import',
        'tsx',
        ...commandArgs,
        '__tests__/**/*.test.ts',
      ]);

    default:
      process.stderr.write(`Unknown command: ${command}\n\n${HELP}`);
      return 2;
  }
}

process.exitCode = main(process.argv.slice(2));
