# MCP Tool Call Examples

This document shows example tool requests, responses, and resource fetches using the resource-store-first pattern.

## P1 Tool: `read` (Text Payload)

### Read Request

```json
{
  "method": "tools/call",
  "params": {
    "name": "read",
    "arguments": {
      "path": "src/index.ts"
    },
    "_meta": {
      "progressToken": 0
    }
  }
}
```

### Read Response

The response includes a terse summary, a `resource_link` block pointing to the stored content, and structured metadata.

```json
{
  "content": [
    {
      "type": "text",
      "text": "read: src/index.ts · 139 lines · 4.2 KB · text/x-typescript"
    },
    {
      "type": "resource_link",
      "uri": "filesystem-mcp://result/abc123xyz789",
      "name": "src/index.ts",
      "mimeType": "text/x-typescript",
      "size": 4231,
      "annotations": {
        "audience": ["user"]
      }
    }
  ],
  "structuredContent": {
    "path": "src/index.ts",
    "size": 4231,
    "lineCount": 139,
    "mimeType": "text/x-typescript",
    "kind": "text",
    "resourceUri": "filesystem-mcp://result/abc123xyz789",
    "ok": true
  }
}
```

### Resource Fetch

To retrieve the actual file content, the client calls `resources/read` with the resource URI:

```json
{
  "method": "resources/read",
  "params": {
    "uri": "filesystem-mcp://result/abc123xyz789"
  }
}
```

**Response:**

```json
{
  "contents": [
    {
      "uri": "filesystem-mcp://result/abc123xyz789",
      "mimeType": "text/x-typescript",
      "text": "#!/usr/bin/env node\nimport type { McpServer } from '@modelcontextprotocol/server';\n\nimport type * as http from 'node:http';\nimport process from 'node:process';\n\nimport { z } from 'zod/v4';\n\nimport { formatUnknownErrorMessage } from './lib/errors.js';\nimport { shutdownWorkerPool } from './lib/worker-pool.js';\n\nimport { CliExitError, parseArgs } from './cli.js';\nimport { createServer, startHttpServer, startServer } from './server.js';\n\n// Ensure consistent English error messages across all locales.\nz.config(z.locales.en());\n\nconst SHUTDOWN_TIMEOUT_MS = 5000;\nlet activeServer: McpServer | undefined;\nlet activeHttpServer: http.Server | undefined;\nlet shutdownStarted = false;\n\nfunction isStdinEvent(event: NodeJS.Signals | 'end' | 'close'): boolean {\n  return event === 'end' || event === 'close';\n}\n\nfunction registerShutdownTrigger(\n  event: NodeJS.Signals | 'end' | 'close'\n): void {\n  const target = isStdinEvent(event) ? process.stdin : process;\n  target.once(event, () => {\n    const reason = isStdinEvent(event) ? `stdin ${event}` : event;\n    void shutdown(reason, 0);\n  });\n}\n\nasync function shutdown(reason: string, exitCode = 0): Promise<void> {\n  if (shutdownStarted) return;\n  shutdownStarted = true;\n\n  process.exitCode = exitCode;\n  let keepForceExitTimer = true;\n\n  const timer = setTimeout(() => {\n    console.error(`Shutdown timed out (${reason}), forcing exit.`);\n    process.exit(exitCode);\n  }, SHUTDOWN_TIMEOUT_MS);\n  timer.unref();\n\n  try {\n    if (activeHttpServer) {\n      const server = activeHttpServer;\n      await new Promise<void>((resolve) => {\n        server.close(() => {\n          resolve();\n        });\n      });\n    }\n    if (activeServer) {\n      await activeServer.close();\n    }\n    await shutdownWorkerPool();\n    keepForceExitTimer = false;\n  } catch (error: unknown) {\n    console.error(\n      `Shutdown error (${reason}):`,\n      formatUnknownErrorMessage(error)\n    );\n  } finally {\n    if (!keepForceExitTimer) {\n      clearTimeout(timer);\n    }\n  }\n}\n\nasync function main(): Promise<void> {\n  let allowedDirs: string[];\n  let allowCwd: boolean;\n  let port: number | undefined;\n  try {\n    const parsed = await parseArgs();\n    ({ allowedDirs, allowCwd, port } = parsed);\n  } catch (error: unknown) {\n    if (error instanceof CliExitError) {\n      if (error.message.length > 0) {\n        console.error(error.message);\n      }\n      process.exitCode = error.exitCode;\n      return;\n    }\n    throw error;\n  }\n\n  if (allowedDirs.length > 0) {\n    console.error('Allowed directories (from CLI):');\n    for (const dir of allowedDirs) {\n      console.error(`- ${dir}`);\n    }\n  } else {\n    console.error(\n      `No directories specified via CLI. Will use MCP Roots${allowCwd ? ' or current working directory' : ''}.`\n    );\n  }\n\n  if (port !== undefined) {\n    activeHttpServer = await startHttpServer(port, {\n      allowCwd,\n      cliAllowedDirs: allowedDirs,\n    });\n  } else {\n    const serverAndHandle = await createServer({\n      allowCwd,\n      cliAllowedDirs: allowedDirs,\n    });\n    activeServer = serverAndHandle.server;\n    await startServer(serverAndHandle);\n  }\n}\n\nregisterShutdownTrigger('SIGTERM');\nregisterShutdownTrigger('SIGINT');\nregisterShutdownTrigger('end');\nregisterShutdownTrigger('close');\n\nprocess.once('unhandledRejection', (reason: unknown) => {\n  console.error('Unhandled rejection:', formatUnknownErrorMessage(reason));\n  void shutdown('unhandledRejection', 1);\n});\n\nprocess.once('uncaughtException', (error: Error) => {\n  console.error('Uncaught exception:', error);\n  void shutdown('uncaughtException', 1);\n});\n\nmain().catch((error: unknown) => {\n  console.error('Fatal error:', formatUnknownErrorMessage(error));\n  void shutdown('fatal', 1);\n});\n"
    }
  ]
}
```

---

## P2 Tool: `stat` (Metadata-only)

### Stat Request

```json
{
  "method": "tools/call",
  "params": {
    "name": "stat",
    "arguments": {
      "paths": ["src/index.ts", "package.json"]
    }
  }
}
```

### Stat Response

Metadata-only tools don't create resource links — they return structured content directly.

```json
{
  "content": [
    {
      "type": "text",
      "text": "stat: 2 paths examined"
    }
  ],
  "structuredContent": {
    "ok": true,
    "entries": [
      {
        "path": "src/index.ts",
        "type": "file",
        "size": 4231,
        "mimeType": "text/x-typescript",
        "mtimeMs": 1714982400000,
        "isSymlink": false,
        "isReadable": true,
        "isWritable": true
      },
      {
        "path": "package.json",
        "type": "file",
        "size": 2156,
        "mimeType": "application/json",
        "mtimeMs": 1714982400000,
        "isSymlink": false,
        "isReadable": true,
        "isWritable": true
      }
    ]
  }
}
```

---

## P3 Tool: `write-file` (Confirmation + Resource)

### Write-File Request

```json
{
  "method": "tools/call",
  "params": {
    "name": "write-file",
    "arguments": {
      "path": "src/new-module.ts",
      "content": "export const greeting = 'Hello, World!';\n"
    }
  }
}
```

### Write-File Response

Write operations confirm success with metadata and link to the written content.

```json
{
  "content": [
    {
      "type": "text",
      "text": "write-file: src/new-module.ts · 1 line · 42 B · text/x-typescript"
    },
    {
      "type": "resource_link",
      "uri": "filesystem-mcp://result/def456uvw012",
      "name": "src/new-module.ts",
      "mimeType": "text/x-typescript",
      "size": 42,
      "annotations": {
        "audience": ["user"]
      }
    }
  ],
  "structuredContent": {
    "ok": true,
    "path": "src/new-module.ts",
    "size": 42,
    "lineCount": 1,
    "mimeType": "text/x-typescript",
    "kind": "text",
    "resourceUri": "filesystem-mcp://result/def456uvw012"
  }
}
```

---

## Key Patterns

### Summary Format

All tools include a terse text summary as the first `content` block:

- **Format:** `<tool-name>: <action summary> · <unit 1> · <unit 2> · <MIME type>`
- **Example:** `read: src/index.ts · 139 lines · 4.2 KB · text/x-typescript`
- **Purpose:** Allows models to skim the summary without fetching the full resource

### Resource Link Block

Payload-producing tools (P1) include one or more `resource_link` blocks:

```ts
{
  type: "resource_link",
  uri: "filesystem-mcp://result/<id>",
  name: "src/index.ts",           // original path or descriptive name
  mimeType: "text/x-typescript",
  size: 4231,
  annotations: {
    audience: ["user"]             // defaults to ["user"]; ["user", "assistant"] for small text
  }
}
```

### Structured Content

Every tool returns `structuredContent` with:

- **Always:** `ok: boolean`, `path: string` (where applicable)
- **For payloads:** `size`, `lineCount`, `mimeType`, `kind`, `resourceUri`
- **For metadata:** Tool-specific fields (e.g., `entries` for `stat`)
- **Never:** Raw file body (that lives in the resource store)

### Resource Fetch Lifetime

- **TTL:** 60 seconds (not configurable per tool)
- **Storage caps:** 64 entries max, 25 MiB total, 10 MiB per entry
- **LRU eviction:** Oldest entries evicted first if storage is full
- **Client responsibility:** Fetch resources immediately after receiving the tool response; don't assume they'll be available later
