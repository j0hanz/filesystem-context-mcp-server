# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- Introduced `PathFormatter` boundary to decouple tools from `node:path`.
- Created unified Search Coordinator.
- Added `src/client-config.ts` for moved installer code.

### Changed

- Updated core dependencies.
- Refined internal schemas and agent configurations.

### Removed

- Removed dead diagnostics, tracing, and performance tests from `observability.test.ts`.
- Removed dead W3C trace surface and unreachable diagnostics config from `observability.ts`.
- Removed dead `startPerfMeasure`/`withOpsTrace` and `withToolDiagnostics` subsystems.
- Removed dead `RESOURCE_STORE_DIAGNOSTICS_CHANNEL` and `LIFECYCLE_CHANNEL` publishers.

[Unreleased]: https://github.com/j0hanz/filesystem-mcp/compare/v1.19.1...HEAD
