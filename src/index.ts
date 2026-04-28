/**
 * @allstak/react-native — standalone React Native SDK.
 *
 * Self-contained: depends only on `react-native` (peer) and the global
 * `fetch`/`AbortController` that RN guarantees. Contains no `window`,
 * `document`, `localStorage`, `sessionStorage`, or browser DOM event
 * listeners.
 *
 * Usage:
 *
 *   AllStak.init({ apiKey, environment, release });
 *   installReactNative();
 *
 * Native crash capture (Java/Kotlin on Android, Obj-C/Swift on iOS) lives
 * under the `native/` directory in this package. See README.
 */

import { AllStak, __safeAddBreadcrumbForInstrumentation as safeBc } from './client';
import { instrumentFetch, instrumentConsole } from './auto-breadcrumbs';

// React Native runs CommonJS, so `require` is always present at runtime.
// Declared here (instead of pulling @types/node) so consumers don't inherit
// Node types they don't need.
declare const require: (id: string) => any;

export { AllStak } from './client';
export type { AllStakConfig, Breadcrumb } from './client';
export { AllStakClient, INGEST_HOST, SDK_NAME, SDK_VERSION } from './client';
export { instrumentReactNavigation, instrumentNavigationFromLinking } from './navigation';

type ErrorUtilsShape = {
  getGlobalHandler: () => (error: Error, isFatal?: boolean) => void;
  setGlobalHandler: (handler: (error: Error, isFatal?: boolean) => void) => void;
};

export interface ReactNativeInstallOptions {
  /** Auto-capture unhandled JS exceptions via ErrorUtils. Default: true */
  autoErrorHandler?: boolean;
  /** Auto-capture unhandled promise rejections (Hermes). Default: true */
  autoPromiseRejections?: boolean;
  /** Auto-attach Platform.* info as tags. Default: true */
  autoDeviceTags?: boolean;
  /** Auto-emit breadcrumbs on AppState change. Default: true */
  autoAppStateBreadcrumbs?: boolean;
  /** Auto-instrument XHR (RN's fetch is XHR-based) for network breadcrumbs. Default: true */
  autoNetworkCapture?: boolean;
  /** Wrap `globalThis.fetch` to record HTTP breadcrumbs. Default: true */
  autoFetchBreadcrumbs?: boolean;
  /** Wrap `console.warn`/`console.error` to record log breadcrumbs. Default: true */
  autoConsoleBreadcrumbs?: boolean;
}

/**
 * Patch the global `XMLHttpRequest` so any HTTP call (RN's `fetch` is
 * XHR-based) is captured as a network breadcrumb. Idempotent. Skips the
 * AllStak ingest host so we never recurse.
 */
function instrumentXmlHttpRequest(): void {
  const flag = '__allstak_xhr_patched__';
  const X: any = (globalThis as any).XMLHttpRequest;
  if (!X || X.prototype[flag]) return;

  const ownHost = (() => {
    try {
      const cfg = AllStak.getConfig();
      return (cfg?.host ?? 'https://api.allstak.sa').replace(/\/$/, '');
    } catch { return ''; }
  })();

  const origOpen = X.prototype.open;
  const origSend = X.prototype.send;

  X.prototype.open = function (method: string, url: string, ...rest: unknown[]) {
    (this as any).__allstak_method__ = method;
    (this as any).__allstak_url__ = url;
    return origOpen.call(this, method, url, ...rest);
  };

  X.prototype.send = function (body?: unknown) {
    const start = Date.now();
    const method: string = (this as any).__allstak_method__ || 'GET';
    const url: string = (this as any).__allstak_url__ || '';
    const isOwnIngest = ownHost && url.startsWith(ownHost);
    let path = url;
    try { path = new URL(url).pathname; } catch { /* relative URL */ }

    const onDone = (status: number) => {
      const durationMs = Date.now() - start;
      try {
        AllStak.addBreadcrumb('http', `${method} ${path} -> ${status}`,
          status >= 400 ? 'error' : 'info',
          { method, url: path, statusCode: status, durationMs });
      } catch { /* never break */ }
    };

    if (!isOwnIngest) {
      this.addEventListener?.('load', () => onDone(this.status || 0));
      this.addEventListener?.('error', () => onDone(0));
      this.addEventListener?.('abort', () => onDone(0));
      this.addEventListener?.('timeout', () => onDone(0));
    }

    return origSend.call(this, body);
  };

  X.prototype[flag] = true;
}

/**
 * Test seam — set a fake native module to be returned by
 * `drainPendingNativeCrashes` instead of `require('react-native').NativeModules.AllStakNative`.
 * Pass `null` to clear. Production callers must NOT use this.
 *
 * @internal
 */
let __testNativeModule: any = null;
export function __setNativeModuleForTest(mod: any): void {
  __testNativeModule = mod;
}

/**
 * Drain any native crash stashed by AllStakCrashHandler on the previous
 * launch and ship it to /ingest/v1/errors. No-op when the native module
 * is not linked (Expo Go, JS-only test runners, etc).
 */
export async function drainPendingNativeCrashes(release?: string): Promise<void> {
  try {
    let native: any = __testNativeModule;
    if (!native) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      native = rn?.NativeModules?.AllStakNative;
    }
    if (!native) return;
    if (typeof native.install === 'function') {
      try { await native.install(release ?? ''); } catch { /* ignore */ }
    }
    if (typeof native.drainPendingCrash === 'function') {
      const json: string | null = await native.drainPendingCrash();
      if (json && json !== '') {
        try {
          const payload = JSON.parse(json);
          const err = new Error(payload?.message ?? 'Native crash');
          err.name = payload?.exceptionClass ?? 'NativeCrash';
          (err as any).stack = Array.isArray(payload?.stackTrace)
            ? payload.stackTrace.join('\n')
            : String(payload?.stackTrace ?? '');
          AllStak.captureException(err, {
            ...(payload?.metadata || {}),
            'native.crash': 'true',
          });
        } catch { /* swallow */ }
      }
    }
  } catch {
    // react-native not available in this runtime
  }
}

export function installReactNative(options: ReactNativeInstallOptions = {}): void {
  const autoError = options.autoErrorHandler !== false;
  const autoPromise = options.autoPromiseRejections !== false;
  const autoDevice = options.autoDeviceTags !== false;
  const autoAppState = options.autoAppStateBreadcrumbs !== false;
  const autoNetwork = options.autoNetworkCapture !== false;

  AllStak.setTag('platform', 'react-native');

  // Stamp SDK identity + auto-detected dist (ios-hermes / android-jsc / …).
  try {
    const hermes = typeof (globalThis as { HermesInternal?: unknown }).HermesInternal !== 'undefined';
    let dist: string | undefined;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      const os = rn?.Platform?.OS as string | undefined;
      if (os === 'ios' || os === 'android') {
        dist = `${os}-${hermes ? 'hermes' : 'jsc'}`;
      }
    } catch { /* not running under RN */ }
    AllStak.setIdentity({
      sdkName: 'allstak-react-native',
      sdkVersion: '0.1.4',
      platform: 'react-native',
      dist,
    });
  } catch { /* never break init */ }

  if (autoNetwork) {
    try { instrumentXmlHttpRequest(); } catch { /* not in JS env */ }
  }

  if (options.autoFetchBreadcrumbs !== false) {
    try {
      const cfg = AllStak.getConfig();
      const ownBaseUrl = (cfg?.host ?? 'https://api.allstak.sa').replace(/\/$/, '');
      instrumentFetch(safeBc, ownBaseUrl);
    } catch { /* never break init */ }
  }
  if (options.autoConsoleBreadcrumbs !== false) {
    try { instrumentConsole(safeBc); }
    catch { /* never break init */ }
  }

  if (autoDevice) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      const Platform: any = rn?.Platform;
      if (Platform) {
        AllStak.setTag('device.os', String(Platform.OS ?? ''));
        AllStak.setTag('device.osVersion', String(Platform.Version ?? ''));
        if (Platform.constants?.Model) {
          AllStak.setTag('device.model', String(Platform.constants.Model));
        }
      }
    } catch { /* not running under RN */ }
  }

  if (autoAppState) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const rn = require('react-native');
      const AppState: any = rn?.AppState;
      if (AppState && typeof AppState.addEventListener === 'function') {
        AppState.addEventListener('change', (next: string) => {
          try {
            AllStak.addBreadcrumb('navigation', `AppState → ${next}`, 'info', { appState: next });
          } catch { /* ignore */ }
        });
      }
    } catch { /* no RN available */ }
  }

  if (autoError) {
    const eu: ErrorUtilsShape | undefined = (globalThis as any).ErrorUtils;
    if (eu && typeof eu.setGlobalHandler === 'function') {
      const prev = eu.getGlobalHandler();
      eu.setGlobalHandler((error: Error, isFatal?: boolean) => {
        try {
          AllStak.captureException(error, {
            source: 'react-native-ErrorUtils',
            fatal: String(Boolean(isFatal)),
          });
        } catch { /* never break */ }
        try { prev(error, isFatal); } catch { /* ignore */ }
      });
    }
  }

  if (autoPromise) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tracking = require('promise/setimmediate/rejection-tracking');
      tracking.enable({
        allRejections: true,
        onUnhandled: (_id: number, rejection: unknown) => {
          const err = rejection instanceof Error
            ? rejection
            : new Error(`Unhandled promise rejection: ${String(rejection)}`);
          try { AllStak.captureException(err, { source: 'unhandledRejection' }); }
          catch { /* ignore */ }
        },
        onHandled: () => {},
      });
    } catch {
      // Last-resort fallback: globalThis.addEventListener if present.
      // Note: we explicitly do NOT touch window/document — only globalThis.
      const g: any = globalThis as any;
      if (typeof g.addEventListener === 'function') {
        g.addEventListener('unhandledrejection', (ev: any) => {
          const reason = ev?.reason;
          const err = reason instanceof Error ? reason : new Error(String(reason));
          try { AllStak.captureException(err, { source: 'unhandledRejection' }); }
          catch { /* ignore */ }
        });
      }
    }
  }
}
