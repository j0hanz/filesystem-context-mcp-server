import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
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

/**
 * Execute @modelcontextprotocol/inspector in CLI mode (--cli).
 */
export async function executeInspectorCli<T = unknown>(
  options: InspectorCliOptions,
): Promise<InspectorCliResult<T>> {
  const args: string[] = ['--cli'];

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

  if (options.headers) {
    for (const [k, v] of Object.entries(options.headers)) {
      args.push('--header', `${k}: ${v}`);
    }
  }

  if (options.configPath) {
    args.push('--config', normalizePath(options.configPath));
    if (options.serverName) {
      args.push('--server', options.serverName);
    }
  } else if (options.serverUrl) {
    args.push(options.serverUrl, '--transport', options.transport ?? 'http');
  } else if (options.serverCommand && options.serverCommand.length > 0) {
    args.push(...options.serverCommand);
  }

  // The bare '--' separator forwards all following flags directly to the child server process.
  if (options.serverArgs && options.serverArgs.length > 0) {
    args.push('--', ...options.serverArgs);
  }

  const isWindows = process.platform === 'win32';
  const timeoutMs = options.timeoutMs ?? 25_000;

  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: InspectorCliResult<T>) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    let child: ChildProcess;
    try {
      child = spawn('npx', ['-y', '@modelcontextprotocol/inspector', ...args], {
        shell: isWindows,
        windowsHide: true,
        env: {
          ...process.env,
          ...options.env,
        },
        timeout: timeoutMs,
      });
    } catch (err) {
      settle({
        exitCode: 1,
        stdout: '',
        stderr: `Failed to spawn npx @modelcontextprotocol/inspector process: ${err instanceof Error ? err.message : String(err)}`,
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
          json = JSON.parse(trimmedOut) as T;
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

      settle({
        exitCode: code ?? 1,
        stdout,
        stderr,
        ...(json !== undefined ? { json } : {}),
        ...(errorEnvelope !== undefined ? { errorEnvelope } : {}),
      });
    });

    child.on('error', (err) => {
      settle({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${err.message}`.trim(),
      });
    });
  });
}
