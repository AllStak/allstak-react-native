# Changelog

All notable changes to `@allstak/react-native` are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.1] — 2026-05-18

### Fixed

- Masking primitives (`AllStakMaskedView`, `AllStakPrivacyView`,
  `AllStakTextInput`, `AllStakSensitiveText`) now resolve the
  `react-native` module reference lazily at render time instead of
  at module-load time. Caught during simulator cert: Metro bundles
  `react-native` separately from the SDK, so a top-of-file
  `require('react-native')` could resolve to a stale stub and cause
  `View config getter callback for component TextInput must be a function`
  red-screens in dev. Render-time resolution fixes this on every
  Metro reload.
- Provider's root-view wrapper uses the same lazy resolution.

## [0.4.0] — 2026-05-18

### Added

- **Flat screenshot API** on `AllStakProvider` and `AllStak.init()`:
  `captureScreenshotOnError`, `screenshotRedaction`,
  `screenshotMaskStyle`, `screenshotMaxBytes`, `screenshotQuality`,
  `screenshotFormat`, `screenshotSampleRate`,
  `screenshotOnUnhandledOnly`, `screenshotUploadTimeoutMs`,
  `screenshotCaptureTimeoutMs`, `screenshotNativeMode`,
  `screenshotFailPolicy`, `beforeScreenshotCapture`,
  `beforeScreenshotUpload`, `isScreenshotAllowed`. Matches the props
  the AllStak wizard (`@allstak/wizard@>=0.1.16`) writes — no manual
  callback wiring required.
- **Masking primitives** for privacy-safe captures:
  `AllStakMaskedView`, `AllStakPrivacyView`, `AllStakTextInput`,
  `AllStakSensitiveText`, plus the `useAllStakPrivacy()` hook.
- **Native capture via `react-native-view-shot`** as an optional peer
  dependency. The SDK lazy-requires it; absence is a silent no-op
  (event still ships).
- **Runtime detection** (`detectRuntimeMode`): `expo-go` |
  `expo-dev-client` | `rn-cli` | `unknown`. Expo Go is detected and
  screenshots are skipped silently with status
  `screenshot.status: unsupported_runtime`.
- **Attachment upload pipeline** posts the captured image to
  `POST /ingest/v1/errors/{eventId}/attachments` (JSON / base64 wire
  format) with capture metadata. Bounded retries, per-attempt timeout,
  fail-open at every step.

### Changed

- `AllStakProvider` now wraps `children` in a ref'd root view so
  view-shot can capture by reference. Backward-compatible.
- The callback-based `config.screenshot.provider` API from 0.3.x is
  retained for backward compatibility; if both APIs are configured the
  flat API wins and a one-time deprecation warning is logged.
- Bumped `SDK_VERSION` to `0.4.0`.

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
