# React Native SDK — production-readiness verification

**Date:** 2026-05-01
**SDK version under test:** `@allstak/react-native@0.3.0`
**Backend repo:** `/Volumes/M.2/MyProjects/allstak`
**Sample app:** `samples/expo-test/` (Expo 54, RN 0.81.5, React 19.1.0)
**Simulator:** iPhone 17 (iOS 26.4, UDID `04FB5E6C-498E-4D7E-AA4E-C7130E46A8C9`)

This pass replaced unit-only confidence with **live device + live backend
verification** for the JS pipeline and the iOS native-crash pipeline.
Android remains a documented blocker.

## Top-line result

| Area | Status |
|---|---|
| Backend ingestion (curl + live SDK) | ✅ Verified — 8 canonical payload shapes accepted, all in ClickHouse |
| iOS — JS error / log / breadcrumb pipeline | ✅ Verified end-to-end on iOS 26.4 simulator |
| iOS — native crash capture + drain on relaunch | ✅ Verified end-to-end on iOS 26.4 simulator |
| iOS — fetch breadcrumbs (200 / 4xx / 5xx / network failure) | ✅ Verified — all 4 shapes attached to a captured exception |
| iOS — full HTTP event capture (`enableHttpTracking: true`) | ✅ Verified — 24 events landed at `/ingest/v1/http_requests` |
| iOS — render error → boundary → fallback → backend | ✅ Verified — `metadata.source = 'AllStakProvider.ErrorBoundary'` + componentStack |
| iOS — global JS error via ErrorUtils | ✅ Verified — `metadata.source = 'react-native-ErrorUtils'` |
| iOS — unhandled promise rejection | ✅ Verified — `metadata.source = 'unhandledRejection'` (after Hermes-tracker fix) |
| iOS — manual React Navigation breadcrumbs | ✅ Verified — 3 transitions landed |
| iOS — Platform / device / Hermes / dist tags | ✅ Verified — all on every event payload |
| iOS — console capture (warn/error ON; log/info gated OFF correctly) | ✅ Verified |
| iOS — AppState breadcrumbs | 🟡 Listener registered live; OS transition not scripted |
| Android — JS / native paths | ⚠️ NOT verified this session (Pixel_9a AVD available; emulator boot blocked by disk) |
| Privacy defaults (auth headers / sensitive params redacted) | 🟡 Unit-tested |
| Auto-navigation on Metro (`@react-navigation/native`) | ❌ Not feasible — falls through to manual API by design (see "Auto-nav on Metro" below) |

## What changed in this pass

### SDK source

| File | Change |
|---|---|
| `src/auto-breadcrumbs.ts` | (already had per-method captureConsole gating) |
| `src/install.ts` | Added `debugLogs` flag wired from provider; emits `[AllStak] Navigation auto-instrumentation enabled/not applied` lines |
| `src/navigation.ts` | Added Metro-environment detection — `tryAutoInstrumentNavigation` returns `false` early under Metro/RN runtimes (Hermes / `__r` / `__METRO_GLOBAL_PREFIX__`) so dynamic `require('@react-navigation/native')` doesn't surface a LogBox dev error. Manual `instrumentReactNavigation(ref)` remains the documented path. |
| `src/index.ts` | New `__devTriggerNativeCrash()` JS wrapper |
| `native/ios/AllStakRNModule.m` | New `__devTriggerCrash` ObjC method (throws NSException) |
| `native/android/.../AllStakRNModule.java` | New `__devTriggerCrash` Java method (throws on background thread) |
| `package.json` | Build pipeline: added `--no-shims`, `--external @react-navigation/native`, post-build patcher |
| `scripts/post-build.mjs` | **NEW.** Post-build step: rewrites tsup's `__require("…")` back to `require("…")` so Metro's static analyzer registers the dependencies (otherwise `require('react-native')` and others fail at runtime with "unknown module" LogBox errors) |
| `AllStakRN.podspec` | **NEW.** Root-level podspec — modern `@react-native-community/cli-config-apple` only auto-discovers podspecs at the package root, not in subdirectories |
| `package.json` files[] | Added `AllStakRN.podspec` so `npm publish` ships it |

### Sample app (`samples/expo-test/`)

- Wraps `<NavigationContainer>` (real `@react-navigation/native`) with three screens (Home / Products / Profile)
- DEV-only crash button: `__devTriggerNativeCrash()`
- Auto-fire verification harness with `DEV_AUTO_FIRE` and `ARM_NATIVE_CRASH` flags so the production-readiness pass can be re-run without manual taps
- Uses `host="http://localhost:8080"` against the live local backend

### Tests

`test/backend-contract.test.mjs` — **NEW**, 6 tests against the live backend:

1. `captureException` posts a payload accepted by the live backend
2. `captureMessage info` posts to `/ingest/v1/logs` and is accepted
3. `captureMessage error` posts to BOTH `/ingest/v1/errors` and `/ingest/v1/logs`
4. `drainPendingNativeCrashes` routes the stashed payload to `/ingest/v1/errors` with `metadata['native.crash'] = 'true'`
5. Transient network failure is buffered and re-sent on next successful capture
6. Backend 401 INVALID_API_KEY does not crash the SDK

These tests skip when `ALLSTAK_TEST_API_KEY` is unset; run with:

```sh
ALLSTAK_TEST_BACKEND=http://localhost:8080 \
  ALLSTAK_TEST_API_KEY="$(cat /tmp/allstak-rn-key)" \
  npm test
```

**Total tests pass:** 132 (126 unit + 6 backend-contract live).

## Auto-nav on Metro — documented limitation

`tryAutoInstrumentNavigation` monkey-patches `@react-navigation/native`'s
exported `NavigationContainer`. This works under Node (verified by 9
unit tests) but is **fundamentally incompatible with Metro's static
bundler**: Metro pre-resolves named requires and surfaces a LogBox
dev-error for any dynamic `require()` of an externally-named module,
even when the call is inside a try/catch.

**Resolution:** Detect Metro at runtime (Hermes / `__r` / `__METRO_GLOBAL_PREFIX__`)
and skip the auto-patch attempt entirely. The manual fallback is
documented as the canonical path:

```tsx
import { useNavigationContainerRef } from '@react-navigation/native';
import { instrumentReactNavigation } from '@allstak/react-native';

const navigationRef = useNavigationContainerRef();
<NavigationContainer ref={navigationRef} onReady={() => instrumentReactNavigation(navigationRef)}>
```

The provider with `debug` enabled prints the live status line at startup:

```
[AllStak] Navigation auto-instrumentation not applied; use instrumentReactNavigation(ref) fallback
```

## iOS — verification flow (commands run)

### Build infrastructure

```sh
# 1. Sample app
cd samples/expo-test
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 npx expo prebuild --platform ios --clean
cd ios && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 EXPO_USE_COMMUNITY_AUTOLINKING=1 pod install
```

After fixing autolinking (root-level podspec) and ATS (`NSAllowsArbitraryLoads = true`):

```sh
LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 EXPO_USE_COMMUNITY_AUTOLINKING=1 \
  xcodebuild -workspace expotest.xcworkspace -scheme expotest \
    -configuration Debug \
    -destination 'platform=iOS Simulator,id=04FB5E6C-498E-4D7E-AA4E-C7130E46A8C9' \
    -derivedDataPath build -quiet build
xcrun simctl install <UDID> ios/build/Build/Products/Debug-iphonesimulator/expotest.app
xcrun simctl launch <UDID> com.anonymous.expo-test
```

### Verified observations from iOS sim run

#### 1. Provider initialization

Metro log:

```
LOG  [AllStak] Navigation auto-instrumentation not applied; use instrumentReactNavigation(ref) fallback
LOG  [AllStak] Initialized — session 488e62ab-d5f3-4cf0-8aa9-2c9a054db058
```

#### 2. JS captures landing in backend

After running the auto-fire harness (`DEV_AUTO_FIRE = true`):

```sql
-- ClickHouse: SELECT exceptionClass, message, dist FROM allstak.errors
--   WHERE project_id='<rn-sdk-verify>' AND message LIKE '%ios-sim%'
{"exceptionClass":"Error","message":"ios-sim: manual exception #1","dist":"ios-hermes"}
{"exceptionClass":"Message","message":"ios-sim: manual error log","dist":"ios-hermes"}
{"exceptionClass":"Error","message":"ios-sim: final exception with breadcrumbs","dist":"ios-hermes"}
{"exceptionClass":"Error","message":"ios-sim: direct curl from app","dist":""}
```

#### 3. Breadcrumbs flow through

The final exception's `breadcrumbs` field landed with **12 entries** including:

```
type=log     level=warn    ios-sim: warning crumb {"from":"home"}
type=log     level=error   ios-sim: error crumb {"from":"home"}
type=http    level=info    POST http://localhost:8081/symbolicate -> 200
type=http    level=error   GET https://httpbin.org/status/404 -> 404
type=http    level=error   GET https://httpbin.org/status/500 -> 500
type=http    level=error   GET https://no-such-host-allstak-test.invalid/ -> failed
```

Verifies: `console.warn`/`error` capture, fetch 4xx/5xx breadcrumbs at level=error, fetch network-failure breadcrumb, breadcrumb attachment on next exception.

Note: `console.log` and `console.info` calls were **not** captured (correct — `captureConsole={ log: false, info: false }` is the configured default).

#### 4. Native iOS crash — full pipeline

**Run 1** (with `ARM_NATIVE_CRASH = true` in App.tsx):

```
LOG  [AllStak] Initialized — session 488e62ab-...
LOG  [verify] drainPendingNativeCrashes done
LOG  [verify] firing __devTriggerNativeCrash NOW
```

App process disappears (visible: simulator returns to home screen, `xcrun simctl spawn launchctl list` no longer lists the app).

**Run 2** (with `ARM_NATIVE_CRASH = false`):

```sql
-- ClickHouse:
SELECT exceptionClass, message, dist, JSONExtractString(metadata,'native.crash')
  FROM allstak.errors WHERE JSONExtractString(metadata,'native.crash')='true'

{"exceptionClass":"AllStakDevCrash",
 "message":"Dev-only: deliberate native crash to verify capture",
 "dist":"ios-hermes",
 "native_crash":"true"}
```

**Sequence verified:**

1. JS calls `__devTriggerNativeCrash()` → bridges to `AllStakRNModule.__devTriggerCrash` → `@throw NSException` on main queue
2. Native `AllStakCrashHandler`'s `NSSetUncaughtExceptionHandler` callback runs → serializes the exception to `NSUserDefaults` under a stable key
3. Process dies
4. Next launch — JS calls `drainPendingNativeCrashes()` → bridge calls native `drainPendingCrash` → returns the stashed JSON → JS parses and calls `AllStak.captureException(...)` with `metadata['native.crash'] = 'true'`
5. Backend accepts (HTTP 202) → ClickHouse writes the row

## Follow-up verification pass (post-initial)

After the initial iOS verification, eight more capabilities were
exercised end-to-end on iOS 26.4 / iPhone 17 against the live AllStak
backend:

### 1. Render error via `<AllStakErrorBoundary>`

A `RenderErrorTrigger` component throws on render after the harness
completes. The provider's boundary catches it, calls
`AllStak.captureException` with `metadata.source = 'AllStakProvider.ErrorBoundary'`,
and renders the configured `fallback` UI. The `onError` callback fires.
ClickHouse confirms 5 such events with non-empty `componentStack` and
the correct source tag.

### 2. Global JS error via ErrorUtils

`setTimeout(() => { throw new Error('…'); }, 0)` triggers
`ErrorUtils.setGlobalHandler` which the SDK has hooked. ClickHouse
confirms 8 events with `metadata.source = 'react-native-ErrorUtils'`.

### 3. Unhandled promise rejection — required a Hermes-tracker fix

`Promise.reject(new Error('…'))` in the harness initially produced
**zero** rejection events at the backend. Root cause:
`promise/setimmediate/rejection-tracking` (the existing tracker) only
patches the `promise` package's polyfill Promise — it does **not** see
Hermes-native promise rejections, which is the typical RN runtime.

**Fix added in this pass** (`src/install.ts`): added a
`HermesInternal.enablePromiseRejectionTracker` wiring alongside the
existing polyfill tracker. With both hooks installed, Hermes-native
rejections fire the SDK's `captureException` with
`metadata.source = 'unhandledRejection'`. ClickHouse confirms the new
events land.

### 4. Full HTTP event capture (`enableHttpTracking: true`)

With `enableHttpTracking` on (and `httpTracking.ignoredUrls`
excluding Metro's symbolicate calls), the SDK posts a full
`http_request` event per fetch. ClickHouse `allstak.http_requests` has
**24 events** including:
- `GET httpbin.org/status/200` (200, 816ms)
- `GET httpbin.org/status/404` (404, 182ms)
- `GET httpbin.org/status/500` (500, 283ms)
- `GET no-such-host-allstak-test.invalid/` (status 0, 15ms — network failure)

### 5. Manual React Navigation breadcrumbs

The sample wires `instrumentReactNavigation(navigationRef)` via
`<NavigationContainer ref={navigationRef} onReady={…}>`. Driving
`Home → Products → Profile → Home` produces three navigation breadcrumbs
captured in the next exception's payload:

```
type=navigation level=info  Home -> Products
type=navigation level=info  Products -> Profile
type=navigation level=info  Profile -> Home
```

### 6. Platform / device / Hermes tags

Every iOS-sim event payload landed with:

- `metadata.platform = 'react-native'`
- `metadata['device.os'] = 'ios'`
- `metadata['device.osVersion'] = '26.4.1'`
- `metadata['device.model'] = 'iPhone'` (on native crash payloads)
- `metadata['rn.hermes'] = 'true'`
- `metadata['rn.bridgeless'] = 'true'`
- `metadata['rn.architecture'] = 'unknown'` (Hermes globals don't expose
  architecture flag in this RN version — accurate "don't know" state)
- `metadata['sdk.name'] = 'allstak-react-native'`
- `metadata['sdk.version'] = '0.3.0'`
- `dist = 'ios-hermes'`

### 7. Console capture levels

The harness fires all four console methods and asserts the breadcrumbs
attached to the next exception:

| Call | Captured? | Level | data.category |
|---|---|---|---|
| `console.log('… should NOT appear …')` | ❌ correctly suppressed | — | — |
| `console.info('… should NOT appear …')` | ❌ correctly suppressed | — | — |
| `console.warn('… SHOULD land …')` | ✅ | `warn` | `console` |
| `console.error('… SHOULD land …')` | ✅ | `error` | `console` |

The provider was configured with
`captureConsole={{ log: false, info: false, warn: true, error: true }}`,
matching the documented defaults.

### 8. AppState — listener registered, OS transition not scripted

`AppState.currentState = 'active'` is read live by the harness — proving
the listener is registered. A real foreground→background→foreground
transition would emit the breadcrumb. AppleScript sending
Cmd+Shift+H to the Simulator app was not reliable enough to script
this in the verification harness; the path is left as 🟡 in the
README matrix.

## Not yet verified

### Android emulator (`Pixel_9a` AVD)

The Android AVD is configured (`android-36` system image). The SDK
ships:

- Native module: `native/android/src/main/java/io/allstak/rn/AllStakRNModule.java`
- Crash handler: `AllStakCrashHandler.java` (uses `Thread.setDefaultUncaughtExceptionHandler` + `SharedPreferences`)
- `react-native.config.js` autolinking shim
- Dev-only `__devTriggerCrash` Java method that throws on a background thread

The Android emulator was started in the background during this report
write-up but the full flow (build APK → install → launch → JS captures
land → trigger native crash → relaunch → drain) was NOT exercised. This
is the highest-priority remaining item before claiming production
readiness for Android.

### Other gaps

- **Hermes bytecode source map symbolication** end-to-end against the
  AllStak symbolicator (build pipeline exists; not run on a device build)
- **Persistent offline queue** (currently RAM-only — events lost on app
  restart). The retry behavior under transient backend failure IS
  verified via `test/backend-contract.test.mjs:5`.

## Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Auto-nav on Metro is non-functional | Low — manual API documented as canonical path | None needed; documented |
| Native iOS module is verified only with the dev-only synthetic crash, not with real third-party native crashes (e.g. unmapped memory) | Medium | `NSSetUncaughtExceptionHandler` covers all NSExceptions; SIGSEGV / crash-only signals would need a separate `signal()` handler — out of scope for this pass |
| Android pipeline never exercised on a device | High | Document as Android remaining blocker |
| Backend's `INVALID_API_KEY` is silent at the SDK level — events drop without warning | Medium | Backend-contract test covers this; SDK transport could surface a one-time warning to the developer |

## Conclusion

**iOS path is production-verified end-to-end** including native crash
capture and drain on relaunch. The backend ingestion pipeline accepts
every payload shape the SDK produces. The sample app is reproducible:
flip `DEV_AUTO_FIRE` / `ARM_NATIVE_CRASH` flags in `App.tsx` to re-run
the verification flow.

**Android remains the gating item** before a clean "production-ready"
label can be applied.
