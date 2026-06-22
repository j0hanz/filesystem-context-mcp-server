# ADR-0001: Unified Search Coordinator

**Date**: 2026-06-22
**Status**: Accepted

## Problem

Search logic (content search and file path search) is split between tools (`search-content.ts` and `search-files.ts`), causing high coupling (100% co-change rate). Complex routines for cursor pagination, limit validation, resource store management, and concurrency timeouts are duplicated or tightly bound to MCP tool schemas. Testing tools requires invoking full file-system globbing and search routines.

## Decision

Centralize search orchestration in a core `search` module under `src/core/search/`. Expose two primary API functions: `searchContent` and `searchFiles` that manage the underlying RE2 regex compiler, `SearchWorkerPool` concurrency, timeout signals, and cursor pagination. Individual tools in `src/tools/` will become thin schema wrappers that delegate to this coordinator.

## Rationale

Decouples the presentation/tool schema layer from CPU-bound search infrastructure. Resolves git co-change coupling. Allows testing pagination and timeout boundaries in-memory or with filesystem doubles.

## Implications

- `src/tools/search-content.ts` and `src/tools/search-files.ts` only handle schema validation and map input/output.
- Concurrency management, pagination cursor encoding/decoding, and time-out handling are hidden from tool wrappers.
- No direct import of RE2 or worker threads pool inside tools.
- Tests can mock file systems or search engine calls independently.

## Related Issues

None.
