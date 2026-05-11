/**
 * React Native navigation breadcrumbs — two opt-in helpers:
 *
 *   - instrumentReactNavigation(navigationRef): call once after the
 *     NavigationContainer is mounted. Subscribes to `state` events on the
 *     NavigationContainerRef and emits a breadcrumb whenever the active
 *     route name changes. Works with @react-navigation/native v6+ without
 *     adding it as a dependency (the ref shape is duck-typed).
 *
 *   - instrumentNavigationFromLinking(): registers a Linking event
 *     listener so deep links also appear in breadcrumbs. Useful when the
 *     app uses Linking.openURL(...) instead of (or alongside) a router.
 *
 * Both helpers are idempotent and never throw if the underlying RN module
 * isn't present (Expo Go, JS-only test runs).
 */

import { AllStak } from './client';

declare const require: (id: string) => any;

type NavigationRef = {
  getCurrentRoute?: () => { name?: string } | undefined;
  addListener?: (event: string, cb: () => void) => () => void;
};

const NAV_FLAG = Symbol.for('allstak.nav.subscribed');
const LINKING_FLAG = '__allstak_linking_patched__';
const NAV_AUTO_PATCH_FLAG = Symbol.for('allstak.nav.autoPatched');

export interface ReactNavigationOptions {
  /**
   * Whitelist of route-param keys safe to record alongside the route name.
   * Anything outside this list is dropped — params commonly carry user IDs,
   * order numbers, etc. Default `[]`.
   */
  safeParams?: string[];
  /**
   * Also forward the screen view to the replay surrogate (if active).
   * Default true — the surrogate itself decides whether it's recording.
   */
  forwardToReplay?: boolean;
}

/**
 * Subscribe to a `@react-navigation/native` NavigationContainerRef and
 * emit a navigation breadcrumb whenever the active route changes. Captures:
 *
 *   - route name change (from -> to)
 *   - whitelisted route params (via `safeParams`)
 *   - state change → forwarded to replay surrogate when enabled
 *
 * Idempotent — installs once per ref. Returns an unsubscribe function.
 */
export function instrumentReactNavigation(
  navigationRef: NavigationRef,
  options: ReactNavigationOptions = {},
): () => void {
  if (!navigationRef || typeof navigationRef.addListener !== 'function') {
    return () => {};
  }
  const ref = navigationRef as any;
  if (ref[NAV_FLAG]) return () => {};
  ref[NAV_FLAG] = true;

  const safeKeys = options.safeParams ?? [];
  const forwardToReplay = options.forwardToReplay !== false;

  const filterParams = (params: Record<string, unknown> | undefined): Record<string, unknown> => {
    const out: Record<string, unknown> = {};
    if (!params) return out;
    for (const key of safeKeys) if (key in params) out[key] = (params as any)[key];
    return out;
  };

  let last: string | undefined = navigationRef.getCurrentRoute?.()?.name;
  const unsub = navigationRef.addListener('state', () => {
    const route = navigationRef.getCurrentRoute?.();
    const next = route?.name;
    if (!next || next === last) return;
    const safe = filterParams((route as any)?.params);
    try {
      AllStak.addBreadcrumb('navigation', `${last ?? '<start>'} -> ${next}`, 'info',
        { from: last, to: next, params: safe });
    } catch { /* never break host */ }

    if (forwardToReplay) {
      try {
        const replay = (AllStak as any).getReplay?.();
        replay?.recordScreenView?.(next, (route as any)?.params);
      } catch { /* ignore */ }
    }
    last = next;
  });
  return () => {
    try { unsub?.(); } catch { /* ignore */ }
    ref[NAV_FLAG] = false;
  };
}

/**
 * Register a Linking listener so `openURL`/deep-link launches surface
 * as breadcrumbs. No-op if `react-native` isn't available (test env).
 */
export function instrumentNavigationFromLinking(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rn = require('react-native');
    const Linking: any = rn?.Linking;
    if (!Linking || typeof Linking.addEventListener !== 'function') return;
    if ((Linking as any)[LINKING_FLAG]) return;

    Linking.addEventListener('url', (ev: { url?: string }) => {
      const url = typeof ev?.url === 'string' ? ev.url : '';
      if (!url) return;
      try { AllStak.addBreadcrumb('navigation', `deep-link: ${url.split('?')[0]}`, 'info', { url }); }
      catch { /* ignore */ }
    });
    (Linking as any)[LINKING_FLAG] = true;
  } catch {
    // react-native not available in this runtime (test, Expo Go web, etc.)
  }
}

/**
 * Best-effort automatic instrumentation of `@react-navigation/native`.
 *
 * **What it does:**
 *   - Tries `require('@react-navigation/native')`. If the package is not
 *     installed, returns `false` and is otherwise a no-op.
 *   - If found, monkey-patches the module's exported `NavigationContainer`
 *     with a wrapper that auto-creates an internal ref, forwards the
 *     user's `ref` prop, and on mount calls `instrumentReactNavigation`
 *     so route changes ship as breadcrumbs.
 *   - Idempotent: a flag on the module's exports object prevents double
 *     patching across hot-reload cycles or repeated `installReactNative`
 *     calls.
 *
 * **Why this works:**
 *   Babel's CommonJS interop preserves runtime property lookups for
 *   named imports — `import { NavigationContainer } from '@react-navigation/native'`
 *   compiles to `_rnav.NavigationContainer` accesses at use-site, so
 *   patching the module's exports object before the host app renders
 *   means user code transparently picks up our wrapper.
 *
 * **Why it might fail:**
 *   - `@react-navigation/native` not installed → returns false silently.
 *   - Module exports frozen or sealed (rare in CJS-style RN builds).
 *   - User imported `NavigationContainer` via a deep path that bypasses
 *     the index module.
 *   In any failure case the manual API (`instrumentReactNavigation(ref)`)
 *   is still available as a fallback.
 */
export function tryAutoInstrumentNavigation(): boolean {
  // Metro detection — auto-patch is incompatible with Metro's static
  // bundler because dynamic `require()` of an external module name
  // surfaces a LogBox dev-error even when caught. On Metro/RN we
  // therefore SKIP the auto-patch entirely and fall through to the
  // documented manual fallback (`instrumentReactNavigation(navigationRef)`).
  // The unit tests still exercise the auto-patch path under Node where
  // dynamic require is well-supported.
  const g: any = globalThis as any;
  const isMetro =
    typeof g.__METRO_GLOBAL_PREFIX__ !== 'undefined' ||
    typeof g.__r === 'function' ||
    typeof g.HermesInternal !== 'undefined';
  if (isMetro) return false;

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rnav = require('@react-navigation/native');
    if (!rnav || !rnav.NavigationContainer) return false;
    if ((rnav as any)[NAV_AUTO_PATCH_FLAG]) return true;

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const React = require('react');
    if (!React || typeof React.forwardRef !== 'function') return false;

    const OrigContainer = rnav.NavigationContainer;

    const Wrapped = React.forwardRef(function AllStakNavigationContainer(
      props: any,
      userRef: any,
    ) {
      const internalRef = React.useRef(null);

      const setRef = React.useCallback((r: any) => {
        internalRef.current = r;
        if (typeof userRef === 'function') userRef(r);
        else if (userRef) userRef.current = r;
      }, [userRef]);

      React.useEffect(() => {
        if (internalRef.current) {
          try { instrumentReactNavigation(internalRef.current); }
          catch { /* never break host */ }
        }
      }, []);

      return React.createElement(OrigContainer, { ...props, ref: setRef });
    });
    Wrapped.displayName = 'AllStakNavigationContainer';

    try {
      // Some bundlers / strict modes freeze the exports object — guard.
      Object.defineProperty(rnav, 'NavigationContainer', {
        value: Wrapped,
        configurable: true,
        writable: true,
      });
      (rnav as any)[NAV_AUTO_PATCH_FLAG] = true;
      return true;
    } catch {
      // Exports immutable — fall back to manual API.
      return false;
    }
  } catch {
    // @react-navigation/native not installed, or React unavailable.
    return false;
  }
}

/** @internal — for tests. Resets the auto-patch flag on the cached module. */
export function __resetAutoNavigationFlagForTest(): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const rnav = require('@react-navigation/native');
    if (rnav) delete (rnav as any)[NAV_AUTO_PATCH_FLAG];
  } catch { /* ignore */ }
}
