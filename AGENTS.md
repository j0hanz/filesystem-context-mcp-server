# AGENTS.md

MCP Server (`filesystem-mcp`) that enables LLMs to interact with the local filesystem via the Model Context Protocol — providing navigation, search, file management, and analysis tools strictly scoped to allowed root directories.

**Package manager:** npm · **Node.js:** >=24 · **TypeScript:** strict, ESM/NodeNext

---

## Commands

```bash
# Build (compiles src/ → dist/ via tsconfig.build.json)
npm run build

# Type-check source only (fast)
npm run type-check:src

# Type-check tests
npm run type-check:tests

# Lint
npm run lint

# Lint + auto-fix
npm run lint:fix

# Format
npm run format

# Run all tests
npm test

# Run tests fast (without coverage, no task runner)
npm run test:fast

# Run a specific test file
node --test --import tsx/esm src/__tests__/<path/to/file>.test.ts

# Clean build artifacts
npm run clean

# Dev mode (watch build)
npm run dev

# Inspect server with MCP inspector
npm run inspector
```

> `npm test` and `npm run build` are **slow** (full task runner). Prefer `test:fast` and `type-check:src` for iterative work.

---

## Safety and Permissions

### Always

- Run `npm run type-check:src` after every TypeScript change.
- Run `npm run test:fast` (or the specific test file) after changes to `src/`.
- Follow the tool pattern in [`src/tools/read.ts`](src/tools/read.ts) for any new or modified tool.
- Use `z.strictObject()` for all Zod schemas; add `.describe()` to every field.
- Use `.js` extensions in all local imports (NodeNext/ESM requirement).
- Use named exports only; `import type` for type-only imports; explicit return types on exported functions.
- Keep `ToolContract` metadata (`name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`) complete in every tool file.

### Ask first

- Adding new npm dependencies.
- Changing `src/lib/path-policy.ts` or `src/lib/path-validation.ts` — these are security-critical path boundary enforcement files.
- Changing `src/server/bootstrap.ts` — transport initialization, task store, and HTTP server setup.
- Running `npm run build` or `npm run prepublishOnly` (slow, triggers full compile + lint + type-check).
- Any change to `Dockerfile`, `docker-compose.yml`, or publish-related scripts.
- Bulk refactors across `src/tools/*.ts` that alter public tool behaviour visible to MCP clients.

### Never

- Edit files in `dist/` — always generated; changes are overwritten on next build.
- Copy patterns from `node-tests/` into `src/__tests__/` (different runner setup; kept separate intentionally).
- Commit secrets, `.env` files, or client-specific config.
- Bypass strict TypeScript options (`strict`, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`, `exactOptionalPropertyTypes`) — all must stay enabled.
- Use default exports anywhere in the source.
- Use single-backslash regex escape sequences without verifying ESLint (`sonarjs/duplicates-in-character-class`).

---

## Navigation

| Path                 | Role                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`       | CLI entrypoint (shebang, transport selection, shutdown)                                                                |
| `src/server.ts`      | `McpServer` instance + capability registration                                                                         |
| `src/tools/`         | One file per MCP tool; `shared.ts` = response builders and `wrapToolHandler`; `contract.ts` = `ToolContract` interface |
| `src/schemas.ts`     | All Zod input/output schemas (re-exported to tools)                                                                    |
| `src/lib/`           | Core utilities: `errors.ts`, `path-policy.ts`, `path-validation.ts`, `resource-store.ts`, `fs-helpers.ts`              |
| `src/server/`        | `bootstrap.ts` (transport/task wiring), `roots-manager.ts`, `capabilities.ts`, `logging.ts`                            |
| `src/resources/`     | MCP resource content: `generated-instructions.ts`, `tool-catalog.ts`, `tool-info.ts`, `workflows.ts`                   |
| `src/completions.ts` | MCP completion handlers                                                                                                |
| `src/prompts.ts`     | MCP prompt registration                                                                                                |
| `src/__tests__/`     | Tests: `integration/`, `lib/`, `security/`, `server/`, `tools/`                                                        |
| `node-tests/`        | Tests for Node-specific runtime features (search workers, `isNodeError`)                                               |
| `scripts/tasks.mjs`  | Build orchestration (clean, compile, copy assets, run tests)                                                           |
| `assets/`            | Static assets copied to `dist/assets/` on build                                                                        |

---

## Tool Implementation Pattern

Every tool follows this contract (copy from `src/tools/read.ts`):

```ts
// 1. Define contract
export const MY_TOOL: ToolContract = {
  name: 'my_tool',
  title: 'My Tool',
  description: 'What it does and when to call it.',
  inputSchema: MyInputSchema,       // z.strictObject(...)
  outputSchema: MyOutputSchema,     // z.strictObject(...)
  annotations: READ_ONLY_TOOL_ANNOTATIONS, // or DESTRUCTIVE_TOOL_ANNOTATIONS
  nuances: ['Edge case note.'],
} as const;

// 2. Implement handler
async function handleMyTool(
  args: z.infer<typeof MyInputSchema>,
  signal?: AbortSignal
): Promise<ToolResponse<z.infer<typeof MyOutputSchema>>> {
  // ...
  return buildToolResponse({ ok: true, result: { ... } });
}

// 3. Register tool
export function registerMyTool(server: McpServer, opts: ToolRegistrationOptions): void {
  wrapToolHandler(server, MY_TOOL, withValidatedArgs(MY_TOOL, (args, extra) =>
    handleMyTool(args, extra.signal)
  ), opts);
}
```

Key helpers from `src/tools/shared.ts`:

- `wrapToolHandler` — wraps registration with diagnostics + error handling
- `withValidatedArgs` — Zod parse + structured error on bad input
- `buildToolResponse` / `buildToolErrorResponse` — canonical response shape
- `maybeExternalizeTextContent` — offloads large output to `filesystem-mcp://result/{id}`
- `READ_ONLY_TOOL_ANNOTATIONS` — `{ readOnlyHint: true, destructiveHint: false, openWorldHint: false }`

For long-running tools, call `registerToolTaskIfAvailable` in the registration step (see `src/tools/search-content.ts`).

---

## Schema Conventions

```ts
// Input — always strictObject with .describe() on every field
export const MyInputSchema = z.strictObject({
  path: z.string().min(1).describe('Absolute path to the file.'),
  limit: z.number().int().min(1).max(1000).optional().describe('Max results.'),
});

// Output — always strictObject
export const MyOutputSchema = z.strictObject({
  ok: z.boolean(),
  result: z.strictObject({ ... }).optional(),
});
```

Schemas live in `src/schemas.ts` and are re-exported for use in tools. Keep schema descriptions concise (token budget matters).

---

## Error Handling

Use `src/lib/errors.ts` helpers:

- `isNodeError(err)` — narrows `NodeJS.ErrnoException`
- `formatUnknownErrorMessage(err)` — safe string extraction
- Throw `McpError` with an `ErrorCode` for protocol-level tool errors
- Return `buildToolErrorResponse(ErrorCode.Xxx, message)` for user-facing tool failures
- Never let raw `Error` objects surface to MCP responses

---

## Examples to Follow

- **Canonical tool**: [`src/tools/read.ts`](src/tools/read.ts) — contract, handler, registration, schema reference
- **Destructive tool**: [`src/tools/delete-file.ts`](src/tools/delete-file.ts) — `destructiveHint: true`, confirmation patterns
- **Task-enabled tool**: [`src/tools/search-content.ts`](src/tools/search-content.ts) — `registerToolTaskIfAvailable`, progress, cancellation
- **Error classification**: [`src/lib/errors.ts`](src/lib/errors.ts)
- **Path boundary enforcement**: [`src/lib/path-policy.ts`](src/lib/path-policy.ts) + [`src/lib/path-validation.ts`](src/lib/path-validation.ts)

## Patterns to Avoid

- Do **not** copy patterns from `node-tests/` into `src/__tests__/` (different bootstrap).
- Do **not** use `z.object()` (strips unknown keys silently) — always use `z.strictObject()`.
- Do **not** use `as` casts to bypass Zod parsing — use `withValidatedArgs` or narrow with type guards first.
- Do **not** write tools that access paths without going through `validatePath` / `PathPolicy` — see security tests in `src/__tests__/security/`.

---

## PR / Change Checklist

- [ ] `npm run type-check:src` passes (no type errors)
- [ ] `npm run lint` passes (no ESLint errors)
- [ ] Relevant tests pass: `node --test --import tsx/esm src/__tests__/<area>/**/*.test.ts`
- [ ] New tool has `ToolContract` with `name`, `title`, `description`, `inputSchema`, `outputSchema`, `annotations`
- [ ] Schemas use `z.strictObject()` with `.describe()` on every field
- [ ] All local imports use `.js` extensions
- [ ] No default exports introduced
- [ ] Path operations go through path validation utilities (not raw `fs` calls on user input)
- [ ] `dist/` not committed

---

## When Stuck

1. Ask one clarifying question about scope before making wide edits.
2. Read the relevant test files in `src/__tests__/tools/` or `src/__tests__/security/` — they document expected behaviour precisely.
3. Check `src/tools/shared.ts` for existing helpers before writing new utilities.
4. For MCP protocol questions, see `.github/instructions/typescript-mcp-server.instructions.md`.
