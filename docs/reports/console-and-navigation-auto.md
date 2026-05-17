# Console capture extension + Auto-navigation report

**Date:** 2026-05-01
**SDK version under test:** `@allstak/react-native@0.3.0`

Two DX improvements landed in this pass:

1. **Console capture is now configurable per-method** (`log` / `info` /
   `warn` / `error`) with sensible defaults that avoid breadcrumb spam.
2. **React Navigation breadcrumbs are now automatic** when
   `@react-navigation/native` is installed — no `instrumentReactNavigation(ref)`
   call required. The manual API stays as a fallback.

## 1. Console capture

### What changed

`src/auto-breadcrumbs.ts` — `instrumentConsole(addBreadcrumb)` now
accepts an optional `ConsoleCaptureOptions` second arg:

```ts
export interface ConsoleCaptureOptions {
  log?: boolean;    // default false
  info?: boolean;   // default false
  warn?: boolean;   // default true
  error?: boolean;  // default true
}
```

`src/install.ts` reads `AllStak.getConfig().captureConsole` and passes
it through. `AllStakProvider` accepts `captureConsole` as a prop:

```tsx
<AllStakProvider captureConsole={{ log: true, info: true }} />
```

### Why these defaults

Most apps fire `console.log` / `console.info` from debug paths,
animation callbacks, or library noise. Capturing them by default would
flood the dashboard with breadcrumbs the developer never wanted to
upload. `console.warn` and `console.error` are typically reserved for
human-meaningful events, so they capture by default.

The kill switch `autoConsoleBreadcrumbs={false}` still works exactly
as before — it skips wrapping any method.

### Breadcrumb wire shape

```
{
  type: "log",
  message: "<safe-stringified args, joined by space, truncated to 5KB>",
  level: "info" | "warn" | "error",
  data: {
    category: "console",
    method: "log" | "info" | "warn" | "error",
    args: ["<arg1>", "<arg2>", ...]
  }
}
```

### Safe stringification

`safeStringifyArg` (private, `auto-breadcrumbs.ts`) handles:

| Input | Output |
|---|---|
| `null` / `undefined` | `"null"` / `"undefined"` |
| `string` | unchanged |
| `number` / `boolean` / `bigint` | `String(v)` |
| `symbol` | `Symbol(...).toString()` |
| `function` | `"[Function name]"` |
| `Error` | `"Name: message\n<stack>"` |
| Plain object / array | `JSON.stringify` with circular-ref detection (cycles become `"[Circular]"`) |
| Anything > 5000 bytes | suffixed with `"…[truncated]"` |

### Tests added — `test/console-capture.test.mjs` (9 tests)

| # | Test | Result |
|---|---|---|
| 1 | default: warn + error captured, log + info NOT | ✓ |
| 2 | `captureConsole={log:true,info:true}` enables log + info at `level=info` | ✓ |
| 3 | `captureConsole={warn:false,error:false}` suppresses warn + error | ✓ |
| 4 | mixed flags (`log:true, warn:false`) wraps only enabled methods | ✓ |
| 5 | object args are JSON-stringified into `data.args` | ✓ |
| 6 | `Error` args keep name + message + stack | ✓ |
| 7 | circular refs do not crash; cycle becomes `[Circular]` | ✓ |
| 8 | args > 5KB get truncated with `…[truncated]` | ✓ |
| 9 | wrapped methods still call the underlying console fn (passthrough) | ✓ |

## 2. Auto-navigation

### What changed

`src/navigation.ts` — new `tryAutoInstrumentNavigation()` function.

When called, it:

1. Attempts `require('@react-navigation/native')`. If it throws (package
   not installed), returns `false` and silently no-ops.
2. Reads `module.NavigationContainer` and replaces it with a
   `forwardRef` wrapper that:
   - Accepts the user's `ref` prop and forwards it to the original
     container.
   - Maintains an internal ref it controls.
   - On mount, calls `instrumentReactNavigation(internalRef.current)`.
3. Marks the module with a symbol flag so a second call no-ops
   (idempotent — important for Fast Refresh and re-init cycles).

`src/install.ts` calls `tryAutoInstrumentNavigation()` from inside
`installReactNative` when `autoNavigationBreadcrumbs !== false`
(default `true`).

### Why monkey-patching the export object works

React Navigation typically gets imported via:

```ts
import { NavigationContainer } from '@react-navigation/native';
```

Babel's CommonJS transform (the default in Metro) compiles this to:

```js
var _rnav = require('@react-navigation/native');
// usage:
React.createElement(_rnav.NavigationContainer, ...)
```

The named import is a **runtime property lookup** on the module's
exports object, not a one-shot destructure. So if we mutate
`exports.NavigationContainer` after the user's import has run but
before their first render, every subsequent JSX `<NavigationContainer>`
resolves to our wrapper.

`AllStakProvider` mounts before any child renders, and `installReactNative`
is called synchronously inside the provider — so the patch is in place
before any consumer references `NavigationContainer`.

### Honest list of failure modes

This is not a hard guarantee. The patch can fail (and falls back to a
no-op + the manual API) if:

- `@react-navigation/native` isn't installed → `tryAutoInstrumentNavigation` returns false.
- The host app imports via a deep path like `@react-navigation/native/lib/commonjs/NavigationContainer` (rare).
- A future bundler / transform pre-destructures the import at compile time. Today's Metro does not.
- The exports object is frozen. We use `Object.defineProperty` with `configurable: true`; if the property is non-writable + non-configurable we catch the throw and bail.

In every failure case the manual API stays available — this is the
reason `instrumentReactNavigation(navigationRef)` is still exported and
documented as a fallback.

### `AllStakNavigationContainer` displayName

The wrapper sets `displayName = 'AllStakNavigationContainer'`. Useful
for React DevTools so the user can see the wrapping happened.

### Tests added — `test/navigation-auto.test.mjs` (9 tests)

| # | Test | Result |
|---|---|---|
| 1 | `tryAutoInstrumentNavigation` returns false when package not installed | ✓ |
| 2 | `installReactNative` does NOT throw when package missing | ✓ |
| 3 | `tryAutoInstrumentNavigation` patches `NavigationContainer` when present | ✓ |
| 4 | Idempotent — second call doesn't double-wrap | ✓ |
| 5 | Patched container auto-instruments — route changes emit breadcrumbs (verified via `react-test-renderer`) | ✓ |
| 6 | User-supplied ref is still forwarded through the wrapper | ✓ |
| 7 | Manual `instrumentReactNavigation` still works as fallback | ✓ |
| 8 | `autoNavigationBreadcrumbs:false` skips auto-patch even when package present | ✓ |
| 9 | `autoNavigationBreadcrumbs` defaults to true — `installReactNative` patches when present | ✓ |

The mock strategy: tests set `globalThis.require` to a function that
returns a synthetic `@react-navigation/native` exposing a configurable
`NavigationContainer` property. The compiled bundle's tsup `__require`
helper falls back to `globalThis.require`, so the SDK's runtime sees
our fake.

## 3. Files touched

| File | Change |
|---|---|
| `src/auto-breadcrumbs.ts` | Refactored `instrumentConsole` for per-method options + safe stringification + truncation |
| `src/client.ts` | Added `captureConsole?: ConsoleCaptureOptions` to `AllStakConfig` |
| `src/install.ts` | Reads `captureConsole` from config; calls `tryAutoInstrumentNavigation` when `autoNavigationBreadcrumbs !== false` |
| `src/navigation.ts` | New `tryAutoInstrumentNavigation()` function |
| `src/provider.tsx` | Added `captureConsole` prop and forwards `autoNavigationBreadcrumbs` to install options |
| `src/index.ts` | Exports `tryAutoInstrumentNavigation`, `ConsoleCaptureOptions`, test reset helpers |
| `test/console-capture.test.mjs` | **NEW** — 9 tests |
| `test/navigation-auto.test.mjs` | **NEW** — 9 tests |
| `README.md` | Updated Automatic Capture Matrix; new "Opting in to verbose console capture" section; rewrote Navigation Breadcrumbs section to lead with the auto path |

## 4. New config props

```ts
interface AllStakProviderProps {
  // ... existing props ...

  /**
   * Per-console-method capture flags. Defaults: warn + error on,
   * log + info off. Set { log: true, info: true } to opt-in to verbose
   * capture, or { warn: false, error: false } to suppress.
   */
  captureConsole?: ConsoleCaptureOptions;

  /**
   * Auto-detect @react-navigation/native and patch NavigationContainer
   * so route changes ship as breadcrumbs without the host app needing
   * to call instrumentReactNavigation(ref). Default: true. When the
   * package is not installed, this silently no-ops.
   */
  autoNavigationBreadcrumbs?: boolean;
}

interface ConsoleCaptureOptions {
  log?: boolean;    // default false
  info?: boolean;   // default false
  warn?: boolean;   // default true
  error?: boolean;  // default true
}
```

## 5. Test results

```sh
$ npm test
...
# tests 126
# pass 126
# fail 0
# duration_ms 5712
```

Breakdown:
- 108 pre-existing tests
- 9 new `console-capture` tests
- 9 new `navigation-auto` tests

All passing. Type-check clean. Build clean (ESM 65KB, CJS 67KB, DTS 32KB).

## 6. What is NOT yet verified on a real device

- Auto-navigation has been verified end-to-end against a fake
  `@react-navigation/native` module that mirrors the public API
  (`NavigationContainer`, ref shape with `getCurrentRoute` and
  `addListener`). It has **not** been live-verified inside a real Expo
  or RN app with the actual package. The risk is the patching timing on
  Metro's specific module-init order — if `<AllStakProvider>` mounts
  AFTER a `NavigationContainer` reference is already cached locally,
  the patch wouldn't apply. In practice, since the provider sits at the
  app root and JSX evaluation is lazy, this should not happen.
- The `react-test-renderer`-based test confirms the React lifecycle
  semantics (forwardRef + useEffect-based instrumentation) work
  correctly.

A device-level verification with real `@react-navigation/native`
remains a follow-up before claiming "production-ready" for this path.
