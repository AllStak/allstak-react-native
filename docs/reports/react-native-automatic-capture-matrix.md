# Automatic Capture Matrix — audit + verification report

**Date:** 2026-05-01
**SDK version under test:** `@allstak/react-native@0.3.0`
**Goal:** for every advertised capture, document the truth from the
source code (not the README) and back it with a passing test.

The matrix itself lives in the README. This report explains where each
row's status came from in the source, and what test verifies it.

## Method

1. Read every file in `src/` line by line and tag each capture path with
   one of: `auto-default`, `auto-flag-required`, `manual-only`,
   `not-supported`, `implemented-not-device-verified`.
2. Map each path to the wire form it produces (which ingest endpoint /
   what payload field).
3. Run the existing 98 tests, identify which paths lack coverage.
4. Add `test/capture-matrix.test.mjs` (10 new tests) for the gaps.
5. Run the full suite — 108 tests now pass.

## Source audit — file-by-file

### `src/install.ts` (the runtime integration)

| Line | Capture | Default | Flag |
|---|---|---|---|
| 101 | `setTag('platform', 'react-native')` | always | n/a |
| 102 | `applyArchitectureTags(...)` → `rn.architecture`, `rn.bridgeless`, `rn.hermes` | always | n/a |
| 115 | `setIdentity({ sdkName, sdkVersion, platform, dist })` — auto-detect `dist` from Hermes/JSC + Platform.OS | always | n/a |
| 123 | `instrumentXmlHttpRequest()` (XHR breadcrumbs) | on | `autoNetworkCapture !== false` |
| 130 | `instrumentFetch(safeBc, baseUrl)` (fetch breadcrumbs) | on | `autoFetchBreadcrumbs !== false` |
| 136 | `instrumentConsole(safeBc)` (console.warn / error → log breadcrumbs) | on | `autoConsoleBreadcrumbs !== false` |
| 142 | `setTag('device.os', Platform.OS)` etc. | on | `autoDeviceTags !== false` |
| 155 | `AppState.addEventListener('change', ...)` | on | `autoAppStateBreadcrumbs !== false` |
| 171 | `ErrorUtils.setGlobalHandler(...)` | on | `autoErrorHandler !== false` |
| 189 | `rejection-tracking.enable({ allRejections: true, ... })` (Hermes); fallback to `globalThis.addEventListener('unhandledrejection')` | on | `autoPromiseRejections !== false` |

### `src/auto-breadcrumbs.ts` (fetch + console wrappers)

- Lines 53–59: HTTP breadcrumbs use `level: 'error'` for status >= 400,
  otherwise `'info'`. **This is what makes 4xx and 5xx auto-capture.**
- Line 65: on fetch throw, records breadcrumb with `level: 'error'`,
  `data.error: String(err)`, then rethrows. **Network failures auto-capture.**
- Lines 80–93: only `console.warn` and `console.error` are wrapped.
  `console.log` and `console.info` are **not** captured.

### `src/http-instrumentation.ts` (full HTTP request events)

- Whole module is gated on `enableHttpTracking: true` (see
  `client.ts:192`). Off by default. Privacy defaults are aggressive
  (bodies + headers off) — see `http-redact.ts`.

### `src/transport.ts` (offline queue)

- Lines 12–34: `MAX_BUFFER = 100`, in-memory ring buffer. On send
  failure, payload pushed onto buffer; on next successful send, buffer
  drained. **No persistence to AsyncStorage / disk.** Lost on app
  restart. Documented as a roadmap item.

### `src/provider.tsx` (the React layer)

- Wraps children in `AllStakErrorBoundary`. Render errors inside
  children are caught and shipped with
  `metadata.source = 'AllStakProvider.ErrorBoundary'`.

### `src/navigation.ts` (router breadcrumbs)

- `instrumentReactNavigation(ref, opts?)` and
  `instrumentNavigationFromLinking()` — both **manual**, both
  idempotent. There is no auto-installation that detects
  `@react-navigation/native`.

### `src/index.ts` (native crash drain)

- Line 67 — `drainPendingNativeCrashes(release?)` must be called
  manually after init. The native modules under `native/` exist but
  remain unverified on a real device.

## Tests added in this pass

File: `test/capture-matrix.test.mjs` — **10 new tests, all passing.**

| # | Test | Verifies |
|---|---|---|
| 1 | HTTP 4xx response is recorded as a breadcrumb at level=error | `auto-breadcrumbs.ts:53–59` for 404 |
| 2 | HTTP 5xx response is recorded as a breadcrumb at level=error | same path for 502 |
| 3 | fetch network failure records a breadcrumb with error data and rethrows | `auto-breadcrumbs.ts:62–70` |
| 4 | console.warn AND console.error are captured as log breadcrumbs at the right level | `auto-breadcrumbs.ts:80–95` |
| 5 | AppState change emits a navigation breadcrumb when autoAppStateBreadcrumbs is on | `install.ts:155–163`, exercised via fake `react-native` mock injected through `globalThis.require` |
| 6 | Platform.OS / Platform.Version / Model land on the event payload when autoDeviceTags is on | `install.ts:142–152` |
| 7 | SDK identity is stamped: sdkName / platform / dist on every event | `install.ts:115` + `client.ts` releaseTags |
| 8 | Architecture tags (rn.architecture, rn.bridgeless, rn.hermes) are set on init | `install.ts:102` |
| 9 | release + environment from init flow into every payload | `client.ts` payload assembly |
| 10 | setUser, setTag, setContext propagate to subsequent events | `client.ts` setUser/setTag/setContext |

### Mock strategy for tests 5–8

`installReactNative` lazy-requires `react-native` and
`promise/setimmediate/rejection-tracking`. The compiled bundle uses
tsup's `__require` helper that falls back to `globalThis.require`. The
test file sets `globalThis.require` to a function that returns a fake
`react-native` exposing `Platform`, `AppState`, `NativeModules`, and
`Linking`. This is the cleanest way to exercise the RN-runtime paths
inside Node's ESM environment without spinning up a simulator.

## Full test run

```sh
$ npm test
...
# tests 108
# pass 108
# fail 0
# duration_ms 5365
```

Breakdown:
- 78 pre-existing tests (smoke, instrumentation, http-instrumentation,
  scope, replay, tracing, expo-plugin, architecture, autolinking)
- 6 provider export-shape tests
- 9 provider runtime / lifecycle tests
- 5 provider integration tests (ErrorUtils + debug-log discipline)
- 10 capture-matrix tests (this pass)

## Specific config-flag answers (as requested)

> If HTTP tracking, console log capture, AppState breadcrumbs, or
> platform tags require config flags, document the exact config prop.

- **HTTP request breadcrumbs:** auto-on. Disable with
  `<AllStakProvider autoFetchBreadcrumbs={false} autoNetworkCapture={false}>`.
- **HTTP request EVENTS** (full payload, bodies / headers): off by
  default. Enable with `<AllStakProvider enableHttpTracking>`. Configure
  redaction / capture via `httpTracking={{ ... }}`.
- **`console.warn` / `console.error`:** auto-on. Disable with
  `<AllStakProvider autoConsoleBreadcrumbs={false}>`. **`console.log` and
  `console.info` are not captured today.**
- **AppState breadcrumbs:** auto-on. Disable with
  `<AllStakProvider autoAppStateBreadcrumbs={false}>`.
- **Platform tags (`device.os`, `device.osVersion`, `device.model`):**
  auto-on. Disable with `<AllStakProvider autoDeviceTags={false}>`.

## Items explicitly marked "Not supported yet" (added to roadmap)

1. **`console.log` / `console.info` capture.** Only `warn` and `error`
   are wrapped. Adding `log`/`info` is straightforward (mirror the
   existing two methods in `auto-breadcrumbs.ts:76–94`) but was kept
   out to avoid breadcrumb-spam from typical app logging.
2. **React Native runtime version (`rn.version`).** Today only the OS
   version is captured (`device.osVersion`). The RN package version is
   trivially available from `require('react-native/package.json').version`
   but is not currently read.
3. **Persistent offline queue.** The current implementation buffers up
   to 100 events in RAM and retries on next send, but loses everything
   on app restart. AsyncStorage-backed persistence is the planned
   improvement.
4. **Auto-detection of `@react-navigation/native`.** Today the host app
   must call `instrumentReactNavigation(navigationRef)` once after
   `<NavigationContainer>` mounts.

## Items marked "Implemented, not device-verified"

- **iOS native crashes** — `native/ios/AllStakCrashHandler.{h,m}` +
  `AllStakRNModule.m`. Wired through `drainPendingNativeCrashes()`. JS
  side unit-tested in `test/instrumentation.test.mjs:226`. Has not been
  run against a real iOS build / simulator.
- **Android native crashes** — `native/android/.../AllStakCrashHandler.java`
  + `AllStakRNModule.java`. Same status.

The README now flags both with the exact phrase
**"Implemented, not device-verified"** — no production-readiness claim.
