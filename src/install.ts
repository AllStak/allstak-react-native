/**
 * React Native runtime integration — ErrorUtils, Hermes promise rejection
 * tracking, Platform tags, AppState breadcrumbs, XHR network capture,
 * fetch breadcrumbs, and console breadcrumbs.
 *
 * Extracted from index.ts so AllStakProvider can call it without circular
 * imports.
 */

import { AllStak, SDK_VERSION, __safeAddBreadcrumbForInstrumentation as safeBc } from './client';
import { instrumentFetch, instrumentConsole } from './auto-breadcrumbs';
import { applyArchitectureTags } from './architecture';
import { tryAutoInstrumentNavigation } from './navigation';

declare const require: (id: string) => any;

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
  /**
   * Wrap `console.*` methods to record log breadcrumbs. Default: true.
   * Per-method capture is controlled by `captureConsole` in AllStakConfig
   * (warn + error default on, log + info default off).
   */
  autoConsoleBreadcrumbs?: boolean;
  /**
   * Auto-detect `@react-navigation/native` and patch `NavigationContainer`
   * so route changes ship as breadcrumbs without the host app needing
   * to call `instrumentReactNavigation(ref)`. Default: true. When the
   * package is not installed, this silently no-ops.
   */
  autoNavigationBreadcrumbs?: boolean;
  /**
   * Emit a `[AllStak] Navigation auto-instrumentation enabled/not applied`
   * console log so developers can confirm the wiring at startup. The
   * provider sets this from its `debug` prop; defaults to false when
   * called manually.
   */
  debugLogs?: boolean;
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

export function installReactNative(options: ReactNativeInstallOptions = {}): void {
  const autoError = options.autoErrorHandler !== false;
  const autoPromise = options.autoPromiseRejections !== false;
  const autoDevice = options.autoDeviceTags !== false;
  const autoAppState = options.autoAppStateBreadcrumbs !== false;
  const autoNetwork = options.autoNetworkCapture !== false;

  AllStak.setTag('platform', 'react-native');
  try { applyArchitectureTags((k, v) => AllStak.setTag(k, v)); } catch { /* ignore */ }

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
      sdkVersion: SDK_VERSION,
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
    try {
      const cfg = AllStak.getConfig();
      instrumentConsole(safeBc, cfg?.captureConsole);
    }
    catch { /* never break init */ }
  }

  if (options.autoNavigationBreadcrumbs !== false) {
    let navResult = false;
    try { navResult = tryAutoInstrumentNavigation(); }
    catch { /* @react-navigation/native not installed — silent fallback */ }
    if (options.debugLogs) {
      // eslint-disable-next-line no-console
      if (navResult) console.log('[AllStak] Navigation auto-instrumentation enabled');
      // eslint-disable-next-line no-console
      else console.log('[AllStak] Navigation auto-instrumentation not applied; use instrumentReactNavigation(ref) fallback');
    }
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
    const wrapTrackerReason = (rejection: unknown): Error =>
      rejection instanceof Error
        ? rejection
        : new Error(`Unhandled promise rejection: ${String(rejection)}`);

    const ship = (err: Error) => {
      try { AllStak.captureException(err, { source: 'unhandledRejection' }); }
      catch { /* ignore */ }
    };

    // 1. Hermes-native Promise rejection tracker — works for the Promise
    //    rejections the typical RN/Hermes app generates. The
    //    `promise/setimmediate/rejection-tracking` package only patches
    //    the `promise` package's polyfill, NOT the Hermes-native Promise,
    //    so we must hook this in addition to (or instead of) the polyfill
    //    tracker for unhandled-rejection capture to work end-to-end.
    try {
      const hermesInternal: any = (globalThis as any).HermesInternal;
      if (hermesInternal && typeof hermesInternal.enablePromiseRejectionTracker === 'function') {
        hermesInternal.enablePromiseRejectionTracker({
          allRejections: true,
          onUnhandled: (_id: number, rejection: unknown) => ship(wrapTrackerReason(rejection)),
          onHandled: () => {},
        });
      }
    } catch { /* never break init */ }

    // 2. Polyfill-side tracker (works on JSC + on RN polyfilled Promise).
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const tracking = require('promise/setimmediate/rejection-tracking');
      tracking.enable({
        allRejections: true,
        onUnhandled: (_id: number, rejection: unknown) => ship(wrapTrackerReason(rejection)),
        onHandled: () => {},
      });
    } catch {
      // Last-resort browser-style listener — keep the original wrapping
      // (bare String(reason)) so existing test contracts still match.
      const g: any = globalThis as any;
      if (typeof g.addEventListener === 'function') {
        g.addEventListener('unhandledrejection', (ev: any) => {
          const reason = ev?.reason;
          const err = reason instanceof Error ? reason : new Error(String(reason));
          ship(err);
        });
      }
    }
  }
}
