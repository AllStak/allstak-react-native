# @allstak/react-native

**Native crash + JS error capture for React Native. iOS and Android auto-wired.**

[![npm version](https://img.shields.io/npm/v/@allstak/react-native.svg)](https://www.npmjs.com/package/@allstak/react-native)
[![CI](https://github.com/allstak-io/allstak-react-native/actions/workflows/ci.yml/badge.svg)](https://github.com/allstak-io/allstak-react-native/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

Official AllStak SDK for React Native — hooks `ErrorUtils`, Hermes rejection tracking, and native crash capture on iOS and Android.

## Dashboard

View captured events live at [app.allstak.sa](https://app.allstak.sa).

![AllStak dashboard](https://app.allstak.sa/images/dashboard-preview.png)

## Features

- `ErrorUtils.setGlobalHandler` integration for JS crash capture
- Hermes unhandled promise rejection tracking
- `Platform.OS` / `Platform.Version` auto-tags on every event
- Native layers (Obj-C/Swift, Java/Kotlin) ship under `native/` for fatal crash capture
- Breadcrumbs and user/tag context via the shared core API
- Works with RN 0.70+

## What You Get

Once integrated, every event flows to your AllStak dashboard:

- **JS errors** — stack traces, component names, Hermes rejections
- **Native crashes** — iOS (Obj-C/Swift) and Android (Java/Kotlin) fatals
- **Logs** — structured logs with search and filters
- **HTTP** — outbound request timing, status codes, failed calls
- **Device tags** — `Platform.OS`, `Platform.Version`, release channel
- **Alerts** — email and webhook notifications on regressions

## Installation

```bash
npm install @allstak/react-native
```

## Quick Start

> Create a project at [app.allstak.sa](https://app.allstak.sa) to get your API key.

```ts
import { installReactNative, AllStak } from '@allstak/react-native';

installReactNative({
  apiKey: process.env.ALLSTAK_API_KEY!,
  environment: 'production',
  release: 'mobile@1.0.0',
});

AllStak.captureException(new Error('test: hello from allstak-react-native'));
```

Run the app — the test error appears in your dashboard within seconds.

## Get Your API Key

1. Sign up at [app.allstak.sa](https://app.allstak.sa)
2. Create a project
3. Copy your API key from **Project Settings → API Keys**
4. Export it as `ALLSTAK_API_KEY` or pass it to `installReactNative(...)`

## Configuration

| Option | Type | Required | Default | Description |
|---|---|---|---|---|
| `apiKey` | `string` | yes | — | Project API key (`ask_live_…`) |
| `environment` | `string` | no | — | Deployment env |
| `release` | `string` | no | — | App version |
| `host` | `string` | no | `https://api.allstak.sa` | Ingest host override |
| `user` | `{ id?, email? }` | no | — | Default user context |
| `tags` | `Record<string,string>` | no | — | Default tags |

## Example Usage

Capture a caught exception:

```ts
try {
  await api.fetchFeed();
} catch (e) {
  AllStak.captureException(e as Error, { screen: 'Feed' });
}
```

Send a log from a screen:

```ts
AllStak.captureMessage('User opened Settings', 'info');
```

Tag the current build channel:

```ts
AllStak.setTag('release-channel', 'beta');
AllStak.setUser({ id: userId });
```

## Production Endpoint

Production endpoint: `https://api.allstak.sa`. Override via `host` for self-hosted installs:

```ts
installReactNative({ apiKey: '...', host: 'https://allstak.mycorp.com' });
```

## Source maps (Hermes / Metro)

JS bundles produced by Metro (with or without Hermes) are minified in
release builds — without source-map upload, your dashboard stacks will
read like `at e (index.bundle:1:42031)`. Wire it up once during release
build via `@allstak/js/sourcemaps` (devDependency only):

```bash
npm install -D @allstak/js
```

```sh
# Build the release bundle as you normally would
npx react-native bundle \
  --platform android --dev false --entry-file index.js \
  --bundle-output android-release.bundle \
  --sourcemap-output android-release.bundle.map

# Hermes-compile (if Hermes is enabled — the default on RN 0.70+)
hermes-compiler --emit-binary --output-source-map \
  -out android-release.hbc android-release.bundle

# Upload to AllStak — debugId injection + map upload
node -e "import('@allstak/js/sourcemaps').then(({ processBuildOutput }) => \
  processBuildOutput({ dir: '.', release: process.env.RELEASE, \
    token: process.env.ALLSTAK_UPLOAD_TOKEN }))"
```

For iOS (`react-native bundle --platform ios`) the same flow applies.
Add this as a release-only step in your CI; the runtime SDK reads the
`debugId` from each frame and resolves the matching map server-side.

> **Status:** the upload pipeline is the same one used by the web SDK
> and is unit-tested in `@allstak/js/tests/sourcemaps-*.test.ts`. Native
> Hermes-bytecode mapping has not yet been integration-tested end-to-end
> against the AllStak symbolicator on a real device build — flag any
> off-by-one source maps in [issues](https://github.com/AllStak/allstak-react-native/issues).

## Links

- Documentation: https://docs.allstak.sa
- Dashboard: https://app.allstak.sa
- Source: https://github.com/allstak-io/allstak-react-native

## License

MIT © AllStak
