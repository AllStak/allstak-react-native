# AllStakProvider verification report

**Date:** 2026-05-01
**SDK version under test:** `@allstak/react-native@0.3.0`
**Verifier:** automated agent run, single-machine end-to-end pass.

This report covers verification of the new `AllStakProvider` API. It exists
to substantiate every "the provider works" claim with a concrete artifact
(test name, command, console line, screenshot description) and to be honest
about what was **not** verified.

## What was verified

### 1. Cleanup behavior fix

The provider used to call `AllStak.destroy()` unconditionally on unmount,
which would tear down the SDK during Fast Refresh, route key changes, or
React 18 Strict Mode double-mount. Fixed by:

- Adding `destroyOnUnmount?: boolean` prop, **default `false`**.
- Adding a module-level guard `__providerOwnedInstance` so a remounted
  provider reuses the existing singleton instead of calling
  `AllStak.init()` (which would trigger an internal `destroy()` + recreate
  cycle, briefly breaking captures).
- Tested: 9 runtime tests in `test/provider-runtime.test.mjs`, including
  explicit `destroyOnUnmount=false` (instance survives), `destroyOnUnmount=true`
  (instance destroyed), and remount-with-default (same instance reused,
  same session id).

### 2. Unit + runtime tests

- **`test/provider.test.mjs`** — 6 export-shape tests. Pass.
- **`test/provider-runtime.test.mjs`** — 9 lifecycle tests using
  `react-test-renderer`. Pass.
- **`test/provider-integration.test.mjs`** — 5 integration tests with
  fake `ErrorUtils` and `console.log` capture. Pass.
- Full suite: **98 / 98 tests passing.**

Commands:

```sh
cd /Volumes/M.2/MyProjects/AllStak-Projects/sdks/allstak-react-native
npm run build           # ESM 59KB, CJS 60.9KB, DTS 28.7KB — clean
npm run typecheck       # zero errors
npm test                # 98 / 98 pass
```

### 3. Sample Expo app

- **Path:** `samples/expo-test/`
- **Template:** `npx create-expo-app@latest expo-test --template blank-typescript`
- **Versions:** Expo `~54.0.33`, React Native `0.81.5`, React `19.1.0`,
  TypeScript `~5.9.2`.
- **SDK install:** `npm install ../../allstak-react-native-0.3.0.tgz`
  (local tarball produced by `npm pack`).
- **Sample code:** `samples/expo-test/App.tsx` — wraps `<AppRoot>` in
  `<AllStakProvider apiKey="ask_test_local_sample" environment="development"
  release="expo-test@1.0.0" debug fallback={...} onError={...}>`. Five
  buttons exercise: manual `captureException`, manual `captureMessage`,
  uncaught throw via `setTimeout` (ErrorUtils path), unhandled promise
  rejection, render-time error.

### 4. TypeScript end-to-end

```sh
cd samples/expo-test && npx tsc --noEmit
```

Zero errors. The sample's `App.tsx` consumes
`{ AllStakProvider, AllStak }` from `@allstak/react-native` and the types
resolve correctly.

### 5. Metro bundle for iOS and Android

```sh
npx expo export --platform ios     --output-dir .verify         --dev
npx expo export --platform android --output-dir .verify-android --dev
```

Both succeeded:

- **iOS bundle:** 4.72 MB, 687 modules.
- **Android bundle:** 4.73 MB, 687 modules.
- SDK symbols present in iOS bundle (regex counts):
  `AllStakProvider`: 5, `installReactNative`: 4,
  `AllStakErrorBoundary`: 8, `captureException`: 13.
- Banned browser-API scan against `dist/index.mjs` (the published SDK
  artifact, not the merged Metro bundle):
  `window.`, `document.`, `localStorage`, `sessionStorage` — **all clean**
  (asserted by `test/smoke.test.mjs`'s "source code contains no banned
  browser APIs" test, which is part of the 98-test pass).

### 6. Live runtime — Expo Web

Used Expo's web target (same Metro pipeline as native, runs in browser)
to drive the sample app and confirm the provider's React behavior. The
SDK paths that depend on Hermes / native ErrorUtils don't fire on web,
but the React-side paths (boundary, fallback, resetError, onError,
manual captures, unhandled-rejection) do.

```sh
cd samples/expo-test
npx expo export --platform web --output-dir .verify-web --dev
cd .verify-web && python3 -m http.server 8765
# Open http://localhost:8765/ in Chrome
```

Initial page render after fix to `react-dom@19.1.0` (template default
shipped with `19.2.5`, version-mismatched). After the pin, the page
loads with all 5 buttons visible.

#### 6a. Provider initializes — debug log proof

Console line on first render:

```
[AllStak] Initialized — session 87168aa8-7b39-4db9-ac3b-61da9463aca8
```

Exactly one `Initialized` line per provider lifecycle (asserted in
`test/provider-integration.test.mjs`).

#### 6b. Manual `AllStak.captureException` from a button

Click "Manual captureException" → fetch interceptor recorded:

```json
{
  "url": "https://api.allstak.sa/ingest/v1/errors",
  "body": { "message": "manual button press", "exceptionClass": "Error", "level": "error" }
}
```

#### 6c. Manual `AllStak.captureMessage`

Click "Manual captureMessage" → recorded:

```json
{
  "url": "https://api.allstak.sa/ingest/v1/logs",
  "body": { "message": "button captured a message", "level": "info" }
}
```

#### 6d. Unhandled promise rejection

Click "Unhandled promise rejection" → recorded:

```json
{
  "url": "https://api.allstak.sa/ingest/v1/errors",
  "body": {
    "message": "unhandled-rejection from button",
    "metadata": { "source": "unhandledRejection" }
  }
}
```

#### 6e. Render-time error caught by `AllStakErrorBoundary`

Click "Trigger render-time error" → `<CrashingChild>` mounts and throws.
Observed:

- The fallback UI rendered: a pink screen with title **"Render error
  caught"**, message **"CrashingChild render error"**, and a **"Try again"**
  button. Screenshot captured during the verification run shows exactly
  that view.
- Wire payload to `/ingest/v1/errors` contains `message: "CrashingChild
  render error"` and `metadata.source: "AllStakProvider.ErrorBoundary"`.
- Console logs (in order):
  ```
  [AllStak] Captured render error: CrashingChild render error
  [sample] onError fired: CrashingChild render error (stack 10 frames)
  ```
  → `onError` callback received the error AND a 10-frame component stack.

#### 6f. `resetError()` recovers

Click "Try again" on the fallback → boundary cleared, children remounted
fresh, body text returned to the main 5-button view. No new error
captured (state in `AppRoot` reset because boundary unmounts the subtree
on catch). resetError works as advertised.

### 7. Debug log discipline

`debug: true` produces exactly two log lines per scenario:

- On first mount: `[AllStak] Initialized — session <uuid>`
- On second mount of the same provider (Fast Refresh / Strict Mode):
  `[AllStak] Reusing session <uuid>` (asserted in
  `test/provider-integration.test.mjs`)
- On render-error catch: `[AllStak] Captured render error: <msg>`

Not noisy. No spam during normal operation.

## What was NOT verified (honest list of remaining risks)

1. **Native crash capture (iOS Obj-C / Android Java).** The native modules
   under `native/` are still scaffolded. Verification requires Xcode and
   Android Studio with a physical device or simulator running a release
   build. Not done in this pass. Status unchanged from the original audit.

2. **`ErrorUtils.setGlobalHandler` path on a real RN runtime.** On Expo
   Web, `globalThis.ErrorUtils` is not defined, so the SDK's `if (eu)`
   check skips the install. The handler is verified by:
   - Unit test (`test/instrumentation.test.mjs:9`) that injects a fake
     `globalThis.ErrorUtils`, calls `installReactNative`, and verifies the
     captured handler ships through `captureException`.
   - Integration test (`test/provider-integration.test.mjs`) that does
     the same wrapped in `<AllStakProvider>`.
   - **Not verified:** the real `ErrorUtils` object that React Native's
     JS runtime actually exposes, on a real Hermes-enabled iOS or Android
     build. The button "Throw uncaught (ErrorUtils)" in the sample is the
     verification trigger — needs a simulator run.

3. **`promise/setimmediate/rejection-tracking` on Hermes.** On Web, the
   SDK falls back to `globalThis.addEventListener('unhandledrejection')`,
   which is what fired in 6d. The Hermes path uses the
   `promise/setimmediate/rejection-tracking` package require — covered
   by unit tests but not by a live Hermes run.

4. **`AppState`, `Platform.OS`, `Platform.Version`, `Linking` listeners.**
   These require `require('react-native')` at runtime. On Web, that
   require fails silently and the SDK's try/catch swallows it. Coverage
   exists in unit tests where these modules can be mocked. **Not
   verified:** real device tags appearing on captured events.

5. **Hermes architecture detection (`detectArchitecture`).** Globals like
   `__turboModuleProxy` and `RN$Bridgeless` are RN-internals not present
   on Web. Unit-tested in `test/architecture.test.mjs`; not live-verified.

6. **Source map upload / symbolication for Hermes bytecode.** Out of scope
   for this verification. README already calls this out as
   integration-untested in the source map section.

7. **Production endpoint connectivity.** All fetches in this run were
   intercepted by a mock that returned `200 {}`. The transport's retry
   buffer + flush behavior was not exercised against a real network or
   real `api.allstak.sa`.

## Files added / changed in this verification pass

- `src/provider.tsx` — added `destroyOnUnmount` prop, instance reuse
  guard, debug log differentiation between first mount and remount.
- `src/index.ts` — exports `__resetProviderInstanceForTest`.
- `test/provider.test.mjs` — 6 export-shape tests (already existed).
- `test/provider-runtime.test.mjs` — **NEW**, 9 lifecycle tests via
  `react-test-renderer`.
- `test/provider-integration.test.mjs` — **NEW**, 5 ErrorUtils +
  debug-logging tests.
- `samples/expo-test/` — **NEW**, minimal Expo TS app consuming the
  packed SDK tarball.
- `package.json` — added `react-test-renderer` as devDependency.

## Conclusion

The provider's React-lifecycle behavior is verified: it initializes once,
catches render errors, renders fallback, fires `onError`, ships the right
payload, and `resetError` recovers cleanly. Fast Refresh / remount no
longer destroys the singleton.

**The native-runtime-only paths (ErrorUtils, AppState, Platform tags,
Hermes rejection-tracking, native crash drain) remain unit-tested and
bundle-tested but not live-tested on iOS or Android.** Anyone claiming
"production-ready" needs to do a simulator pass before that claim is
honest.
