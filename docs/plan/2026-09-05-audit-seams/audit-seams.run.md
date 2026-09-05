# Run: Land the three architecture-audit seams

Evidence log for the execution contract in
[Land the three architecture-audit seams](audit-seams.map.md). One entry per
task ticket: command, exit code, pass/fail counts, commit hash.

## Entries

- **T-01** 2026-09-05 — `node scripts/tasks.mjs fix` (format + lint-fix) then
  `node scripts/tasks.mjs` → exit 0; static gate clean (`All matched files use
  Prettier code style!`, knip clean); tests 273 / suites 62 / pass 273 /
  fail 0 / cancelled 0. Commit `fee482cb` on `main`.
- **T-02** 2026-09-05 — `node scripts/tasks.mjs fix` → exit 0; static gate
  clean; tests 273 / pass 273 / fail 0 / cancelled 0. Pinned batch cases
  (`TC-FUNC-009b`, `TC-FUNC-009d`, "a call where every path failed is
  reported as isError", "a partly-failed batch is not isError",
  `HTTP-004`) passed unmodified. Commit `5cf5e0b1` on `main`.
- **T-05** 2026-09-05 — red first: `node scripts/tasks.mjs test
  '--test-name-pattern=TC-FUNC-063: list paginates|first page only'` → 2 fail
  (`TC-FUNC-063` on the inverted `resourceUri` assertion; the new
  `search_text … first page only` case on the continuation page's
  `resourceUri`). Then `node scripts/tasks.mjs fix` → exit 0; static gate
  clean; tests 274 / pass 274 / fail 0 / cancelled 0. Commit `4c8dd15c` on
  `main`.
