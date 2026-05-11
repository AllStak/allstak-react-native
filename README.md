# @allstak/react-native

Error tracking, native crash capture, source maps, and performance monitoring for React Native and Expo apps.

[![npm version](https://img.shields.io/npm/v/@allstak/react-native.svg)](https://www.npmjs.com/package/@allstak/react-native)
[![CI](https://github.com/allstak-io/allstak-react-native/actions/workflows/ci.yml/badge.svg)](https://github.com/allstak-io/allstak-react-native/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![React Native](https://img.shields.io/badge/React%20Native-%3E%3D0.70-blue)](https://reactnative.dev)
[![Expo](https://img.shields.io/badge/Expo-supported-blueviolet)](https://expo.dev)

```bash
npm install @allstak/react-native
```

```tsx
import { AllStakProvider } from "@allstak/react-native";

export default function App() {
  return (
    <AllStakProvider apiKey="ask_live_..." environment="production">
      <AppRoot />
    </AllStakProvider>
  );
}
```

## Features

- **Provider-first setup** -- one wrapper initializes the SDK, installs integrations, and wraps children with an error boundary.
- **Hermes-aware** -- detects Hermes, selects the correct dist (`ios-hermes`, `android-hermes`), and handles Hermes-native promise rejections.
- **Expo support** -- works in Expo dev clients and native builds. JS paths work in Expo Go; native crash capture requires a native build.
- **Automatic capture** -- JS errors, render errors, unhandled promises, console breadcrumbs, HTTP breadcrumbs, AppState transitions, and device/platform tags.
- **Navigation tracking** -- automatic best-effort patching plus a guaranteed manual ref-based API for React Navigation.
- **Native crash capture** -- iOS and Android native crash handlers store crashes on disk and drain them on next launch.
- **Source maps** -- build hooks for EAS, Gradle, and Xcode inject `debugId` and upload maps automatically.
- **Privacy-first defaults** -- headers, request/response bodies, and sensitive parameters are off or redacted by default.

## Quickstart

### 1. Install

```bash
npm install @allstak/react-native
```

Peer requirements: React >= 16.8.0, React Native >= 0.70. The package is standalone with no dependency on `@allstak/js`.

### 2. Wrap your app

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

### 3. Verify

```tsx
import { AllStak } from "@allstak/react-native";

AllStak.captureException(new Error("AllStak test error"));
```

With `debug` enabled, Metro logs `[AllStak] Initialized -- session <id>` and the error appears in your [AllStak dashboard](https://app.allstak.sa).

## Navigation Instrumentation

Auto-instrumentation is attempted by default. For guaranteed React Navigation breadcrumbs in Metro-native builds, use the manual ref API:

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

## Native Crashes

The SDK includes native crash handlers for iOS and Android. Crashes are stored on disk by the native handler and sent to AllStak on the next app launch via the drain API:

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

The provider does not call `drainPendingNativeCrashes()` automatically. Call it once early after initialization, before user flows start. Native modules are not available in Expo Go -- use a dev client or native build.

## Source Maps

Build hooks inject a `debugId` into both the JS bundle and source map, then upload the map to AllStak. Configure one hook for your build system and source maps become hands-off.

All hooks require `ALLSTAK_UPLOAD_TOKEN` (a project-scoped upload token from Project Settings, not the runtime `apiKey`) and `ALLSTAK_RELEASE`.

### EAS / Expo

Add the config plugin to `app.json`:

```json
{
  "expo": {
    "plugins": ["@allstak/react-native"]
  }
}
```

Add the post-build hook to `package.json`:

```json
{
  "scripts": {
    "eas-build-on-success": "node ./node_modules/@allstak/react-native/build-hooks/eas-post-bundle.js"
  }
}
```

### Android Gradle

Add to `android/app/build.gradle` after the React Native Gradle plugin:

```groovy
apply from: "../../node_modules/@allstak/react-native/build-hooks/allstak-sourcemaps.gradle"
```

### iOS Xcode

Add a Run Script build phase after "Bundle React Native code and images":

```sh
"${SRCROOT}/../node_modules/@allstak/react-native/build-hooks/xcode-build-phase.sh"
```

Set `ALLSTAK_UPLOAD_TOKEN` and `ALLSTAK_RELEASE` in the build phase, `.xcconfig`, or CI environment.

### Custom CI

```bash
node ./node_modules/@allstak/react-native/build-hooks/upload-sourcemaps.js \
  --platform ios \
  --bundle path/to/main.jsbundle \
  --sourcemap path/to/main.jsbundle.map \
  --release mobile@1.2.3+45 \
  --dist ios-hermes
```

The backend matches stack frames using `debugId`, `release`, and `dist`. Maps upload to `/api/v1/artifacts/upload` using the `X-AllStak-Upload-Token` header.

## Privacy

- Headers, request bodies, and response bodies are off by default.
- `Authorization`, `Cookie`, `Set-Cookie`, `X-API-Key`, `X-Auth-Token`, and `Proxy-Authorization` are always redacted.
- Sensitive query parameters (`token`, `password`, `api_key`, `secret`, `access_token`, `refresh_token`, `jwt`) are redacted.
- `console.log` and `console.info` breadcrumbs are off by default; `console.warn` and `console.error` are on.

## Configuration

| Prop | Type | Default | Description |
| --- | --- | --- | --- |
| `apiKey` | `string` | required | Runtime project key (`ask_live_...`). |
| `environment` | `string` | `"production"` | Attached to all events. |
| `release` | `string` | -- | App release identifier, e.g. `mobile@1.2.3+45`. Required for source-map matching. |
| `dist` | `string` | auto-detected | Build flavor override, e.g. `android-hermes`. |
| `debug` | `boolean` | `false` | Prints SDK init and integration status logs. |
| `fallback` | `ReactNode` | `null` | Error boundary fallback UI. |
| `onError` | `function` | -- | Called after render error capture. |
| `captureConsole` | `object` | `{ warn: true, error: true, log: false, info: false }` | Per-method console breadcrumb flags. |
| `autoFetchBreadcrumbs` | `boolean` | `true` | Wraps `fetch` for HTTP breadcrumbs. |
| `autoNetworkCapture` | `boolean` | `true` | Wraps `XMLHttpRequest` for network breadcrumbs. |
| `enableHttpTracking` | `boolean` | `false` | Full HTTP request events to `/ingest/v1/http_requests`. |
| `autoAppStateBreadcrumbs` | `boolean` | `true` | Captures foreground/background transitions. |
| `autoNavigationBreadcrumbs` | `boolean` | `true` | Best-effort auto navigation; use manual ref for guaranteed coverage. |
| `autoDeviceTags` | `boolean` | `true` | Adds `device.os`, `device.model`, and Hermes tags. |

Additional props: `host`, `user`, `tags`, `sampleRate`, `beforeSend`, `tracesSampleRate`, `service`.

## API Reference

```ts
import { AllStak, instrumentReactNavigation, drainPendingNativeCrashes } from "@allstak/react-native";

AllStak.captureException(error);
AllStak.captureMessage("message", "warning");
AllStak.addBreadcrumb("ui", "Tapped checkout", "info", { screen: "Cart" });
AllStak.setUser({ id: "user_123", email: "user@example.com" });
AllStak.setTag("key", "value");
AllStak.setContext("device", { model: "iPhone 15" });
await AllStak.flush();
```

For manual initialization without the provider:

```ts
import { AllStak, installReactNative } from "@allstak/react-native";

AllStak.init({ apiKey: "ask_live_...", environment: "production", release: "mobile@1.2.3+45" });
installReactNative();
```

## Troubleshooting

**Events not appearing** -- Confirm `apiKey` starts with `ask_live_...`, enable `debug`, and verify the app can reach `https://api.allstak.sa`. Check that the correct project and environment are selected in the dashboard.

**Source maps not resolving** -- The runtime `release` and `dist` must match the values used during source-map upload. Confirm the event contains a matching `debugId`. Use the provided build hooks rather than uploading intermediate build artifacts.

**Upload token vs API key** -- `apiKey` (`ask_live_...`) ships runtime events. `ALLSTAK_UPLOAD_TOKEN` (`aspk_...`) uploads source maps. They are separate credentials; never put the upload token in app code.

**Navigation breadcrumbs missing** -- Use `instrumentReactNavigation(navigationRef)` in Metro-native builds. Confirm `NavigationContainer` has mounted and `onReady` fires.

**Expo Go limitations** -- Native crash modules are not available in Expo Go. Use a dev client or native build for native crash capture.

## Links

- Dashboard: [app.allstak.sa](https://app.allstak.sa)
- Documentation: [docs.allstak.sa](https://docs.allstak.sa)
- Source: [github.com/allstak-io/allstak-react-native](https://github.com/allstak-io/allstak-react-native)

## License

MIT -- AllStak
