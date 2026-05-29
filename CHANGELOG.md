# Changelog

All notable public changes to `@allstak/react-native` are documented here.

## Unreleased

Feature waves landed since `v0.5.11`. Version number unchanged pending the
release gate.

### Added

- **Release-health session tracking.** New `Session` / `SessionTracker`
  (`session.ts`) start/end a session per app run, derive session status
  (`ok` / `errored` / `crashed` / `abnormal`), and report crash-free metrics so
  release health can be computed server-side. Sessions are wired into the
  client lifecycle and install flow.
- **Offline / persistent event queue.** A pluggable persistent transport queue
  (`persistence.ts`, `setPersistence`, `PersistentEventStore`,
  `PersistenceStorage`/`PersistenceOptions`/`PersistedEntry` types) writes
  already-scrubbed payloads to a storage adapter when the device is offline or
  the app shuts down with events still buffered, then replays them on the next
  init instead of dropping them.
- **Value-pattern PII scrubbing + `sendDefaultPii`.** New
  `scrubString` / `scrubValueTree` (`value-scrub.ts`, `ValueScrubOptions`)
  redact credit-card, SSN, email, and IP patterns in free-text fields,
  breadcrumbs, log messages, and HTTP bodies by default. A `sendDefaultPii`
  flag (default `false`,-compatible) opts back into capturing the
  lower-risk categories.
- **Android NDK / native-signal crash capture.** A new async-signal-safe native
  handler (`allstak_signal_handler.cpp`, `AllStakNdk.java`, CMake build) captures
  POSIX/NDK signal crashes (SIGSEGV / SIGABRT / SIGBUS / SIGILL / SIGFPE /
  SIGTRAP) from JNI, C/C++, the NDK, and the JSI/Hermes engine. JS toggles it
  via `captureNativeSignals` (mapped to the native
  `installWithOptions(release, captureNativeSignals)`), with a graceful fallback
  when the native signal library is absent.
- **Automatic runtime release registration.** New `autoRegisterRelease` config
  (default `true`) registers the resolved release with AllStak at SDK init via
  `/ingest/v1/releases`; it is skipped in test runtimes and when no API key or
  release is resolved.

## 0.5.9 - 2026-05-20

- Added performance trace sampling metadata, propagation headers, app-start spans, navigation spans, native frame metrics, HTTP spans, and sampled profile chunks.

## 0.5.8 - 2026-05-20

- Fixed HTTP response body capture metadata so unavailable React Native
  response bodies are reported as unsupported instead of disabled.
- Kept request and response body capture enabled by default with automatic
  sensitive-field redaction.

## 0.5.5 - 2026-05-20

- Moved error screenshots to the SDK native module so apps do not need an
  external screenshot package.

## 0.5.4 - 2026-05-20

- Simplified the public React Native README to match the standard setup flow:
  agent-assisted setup, install, configure, verify, and next steps.
- Removed advanced setup details from the package quickstart docs.

## 0.5.3 - 2026-05-20

- Cleaned the public README.

## 0.5.2 - 2026-05-20

- Updated package documentation and npm package hygiene.

## 0.5.1 - 2026-05-20

- Updated React Native event capture behavior and public package metadata.

## 0.5.0 - 2026-05-18

- Added richer React Native event context.

## 0.4.0 - 2026-05-17

- Added React Native package foundation.
