# @allstak/react-native

AllStak React Native SDK for Expo and React Native CLI apps. It captures JavaScript errors, render errors, unhandled promises where available, breadcrumbs, HTTP metadata, release/environment/device tags, user context, and native crashes when native modules are linked in a dev client or native build.

Stability: beta. Live dashboard certification and native crash proof are not claimed until verified with real credentials and a native build.

## 1. Automatic Setup With Wizard

Recommended flow:

```bash
npx @allstak/wizard setup --integration react-native
```

For Expo managed projects, this also patches static `app.json` plugin config. The only value you may need to enter is the AllStak ingest API key.

## 2. What The Wizard Changes

The wizard:

- Installs `@allstak/react-native`.
- Detects Expo managed, Expo bare/prebuilt, and React Native CLI projects.
- Writes managed `ALLSTAK_*` and `EXPO_PUBLIC_ALLSTAK_*` env vars.
- Detects `App.tsx`, `App.jsx`, `App.ts`, `App.js`, `src/App.*`, or root `index.*`.
- Wraps the app root with `AllStakProvider`.
- Preserves existing providers and app content.
- Adds package scripts for verification and source-map upload.
- Adds `@allstak/react-native` to `app.json expo.plugins[]` when a static Expo config exists.
- Leaves native linking to React Native autolinking; no manual linking is required for standard RN CLI/dev-client builds.
- Supports dry-run, repair, idempotent re-runs, and uninstall.

## 3. Verification

After setup:

```bash
npm run allstak:verify
npx @allstak/wizard doctor --integration react-native
```

For Expo:

```bash
npx expo config --type public
```

For RN CLI, run your normal TypeScript/build checks. Dashboard delivery requires real credentials and must be verified in AllStak.

## 4. Rollback / Uninstall

```bash
npx @allstak/wizard uninstall --integration react-native
```

Uninstall removes wizard-managed env blocks, package scripts, Expo plugin entries, imports, and provider wrappers. User-owned code outside wizard-managed setup is preserved.

## 5. Manual Setup Fallback

Use manual setup only when the wizard cannot safely patch a custom root:

```bash
npm install @allstak/react-native
```

```tsx
import { AllStakProvider } from '@allstak/react-native';

export default function App() {
  return (
    <AllStakProvider
      apiKey={process.env.EXPO_PUBLIC_ALLSTAK_API_KEY ?? process.env.ALLSTAK_API_KEY}
      host={process.env.EXPO_PUBLIC_ALLSTAK_HOST ?? process.env.ALLSTAK_HOST}
      environment={process.env.EXPO_PUBLIC_ALLSTAK_ENVIRONMENT ?? 'production'}
      release={process.env.EXPO_PUBLIC_ALLSTAK_RELEASE ?? process.env.ALLSTAK_RELEASE}
      enableHttpTracking
    >
      {/* app */}
    </AllStakProvider>
  );
}
```

Manual capture:

```ts
import { AllStak } from '@allstak/react-native';

AllStak.captureException(new Error('mobile failure'));
AllStak.captureMessage('checkout opened');
AllStak.setUser({ id: 'user_123' });
AllStak.addBreadcrumb({ type: 'navigation', message: 'Checkout' });
```

## 6. Configuration

Provider props include:

| Option | Default | Notes |
| --- | --- | --- |
| `apiKey` | required | Public mobile ingest key. |
| `host` | `https://api.allstak.sa` | Override for self-hosted ingest. |
| `environment` | `production` | Release environment tag. |
| `release` | unset | App version or build number. |
| `debug` | `false` | Enables SDK diagnostic logs. |
| `enableHttpTracking` | `false` | Captures HTTP metadata with redaction. |
| `autoCaptureJsErrors` | `true` | Captures ErrorUtils/global JS errors where available. |
| `autoUnhandledRejections` | `true` | Captures promise rejections where supported. |
| `captureConsole` | warn/error on | `log`/`info` stay off by default. |
| `beforeSend` | unset | Last-chance scrub/drop hook. |

## 7. Privacy / PII / Redaction

Defaults are privacy-first:

- Authorization, cookie, API key, token, and secret headers are always redacted.
- Sensitive query parameters are redacted.
- Request/response body capture is disabled unless explicitly enabled.
- Recursive JSON body redaction is available when body capture is enabled.
- Queue size is capped and transport failures fail open.
- Use `beforeSend` for app-specific PII removal.

Do not send passwords, payment data, national IDs, raw tokens, or raw request/response bodies unless you have verified redaction in your app.

## 8. Source Maps / Releases

The wizard adds:

```bash
npm run allstak:sourcemaps
```

Set the same release in your app and source-map upload:

```bash
export ALLSTAK_RELEASE=my-app@1.2.3
export ALLSTAK_SOURCEMAP_TOKEN=...
npm run allstak:sourcemaps
```

Expo EAS users can call the package build hook from their EAS workflow. RN CLI users can call the upload hook after Metro/Hermes source maps are generated.

## 9. Troubleshooting

- No events: verify `ALLSTAK_API_KEY` or `EXPO_PUBLIC_ALLSTAK_API_KEY` and confirm one provider wrapper.
- Duplicate events: run `npx @allstak/wizard doctor --integration react-native`.
- Expo Go native crashes missing: expected. Native modules require a dev client or native build.
- Source maps missing: confirm `ALLSTAK_SOURCEMAP_TOKEN` and matching `release`.
- Build fails after setup: run uninstall, then rerun setup with `--dry-run` and inspect the planned diff.

## 10. Limitations

- Native crash capture is not available in Expo Go.
- Native crash proof requires a native build and dashboard verification.
- Live dashboard delivery is not proven by local tests.
- Some React Navigation breadcrumb paths may still need explicit app navigation lifecycle validation.
- Stable production launch requires live certification against your dashboard.
