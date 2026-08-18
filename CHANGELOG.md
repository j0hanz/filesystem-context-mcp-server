# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Introduced `PathFormatter` boundary to decouple tools from `node:path`.
- Created unified Search Coordinator.
- Added `src/client-config.ts` for moved installer code.
- Added `docs/mcp-decisions.md` recording protocol, transport, and security decisions.

### Fixed

- **`--api-key` and `--http-host` had no effect.** Both were parsed and
  documented but never reached the HTTP server, so `--api-key <secret>` started
  an unauthenticated server. `--log-level`, `--max-file-size`,
  `--root-boundary`, `--allow-sensitive`, and `--deny` were dropped the same
  way. All seven now take precedence over their environment variable, as
  `--help` has always claimed.
- **`LOG_LEVEL` / `--log-level` now filters output.** The value was parsed and
  ignored; every message reached stderr regardless. Messages below the
  configured severity are now suppressed — with the default of `info`, `debug`
  output no longer appears unless requested.
- A loopback HTTP bind rejected `Host: localhost` and `Host: [::1]` with
  `403 Invalid Host`, so `http://localhost:<port>/mcp` failed on a default
  server. All three loopback spellings are accepted.
- `FILESYSTEM_MCP_ALLOWED_HOSTS` values consisting only of separators or
  whitespace read as an empty allow-list that rejected every request; they now
  read as unset.
- A `500` on the HTTP POST route replied with `id: null` even when the request
  carried an id, leaving clients waiting for a correlatable response.

### Changed

- Updated core dependencies.
- Refined internal schemas and agent configurations.
- `--api-key` is documented as development-only; `API_KEY` is the supported
  channel, since argv is world-readable.

### Removed

- **Removed the `logging` capability and the `logging/setLevel` handler.**
  Clients calling `logging/setLevel` now receive `METHOD_NOT_FOUND`. The
  handler only set a field nothing read, and SEP-2577 deprecates the subsystem;
  diagnostics go to stderr, controlled by `LOG_LEVEL`.

- Removed dead diagnostics, tracing, and performance tests from `observability.test.ts`.
- Removed dead W3C trace surface and unreachable diagnostics config from `observability.ts`.
- Removed dead `startPerfMeasure`/`withOpsTrace` and `withToolDiagnostics` subsystems.
- Removed dead `RESOURCE_STORE_DIAGNOSTICS_CHANNEL` and `LIFECYCLE_CHANNEL` publishers.

[Unreleased]: https://github.com/j0hanz/filesystem-mcp/compare/v1.19.1...HEAD
