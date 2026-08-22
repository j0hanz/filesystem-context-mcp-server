# Bug Hunt: test-coverage-fixes

Hunted the landed change for the
[`test-coverage-fixes.plan`](test-coverage-fixes.plan.md) against the working
tree (changes uncommitted; `--since 4ebc284` sees nothing — passed the 6 paths
explicitly). Axes: correctness and security.

## Verdict

**Zero findings.** A clean, low-risk change. The schema-surface narrowing
(format → pattern) is the only place a wrong result could hide, and every
emitted value traces to an encoder inside the alphabet; the server re-validates
the loosened input.

## Confirmed

None.

## Suspected

None.

## Checks that could have been findings, and why they are not

- **`Sha256Hex` lowercase-only regex vs case-insensitive `z.hash('sha256')`.**
  `schema.ts:17` — `/^[0-9a-f]{64}$/` rejects uppercase hex the old validator
  accepted. Not a finding: `Sha256Hex` is **output-only**
  ([`read.ts:119`](../../../src/tools/read.ts#L119), in the read output schema),
  and the only producer is `computeSha256` → `createHash('sha256').digest('hex')`
  which is lowercase. No client input path uses it; no uppercase value is ever
  emitted or round-tripped.
- **`CursorSchema`/`NextCursorSchema` charset regex vs `z.base64url()`.**
  `schema.ts:456,464` — `/^[A-Za-z0-9_-]+$/` is the base64url alphabet without
  padding. Not a finding: the sole cursor encoder is
  [`cursor.ts:4`](../../../src/core/cursor.ts#L4)
  `Buffer.from(...).toString('base64url')`, which emits no `=` padding (Node
  `base64url` strips it), so emitted `nextCursor` values always match the
  pattern and AJV's now-strict `pattern` check passes. On the input side the
  regex is **looser** than true base64url (no length/alignment constraint), but
  the real guard is [`cursor.ts:55`](../../../src/core/cursor.ts#L55)
  `decodeOffsetCursor`, which `JSON.parse`-validates and throws
  `FsError(INVALID_INPUT)` on any malformed cursor — a value that slips past
  the looser regex is rejected there.
- **`createStdioClient` subprocess leak.** `helpers.ts:140` — not a finding:
  `StdioClientTransport.close()` sends `SIGTERM` then `SIGKILL` to the child
  ([`stdio.mjs:175-195`](../../../node_modules/@modelcontextprotocol/client/dist/stdio.mjs)),
  guarded by a `_process` null check so the `client.close()` → `transport.close()`
  double call is harmless. Subprocess stderr defaults to `inherit`
  ([`stdio.d.mts:24`](../../../node_modules/@modelcontextprotocol/client/dist/stdio.d.mts)),
  so server startup logs go to the parent's stderr — never stdout — keeping the
  JSON-RPC stream clean (the test run confirmed: STDIO-001/002 pass, no hang).
- **`move.ts` dest-stat swallow.** `move.ts:161,210` — not a finding: the new
  `missing` flag silences only `ENOENT` (raw Node) and `NOT_FOUND`
  (`FsError`); any other error code on either type still warns. `FsError.code`
  is the FsError string ([`errors.ts:391`](../../../src/core/errors.ts#L391)),
  never `'ENOENT'`, so the two clauses are disjoint — no unexpected error is
  misclassified as missing.
- **`tools.test.ts` enum cast.** `tools.test.ts:105` —
  `(err as { code: ProtocolErrorCode }).code` is a type-only assertion; at
  runtime `err.code` is the number `-32602` and compares equal to the enum
  member. No behavior change.

## Coverage

**Read in full** (6 changed files, post-prettier): `src/core/schema.ts`,
`src/tools/move.ts`, `__tests__/helpers.ts`, `__tests__/tools.test.ts`,
`__tests__/stdio.test.ts`, `__tests__/http-policy.test.ts`. Full `git diff`
reviewed to confirm no scope creep (5 files, +124/-12, exactly the planned
edits).

**Blast radius pulled in** (read far enough to judge the changed contract):
- `src/tools/read.ts:112-125` — confirmed `Sha256Hex` is output-only.
- `src/core/cursor.ts` — confirmed the sole cursor encoder and the input
  decode guard.
- `src/tools/search-files.ts`, `src/tools/search-content.ts` — confirmed
  `CursorSchema`/`NextCursorSchema` are the input `cursor` and output
  `nextCursor` fields; input routes to `decodeOffsetCursor`.
- `node_modules/@modelcontextprotocol/client/dist/stdio.{d.mts,mjs}` —
  confirmed `close()` reaps the subprocess and stderr defaults to `inherit`.

**Not audited (and why):** the unchanged schema exports (`NonNegInt`,
`RequiredPath`, `SafeGlobPattern`, etc.) — the diff touches only the three
format-emitting definitions; the rest of `schema.ts` is byte-identical.
`bearerAuthMiddleware`'s source (`src/http-policy.ts`) — read-only in the plan,
unchanged; the new tests assert its existing hardcoded `-32000` response shape
directly.

**Taken on trust:** `z.base64url()`'s acceptance set (whether it admitted
strings the regex now rejects) — not read in zod source; settled instead by the
server-side decode guard, which is the authoritative check regardless of the
client-facing schema.