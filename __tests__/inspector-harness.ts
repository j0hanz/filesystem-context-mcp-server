import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, resolve as pathResolve } from 'node:path';
import process from 'node:process';

import { normalizePath } from '../src/core/path.js';

export type InspectorMethod =
  | 'initialize'
  | 'tools/list'
  | 'tools/call'
  | 'resources/list'
  | 'resources/read'
  | 'resources/templates/list'
  | 'prompts/list'
  | 'prompts/get'
  | 'logging/setLevel'
  | 'servers/list'
  | 'servers/show';

export interface InspectorCliOptions {
  method: InspectorMethod;
  serverCommand?: readonly string[];
  serverUrl?: string;
  transport?: 'stdio' | 'http' | 'sse';
  configPath?: string;
  serverName?: string;
  toolName?: string;
  toolArgs?: Record<string, unknown>;
  uri?: string;
  promptName?: string;
  promptArgs?: Record<string, unknown>;
  headers?: Record<string, string>;
  serverArgs?: readonly string[];
  appInfo?: boolean;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export interface InspectorErrorEnvelope {
  error: {
    code: string;
    message: string;
    status?: number;
    url?: string;
    [key: string]: unknown;
  };
}

export interface InspectorCliResult<T = unknown> {
  exitCode: number;
  stdout: string;
  stderr: string;
  json?: T;
  errorEnvelope?: InspectorErrorEnvelope;
}

const req = createRequire(import.meta.url);
const pkgPath = req.resolve('@modelcontextprotocol/inspector/package.json');
const pkg = req(pkgPath) as { bin: Record<string, string> };
const INSPECTOR_BIN = pathResolve(
  dirname(pkgPath),
  pkg.bin['mcp-inspector'] ?? './clients/launcher/build/index.js',
);

/**
 * Execute @modelcontextprotocol/inspector in CLI mode (--cli).
 */
export async function executeInspectorCli<T = unknown>(
  options: InspectorCliOptions,
): Promise<InspectorCliResult<T>> {
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
      ...(options.env ? { env: options.env } : {}),
    };

    await writeFile(
      tempConfigPath,
      JSON.stringify({ mcpServers: { [serverNameToUse]: serverEntry } }, null, 2),
      'utf-8',
    );
  }

  const args: string[] = [INSPECTOR_BIN, '--cli'];

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
  if (options.promptName) {
    args.push('--prompt-name', options.promptName);
  }
  if (options.promptArgs) {
    args.push('--prompt-args', JSON.stringify(options.promptArgs));
  }

  if (options.headers && options.configPath) {
    for (const [k, v] of Object.entries(options.headers)) {
      args.push('--header', `${k}: ${v}`);
    }
  }

  args.push('--config', configToUse);
  if (serverNameToUse) {
    args.push('--server', serverNameToUse);
  }

  const timeoutMs = options.timeoutMs ?? 25_000;

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
        env: {
          ...process.env,
          ...options.env,
        },
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
      let errorEnvelope: InspectorErrorEnvelope | undefined;

      const trimmedOut = stdout.trim();
      if (trimmedOut.length > 0) {
        try {
          const parsed = JSON.parse(trimmedOut) as Record<string, unknown>;
          json = (parsed?.result !== undefined ? parsed.result : parsed) as T;
        } catch {
          // If output is NDJSON (--app-info with tools/list), json parsing the whole block might fail
        }
      }

      const trimmedErr = stderr.trim();
      if (trimmedErr.length > 0) {
        const lines = trimmedErr.split('\n');
        const lastLine = lines[lines.length - 1]?.trim() ?? '';
        if (lastLine.startsWith('{') && lastLine.endsWith('}')) {
          try {
            errorEnvelope = JSON.parse(lastLine) as InspectorErrorEnvelope;
          } catch {
            // Not a JSON error line
          }
        }
      }

      void settle({
        exitCode: code ?? 1,
        stdout,
        stderr,
        ...(json !== undefined ? { json } : {}),
        ...(errorEnvelope !== undefined ? { errorEnvelope } : {}),
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
