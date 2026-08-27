import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve as pathResolve } from 'node:path';
import process from 'node:process';

import { normalizePath } from '../src/core/path-utils.js';

export type InspectorMethod =
  | 'initialize'
  | 'tools/list'
  | 'tools/call'
  | 'resources/list'
  | 'resources/read'
  | 'resources/templates/list'
  | 'prompts/list';

export interface InspectorCliOptions {
  method: InspectorMethod;
  serverCommand?: readonly string[];
  serverUrl?: string;
  transport?: 'stdio' | 'http';
  configPath?: string;
  serverName?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  uri?: string;
  headers?: Record<string, string>;
  serverArgs?: readonly string[];
  appInfo?: boolean;
}

export interface InspectorCliResult<T = unknown> {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: T;
}

let resolvedInspectorBin: string | undefined;
let hasResolvedInspector = false;

function resolveInspectorBin(): string | undefined {
  if (hasResolvedInspector) return resolvedInspectorBin;
  hasResolvedInspector = true;
  const req = createRequire(import.meta.url);
  try {
    const pkgPath = req.resolve('@modelcontextprotocol/inspector/package.json');
    const pkg = req(pkgPath) as { bin: Record<string, string> };
    resolvedInspectorBin = pathResolve(
      dirname(pkgPath),
      pkg.bin['mcp-inspector'] ?? './clients/launcher/build/index.js',
    );
  } catch {
    resolvedInspectorBin = undefined;
  }
  return resolvedInspectorBin;
}

/**
 * The `skip` reason for the Inspector suites, or `undefined` to run them.
 *
 * `@modelcontextprotocol/inspector` is a devDependency, so on CI its absence is
 * a broken install, not a missing optional tool — throwing there fails the file
 * loudly. Skipping instead is how ~25 conformance assertions disappeared from
 * every green run: the resolve is dynamic (`createRequire`), so neither knip nor
 * the type-checker can see the dependency go missing. Locally, a plain skip
 * still lets someone run the rest of the suite against a partial install.
 */
export function inspectorSkipReason(): string | undefined {
  if (resolveInspectorBin() !== undefined) return undefined;
  if (process.env['CI']) {
    throw new Error(
      '@modelcontextprotocol/inspector is not installed, so the Inspector conformance suites cannot run. Run `npm ci`.',
    );
  }
  return 'inspector not installed';
}

/**
 * Execute @modelcontextprotocol/inspector in CLI mode (--cli).
 */
export async function executeInspectorCli<T = unknown>(
  options: InspectorCliOptions,
): Promise<InspectorCliResult<T>> {
  const inspectorBin = resolveInspectorBin();
  if (!inspectorBin) {
    throw new Error('@modelcontextprotocol/inspector is not installed');
  }
  let tempConfigPath: string | undefined;
  let configToUse = options.configPath ? normalizePath(options.configPath) : undefined;
  let serverNameToUse = options.serverName;

  if (!configToUse) {
    tempConfigPath = pathResolve(tmpdir(), `insp-ephemeral-${randomUUID()}.json`);
    configToUse = tempConfigPath;
    serverNameToUse = 'test_server';

    const serverEntry: Record<string, unknown> = {
      protocolEra: 'modern',
      ...(options.serverUrl
        ? {
            type: options.transport ?? 'http',
            url: options.serverUrl,
            ...(options.headers ? { headers: options.headers } : {}),
          }
        : options.serverCommand && options.serverCommand.length > 0
          ? {
              command: options.serverCommand[0],
              args: [...options.serverCommand.slice(1), ...(options.serverArgs ?? [])],
            }
          : {}),
    };

    await writeFile(
      tempConfigPath,
      JSON.stringify({ mcpServers: { [serverNameToUse]: serverEntry } }, null, 2),
      'utf-8',
    );
  }

  const args: string[] = [inspectorBin, '--cli'];

  args.push('--method', options.method);
  args.push('--format', 'json');
  args.push('--stored-auth-only');

  if (options.appInfo) {
    args.push('--app-info');
  }
  if (options.toolName) {
    args.push('--tool-name', options.toolName);
  }
  if (options.toolArgs) {
    args.push('--tool-args-json', JSON.stringify(options.toolArgs));
  }
  if (options.uri) {
    args.push('--uri', options.uri);
  }

  args.push('--config', configToUse);
  if (serverNameToUse) {
    args.push('--server', serverNameToUse);
  }

  const timeoutMs = 25_000;

  return new Promise((resolve) => {
    let settled = false;
    const settle = async (result: InspectorCliResult<T>) => {
      if (settled) return;
      settled = true;
      if (tempConfigPath) {
        try {
          await unlink(tempConfigPath);
        } catch {
          /* ignore */
        }
      }
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, args, {
        shell: false,
        windowsHide: true,
        timeout: timeoutMs,
      });
    } catch (err) {
      void settle({
        exitCode: 1,
        stdout: '',
        stderr: `Failed to spawn inspector process: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    let stdout = '';
    let stderr = '';

    child.stdout?.on('data', (chunk: Buffer | string) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.on('close', (code) => {
      let json: T | undefined;

      const trimmedOut = stdout.trim();
      if (trimmedOut.length > 0) {
        try {
          const parsed = JSON.parse(trimmedOut) as Record<string, unknown>;
          json = (parsed['result'] !== undefined ? parsed['result'] : parsed) as T;
        } catch {
          // If output is NDJSON (--app-info with tools/list), json parsing the whole block might fail
        }
      }

      void settle({
        exitCode: code ?? 1,
        stdout,
        stderr,
        ...(json !== undefined ? { json } : {}),
      });
    });

    child.on('error', (err) => {
      void settle({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
      });
    });
  });
}
