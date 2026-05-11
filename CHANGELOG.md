# Changelog

All notable changes to `@allstak/react-native` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] — 2026-05-11

### Added

- Runtime `debugId` resolution per error frame via `globalThis._allstakDebugIds`.
- `debugMeta.images[]` aggregation in error payloads.

### Fixed

- Error frames now include `debugId` field for precise source map matching.

## [0.3.0] — 2026-05-08

### Added

- Full automatic HTTP instrumentation (fetch interception).
- Hermes source map injection and upload pipeline.
- Expo config plugin for automatic source map handling.
- EAS Build post-bundle hook for CI source map uploads.

## [0.2.0] — 2026-04-25

### Added

- Scope management for tags, extras, and context.
- Distributed tracing with automatic request header propagation.
- Replay surrogate events for session context.
- Expo integration with config plugin.
- New Architecture (Fabric) detection.
- Navigation breadcrumb helpers.

## [0.1.4] — 2026-04-10

### Changed

- Standalone release on public npm as `@allstak/react-native`.

### Added

- Native crash capture via `ErrorUtils.setGlobalHandler`.
- Unhandled promise rejection capture.
- `beforeSend` callback, `sampleRate`, `setTags`/`setExtra`/`setContext`.
- `flush()` with bounded timeout.
- Hermes stack trace parsing.
- Android and iOS native crash handler modules.

## [0.1.1] — 2026-03-28

Initial professional release.

### Added

- Core error capture with React Native stack parsing.
- Breadcrumb ring buffer (max 50).
- Fail-open transport with exponential backoff.
- Circuit breaker on 401 responses.
