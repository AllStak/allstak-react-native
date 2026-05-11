# @allstak/react-native

AllStak's React Native SDK captures JS errors, render errors, unhandled promises, logs, HTTP breadcrumbs/events, navigation breadcrumbs, device tags, and source maps from React Native apps.

Use one wrapper, keep privacy-first defaults, support Hermes, and upload React Native source maps through build hooks instead of manual release chores.

[![npm version](https://img.shields.io/npm/v/@allstak/react-native.svg)](https://www.npmjs.com/package/@allstak/react-native)
[![CI](https://github.com/allstak-io/allstak-react-native/actions/workflows/ci.yml/badge.svg)](https://github.com/allstak-io/allstak-react-native/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## 1. Overview

Use `@allstak/react-native` when you want production mobile error context without wiring several separate tools: a provider-first setup, automatic JS/runtime capture, privacy-safe breadcrumbs, Hermes-aware tags, and source-map upload through EAS, Gradle, Xcode, or custom CI build hooks.

## 2. Installation

```bash
npm install @allstak/react-native
```

Peer expectations:

| Peer | Supported |
| --- | --- |
| React | `>=16.8.0` |
| React Native | `>=0.70` |
| Expo | Supported in Expo apps. Expo Go can use the JS SDK paths; native crash capture requires native modules in a dev client or native build. |

The published package is standalone: no browser DOM, Node runtime, or `@allstak/js` dependency is required.

## 3. Quick Start — Provider-first

Provider-first setup is the recommended path.

```tsx
import { AllStakProvider } from "@allstak/react-native";

export default function App() {
  return (
    <AllStakProvider
      apiKey="ask_live_..."
      environment="production"
      release="mobile@1.0.0+1"
      dist="ios-hermes"
      debug
    >
      <AppRoot />
    </AllStakProvider>
  );
}
```

`AllStakProvider` automatically:

- initializes the SDK
- installs React Native integrations
- wraps children with an error boundary
- captures render errors
- captures global JS errors through `ErrorUtils`
- captures unhandled promise rejections, including Hermes-native promise rejections
- attaches platform, device, architecture, Hermes, release, dist, and environment tags
- installs console, HTTP, XHR, fetch, and AppState breadcrumbs according to config
- attempts navigation auto-instrumentation when possible

Navigation note: Metro/React Native static bundling currently prevents the SDK from guaranteeing automatic React Navigation patching in normal native Metro builds. The provider logs the status when `debug` is enabled. Use `instrumentReactNavigation(navigationRef)` when you need guaranteed navigation breadcrumbs.

## 4. Verify It Works

Add a temporary test button or run these snippets after the provider has mounted:

```tsx
import { AllStak } from "@allstak/react-native";

AllStak.captureException(new Error("AllStak test error"));
AllStak.captureMessage("AllStak test log");
console.warn("AllStak warning breadcrumb");
Promise.reject(new Error("AllStak unhandled rejection test"));
```

Expected result:

- with `debug`, Metro shows `[AllStak] Initialized — session <id>`
- the manual error appears in the AllStak dashboard
- the message appears as a log event
- the warning is attached as a breadcrumb to the next captured error
- the unhandled rejection is captured with `metadata.source = "unhandledRejection"`

## 5. Automatic Capture Matrix

| Feature | Default | Config | Status | Notes |
| --- | --- | --- | --- | --- |
| Render errors | On with provider | `fallback`, `onError`; manual setup skips the boundary | Verified on iOS simulator | Captured with `metadata.source = "AllStakProvider.ErrorBoundary"` and component stack. |
| Global JS errors | On | `autoErrorHandler` | Verified on iOS simulator; unit-tested elsewhere | Uses `ErrorUtils.setGlobalHandler`. |
| Unhandled promises | On | `autoPromiseRejections` | Verified on iOS simulator | Uses Hermes rejection tracker plus polyfill/browser fallbacks. |
| Manual `captureException` | Manual | `AllStak.captureException(error)` | Verified on iOS simulator and backend contract tests | Posts to `/ingest/v1/errors`. |
| Manual `captureMessage` | Manual | `AllStak.captureMessage(message, level?)` | Verified on iOS simulator and backend contract tests | Info/warn go to logs; error/fatal also create error events. |
| `console.warn` / `console.error` | On | `autoConsoleBreadcrumbs`, `captureConsole` | Verified on iOS simulator | Breadcrumbs only; original console methods still run. |
| `console.log` / `console.info` | Off | `captureConsole={{ log: true, info: true }}` | Verified on iOS simulator | Opt-in only to avoid noisy dashboards. |
| Fetch breadcrumbs | On | `autoFetchBreadcrumbs` | Verified on iOS simulator | Query strings are stripped from breadcrumb URLs. |
| XHR breadcrumbs | On | `autoNetworkCapture` | Unit-tested; RN fetch is XHR-based in many setups | Skips AllStak ingest host to avoid recursion. |
| HTTP 4xx/5xx | On for breadcrumbs | `autoFetchBreadcrumbs`, `autoNetworkCapture` | Verified on iOS simulator | Error-level breadcrumb for status `>=400`. |
| Network failures | On for breadcrumbs | `autoFetchBreadcrumbs`, `autoNetworkCapture` | Verified on iOS simulator | Records failed request breadcrumb and rethrows original error. |
| Full HTTP request events | Off | `enableHttpTracking`, `httpTracking` | Verified on iOS simulator | Posts to `/ingest/v1/http_requests`; headers/bodies off by default. |
| AppState breadcrumbs | On | `autoAppStateBreadcrumbs` | Listener verified; OS transitions not fully scripted | Foreground/background transition testing is environment-dependent. |
| Navigation breadcrumbs | Best effort automatic, manual fallback guaranteed | `autoNavigationBreadcrumbs`, `instrumentReactNavigation(ref)` | Manual path verified on iOS simulator; auto path unit-tested under Node; Metro native auto-patch intentionally falls back | Use manual ref instrumentation for guaranteed React Navigation breadcrumbs. |
| Device/platform tags | On | `autoDeviceTags` | Verified on iOS simulator | Adds `device.os`, `device.osVersion`, `device.model` where available. |
| Hermes detection | On | automatic | Verified on iOS simulator | Adds `rn.hermes` and selects `ios-hermes` / `android-hermes` dist when possible. |
| Release/dist/environment tags | Environment defaults to `production`; release is caller-supplied; dist auto-detected unless overridden | `environment`, `release`, `dist` | Verified on iOS simulator | `release` and `dist` must match uploaded source maps for symbolication. |
| Native iOS crashes | Manual drain API; native module must be linked | `drainPendingNativeCrashes(release?)` | Verified on iOS simulator | Crash is stored by native handler and sent on next launch. Provider does not call this automatically. |
| Native Android crashes | Manual drain API; native module must be linked | `drainPendingNativeCrashes(release?)` | Implemented, not emulator/device verified | Android native module and dev crash trigger exist; emulator verification was blocked by disk in latest report. |
| Offline queue | On, in-memory only | transport internal | Backend-contract verified | Buffered retry works while process lives; events are lost after app restart. |
| Source maps | Build-time hook | EAS, Gradle, Xcode, or custom CI hooks | Build hooks implemented; backend upload path exists | Hooks inject `debugId` and upload maps. End-to-end Hermes symbolication still depends on matching release/dist/debugId. |

## 6. Configuration Reference

`AllStakProvider` accepts the SDK config and React Native integration flags:

| Prop | Type | Default | Notes |
| --- | --- | --- | --- |
| `apiKey` | `string` | required | Runtime project API key such as `ask_live_...`. Not the source-map upload token. |
| `environment` | `string` | `"production"` | Attached to errors, logs, spans, and HTTP events. |
| `release` | `string` | unset | App release, for example `mobile@1.2.3+45`. Required for source-map matching. |
| `dist` | `string` | auto-detected | Override build flavor, for example `android-hermes`. |
| `debug` | `boolean` | `false` | Prints SDK init and selected integration status logs. |
| `fallback` | `ReactNode` or function | `null` on render error | Error boundary fallback UI. |
| `onError` | function | unset | Called after render error capture. |
| `destroyOnUnmount` | `boolean` | `false` | Keep `false` for app roots, Fast Refresh, and Strict Mode. |
| `captureConsole` | object | `{ warn: true, error: true, log: false, info: false }` | Per-method console breadcrumb flags. |
| `autoConsoleBreadcrumbs` | `boolean` | `true` | Kill switch for console wrapping. |
| `autoFetchBreadcrumbs` | `boolean` | `true` | Wraps `fetch` for HTTP breadcrumbs. |
| `autoNetworkCapture` | `boolean` | `true` | Wraps `XMLHttpRequest` for network breadcrumbs. |
| `enableHttpTracking` | `boolean` | `false` | Enables full HTTP request events. |
| `httpTracking` | `HttpTrackingOptions` | privacy-first defaults | Controls body/header capture, redaction, ignore lists, and byte limits. |
| `autoAppStateBreadcrumbs` | `boolean` | `true` | Captures AppState changes as breadcrumbs. |
| `autoDeviceTags` | `boolean` | `true` | Captures platform/device tags. |
| `autoNavigationBreadcrumbs` | `boolean` | `true` | Best-effort auto navigation patch; manual fallback is recommended for Metro-native builds. |

Common optional props also supported by the underlying client include `host`, `user`, `tags`, `sampleRate`, `beforeSend`, `tracesSampleRate`, `service`, and `replay`.

```tsx
<AllStakProvider
  apiKey="ask_live_..."
  environment="production"
  release="mobile@1.2.3+45"
  dist="android-hermes"
  captureConsole={{ log: true, info: true }}
  enableHttpTracking
>
  <AppRoot />
</AllStakProvider>
```

HTTP tracking defaults are intentionally conservative. Request bodies, response bodies, and headers are not captured unless explicitly enabled. Sensitive headers and query parameters are still redacted even when header/body capture is enabled.

## 7. Manual / Advanced API

```ts
import {
  AllStak,
  instrumentReactNavigation,
  drainPendingNativeCrashes,
} from "@allstak/react-native";

AllStak.captureException(error);
AllStak.captureMessage("message");
AllStak.addBreadcrumb("ui", "Tapped checkout", "info", { screen: "Checkout" });
AllStak.setUser({ id: "user_123", email: "user@example.com" });
AllStak.setTag("key", "value");
AllStak.setContext("device", { model: "simulator" });
await AllStak.flush();
AllStak.destroy();
```

Other advanced APIs include `setTags`, `setExtra`, `setExtras`, `setLevel`, `setFingerprint`, `withScope`, tracing helpers, `getReplay`, and manual `instrumentAxios`.

Manual setup is available when you need full initialization control:

```ts
import { AllStak, installReactNative } from "@allstak/react-native";

AllStak.init({
  apiKey: "ask_live_...",
  environment: "production",
  release: "mobile@1.2.3+45",
});

installReactNative();
```

Manual navigation fallback:

```tsx
import { NavigationContainer, useNavigationContainerRef } from "@react-navigation/native";
import { instrumentReactNavigation } from "@allstak/react-native";

export function AppNavigation() {
  const navigationRef = useNavigationContainerRef();

  return (
    <NavigationContainer
      ref={navigationRef}
      onReady={() => instrumentReactNavigation(navigationRef)}
    >
      {/* navigators */}
    </NavigationContainer>
  );
}
```

Auto navigation works only where the SDK can safely patch `@react-navigation/native`. In normal Metro-native builds, manual ref instrumentation is the guaranteed path.

## 8. Source Maps — automatic via build hooks

React Native source maps become hands-off after adding one build hook for your build system. The hook injects a `debugId` into both the JS bundle and source map, then uploads the map to AllStak.

### EAS / Expo

Add the AllStak config plugin to your `app.json` (or `app.config.js`):

```json
{
  "expo": {
    "plugins": ["@allstak/react-native"]
  }
}
```

Then add the EAS post-build hook:

```json
{
  "scripts": {
    "eas-build-on-success": "node ./node_modules/@allstak/react-native/build-hooks/eas-post-bundle.js"
  }
}
```

Required environment:

- `ALLSTAK_UPLOAD_TOKEN`
- `ALLSTAK_RELEASE`
- `ALLSTAK_API_URL` optional, defaults to AllStak production API

`ALLSTAK_UPLOAD_TOKEN` is a project-scoped upload token from Project Settings. It is not the runtime `apiKey`.

### Android Gradle

Add this to `android/app/build.gradle` after the React Native Gradle plugin setup:

```groovy
apply from: "../../node_modules/@allstak/react-native/build-hooks/allstak-sourcemaps.gradle"
```

Supported Gradle properties / environment:

- `ALLSTAK_UPLOAD_TOKEN` or `allstakUploadToken`
- `ALLSTAK_RELEASE` or `allstakRelease`
- optional API URL override when self-hosting

Then run your normal release task, for example:

```bash
cd android
./gradlew :app:bundleRelease
```

### iOS Xcode Build Phase

Add a Run Script build phase after "Bundle React Native code and images":

```sh
"${SRCROOT}/../node_modules/@allstak/react-native/build-hooks/xcode-build-phase.sh"
```

Set these in the build phase, `.xcconfig`, or CI shell:

```sh
ALLSTAK_UPLOAD_TOKEN=aspk_...
ALLSTAK_RELEASE=mobile@1.2.3+45
```

The script is designed for release builds; debug builds should not upload source maps.

### Custom CI

```bash
node ./node_modules/@allstak/react-native/build-hooks/upload-sourcemaps.js \
  --platform ios \
  --bundle path/to/main.jsbundle \
  --sourcemap path/to/main.jsbundle.map \
  --release mobile@1.2.3+45 \
  --dist ios-hermes
```

Programmatic API:

```js
const { uploadReactNativeSourcemap } = require("@allstak/react-native/sourcemaps");

await uploadReactNativeSourcemap({
  platform: "ios",
  bundle: "path/to/main.jsbundle",
  sourcemap: "path/to/main.jsbundle.map",
  release: "mobile@1.2.3+45",
  dist: "ios-hermes",
  token: process.env.ALLSTAK_UPLOAD_TOKEN,
});
```

How matching works:

- `debugId` is injected into the bundle and the source map.
- The backend matches stack frames using `debugId`, `release`, and `dist`.
- Maps are uploaded to `/api/v1/artifacts/upload`.
- Upload auth uses `X-AllStak-Upload-Token`; do not use the runtime `ask_live_...` API key.

If no upload token is present, the hook can run in inject-only mode so CI can still produce bundles with debug IDs without uploading artifacts.

## 9. Native Crashes

JS errors are verified. Native crash files exist for iOS and Android, and the SDK exports a drain API:

```ts
import { drainPendingNativeCrashes } from "@allstak/react-native";

await drainPendingNativeCrashes("mobile@1.2.3+45");
```

The provider does not call `drainPendingNativeCrashes()` automatically. Call it once early after SDK initialization, before user flows start:

```tsx
import { AllStakProvider, drainPendingNativeCrashes } from "@allstak/react-native";
import { useEffect } from "react";

function AppRoot() {
  useEffect(() => {
    drainPendingNativeCrashes("mobile@1.2.3+45");
  }, []);

  return <Routes />;
}
```

Current verification status:

- iOS native crash capture and drain were verified end-to-end on an iOS simulator.
- Android native crash capture code exists and has parity with iOS, but emulator/device verification was not completed in the latest report.
- Do not mark Android native crash capture production-ready until an Android emulator or device run proves crash -> relaunch -> drain -> backend ingest.

Native modules are not available in Expo Go. Use a dev client or native build for native crash verification.

## 10. Privacy Defaults

- Headers are off by default.
- Request bodies are off by default.
- Response bodies are off by default.
- `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, `X-Auth-Token`, and `Proxy-Authorization` are always redacted.
- Sensitive query parameters such as `token`, `password`, `api_key`, `authorization`, `secret`, `access_token`, `refresh_token`, and `jwt` are redacted.
- `console.log` and `console.info` are off by default.
- `console.warn` and `console.error` are captured as breadcrumbs by default.
- Source maps containing `sourcesContent` may be rejected when organization privacy mode requires stripped sources. Use `stripSources: true` or configure your build hook accordingly.

## 11. Troubleshooting

### Events not appearing

- Confirm `apiKey` is the runtime project key and starts with `ask_live_...`.
- Enable `debug` and check for `[AllStak] Initialized — session <id>`.
- Confirm the app can reach `https://api.allstak.sa`.
- For self-hosted installs, pass `host="https://your-api.example.com"`.
- Check the project/environment you are viewing in the dashboard.

### Wrong `apiKey`

Runtime ingestion uses the project API key. Source-map upload uses `ALLSTAK_UPLOAD_TOKEN`. They are different credentials and are not interchangeable.

### Upload token vs runtime API key confusion

- `apiKey="ask_live_..."`: ships runtime errors/logs/breadcrumbs.
- `ALLSTAK_UPLOAD_TOKEN=aspk_...`: uploads source maps and artifacts in CI.
- Never put the upload token in app code.

### Source maps uploaded but stack is not symbolicated

- Ensure the runtime `release` matches `ALLSTAK_RELEASE`.
- Ensure runtime `dist` matches the uploaded map's `dist`.
- Confirm the event contains a matching `debugId` or release/dist combination.
- Confirm the map was uploaded to the same project as the runtime API key.

### Release/dist mismatch

Use stable release names such as `mobile@1.2.3+45` and platform dists such as `ios-hermes`, `android-hermes`, `ios-jsc`, or `android-jsc`. Mismatched values prevent backend joining between event and source map.

### Hermes stacks not resolving

Hermes stack traces need the correct Metro/Hermes source-map chain. Use the provided build hooks instead of uploading a random map file from an intermediate build step.

### Navigation breadcrumbs not appearing

- In Metro-native builds, use `instrumentReactNavigation(navigationRef)`.
- Confirm `NavigationContainer` has mounted and `onReady` fires.
- Avoid deep imports that bypass `@react-navigation/native`.
- Enable `debug` to see whether auto navigation instrumentation was applied or skipped.

### Metro / Expo issues

- Rebuild after adding native modules or source-map hooks.
- Expo Go cannot load custom native crash modules.
- For native crash testing, use an Expo dev client, simulator build, or physical device build.

### Android Gradle hook not running

- Confirm the `apply from` path is relative to `android/app/build.gradle`.
- Confirm `ALLSTAK_RELEASE` and `ALLSTAK_UPLOAD_TOKEN` are visible to Gradle.
- Run with `--info` to verify the AllStak source-map task executes.

### Xcode build phase path wrong

- The recommended path is `"${SRCROOT}/../node_modules/@allstak/react-native/build-hooks/xcode-build-phase.sh"`.
- Place the phase after React Native bundles JS.
- Confirm the script has executable permissions after install.

### AppState breadcrumbs not easy to test

The listener registers at startup, but actual foreground/background transitions depend on simulator/device behavior. Verify by backgrounding and foregrounding the app, then capturing an error so breadcrumbs attach.

### Docker/backend local issue is not an SDK issue

If local backend testing returns `401 INVALID_API_KEY` or nothing reaches ClickHouse, verify the API key exists in the same database used by the running backend. The latest backend verification report found that using the wrong local Postgres instance caused false SDK failures.

## 12. Verification Status

Latest verification reports are in `docs/reports/`:

- `react-native-provider-verification.md`
- `react-native-backend-ingestion-verification.md`
- `react-native-production-readiness.md`
- `console-and-navigation-auto.md`

Current status from those reports:

| Area | Status |
| --- | --- |
| Unit tests | Latest production-readiness report: 132 passing total, including 126 unit tests and 6 live backend-contract tests. Earlier provider report recorded 98/98 before later additions. |
| iOS simulator verified paths | Provider init, render errors, global JS errors, unhandled promises, manual exception/message, console warn/error defaults, console log/info opt-in behavior, fetch breadcrumbs, HTTP 4xx/5xx/network failure, full HTTP request events, device/platform/Hermes/dist tags, manual React Navigation breadcrumbs, iOS native crash drain. |
| Android emulator verified paths | Not completed in latest production-readiness pass; emulator boot was blocked by disk. Android native crash and JS paths remain implemented but not device-verified. |
| Backend ingestion verified paths | `/ingest/v1/errors`, `/ingest/v1/logs`, `/ingest/v1/http_requests`; 8 canonical curl payload shapes accepted; live SDK events landed in ClickHouse; backend-contract tests cover buffering and invalid-key resilience. |
| Source-map backend status | `/api/v1/artifacts/upload` upload path exists and build hooks inject/upload debug-ID source maps. Full Hermes symbolication remains dependent on matching release/dist/debugId and should be validated per app release pipeline. |
| Remaining gaps | Android device/emulator verification, persistent offline queue, full AppState transition verification, and per-project source-map symbolication verification in release CI. |

## Links

- Dashboard: https://app.allstak.sa
- Documentation: https://docs.allstak.sa
- Source: https://github.com/allstak-io/allstak-react-native

## License

MIT © AllStak
