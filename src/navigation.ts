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
