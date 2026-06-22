# ADR-0002: High-Level Path Formatter

**Date**: 2026-06-22
**Status**: Accepted

## Problem

Node's native `node:path` module is imported directly by 11 different tool wrappers, causing infrastructure bleed into schema definitions. Additionally, platform-agnostic output formatting (converting Windows `\` to standard `/` slashes) is implemented ad-hoc via custom regexes or `win32` imports across several tools.

## Decision

Introduce a `PathFormatter` utility in `src/core/path-formatter.ts`. It will encapsulate all required path operations (`relative`, `basename`, `dirname`, `join`, `resolve`, `parse`, `sep`) and automatically normalize Windows path separators to Unix slashes (`/`) for all relative output paths. Tools will import `PathFormatter` instead of `node:path`.

## Rationale

Isolates the tool files from OS-level path parsing details, enforces uniform slash formatting for clients (crucial for cross-platform interoperability), and enables unit-testing tools with plain string path doubles without platform-specific separator mismatches.

## Implications

- No direct `node:path` or `node:path/win32` imports are allowed in `src/tools/`.
- All tools use `PathFormatter` for relative, basename, dirname, join, resolve, parse, and sep.
- Separator translation rules are centralized and tested in one place.

## Related Issues

None.
