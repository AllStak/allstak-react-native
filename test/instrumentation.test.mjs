/**
 * Instrumentation + filtering-control tests for @allstak/react-native:
 *   - setLevel propagates to payload.level
 *   - setFingerprint propagates to payload.fingerprint
 *   - instrumentFetch records a breadcrumb on success and on failure;
 *     skips own-ingest URLs; preserves the original return value/throw.
 *   - instrumentConsole records breadcrumbs for warn/error and still
 *     calls the original console fn.
 *   - Navigation helpers: instrumentReactNavigation emits a breadcrumb
 *     when the navigation ref's current route name changes;
 *     instrumentNavigationFromLinking is a safe no-op without RN.
 *   - drainPendingNativeCrashes routes the stashed payload through
 *     captureException with native.crash=true.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
let failNextN = 0;
const baseFetch = async (url, init) => {
  // Our SDK's fetch sends to https://api.allstak.sa/ingest/* — record those.
  if (/api\.allstak\.sa/.test(String(url))) {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  }
  if (failNextN > 0) { failNextN -= 1; throw new Error('network'); }
  return new Response('ok', { status: 200, headers: { 'Content-Type': 'text/plain' } });
};
// Install as a writable property so instrumentFetch can wrap it in-place.
Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

const { AllStak, installReactNative, instrumentReactNavigation, instrumentNavigationFromLinking } =
  await import('../dist/index.mjs');

// ───────────────────────────────────────────────────────────────
// setLevel + setFingerprint
// ───────────────────────────────────────────────────────────────

test('setLevel changes payload.level on subsequent captureException', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setLevel('warning');
  AllStak.captureException(new Error('warn-me'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(sent[0].init.body).level, 'warning');
});

test('setFingerprint propagates to payload.fingerprint', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setFingerprint(['feature-checkout', 'v2']);
  AllStak.captureException(new Error('group-me'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.fingerprint, ['feature-checkout', 'v2']);
});

test('setFingerprint(null) clears the fingerprint', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setFingerprint(['a']);
  AllStak.setFingerprint(null);
  AllStak.captureException(new Error('cleared'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.fingerprint, undefined);
});

// ───────────────────────────────────────────────────────────────
// instrumentFetch (via installReactNative auto-wire)
// ───────────────────────────────────────────────────────────────

test('installReactNative wraps fetch — successful request adds an http breadcrumb', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false,  // disable XHR shim so we test fetch path only
    autoFetchBreadcrumbs: true,
    autoConsoleBreadcrumbs: false,
  });

  const res = await fetch('https://example.com/api/data?secret=hide');
  assert.equal(res.status, 200, 'wrapper must preserve the response');

  // Trigger a capture to flush the breadcrumb buffer into a payload.
  AllStak.captureException(new Error('after-fetch'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  assert.ok(Array.isArray(body.breadcrumbs), 'breadcrumbs must be present');
  const httpCrumb = body.breadcrumbs.find((c) => c.type === 'http');
  assert.ok(httpCrumb, 'an http breadcrumb must have been recorded');
  assert.match(httpCrumb.message, /^GET https:\/\/example\.com\/api\/data -> 200$/,
    'breadcrumb must strip the query string');
});

test('instrumentFetch records breadcrumb + rethrows on failure', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  // Already wrapped from prior test (idempotent flag).
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: true, autoConsoleBreadcrumbs: false,
  });

  failNextN = 1;
  await assert.rejects(() => fetch('https://example.com/will-fail'), /network/);

  AllStak.captureException(new Error('after-failed-fetch'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const failCrumb = body.breadcrumbs.find((c) => c.type === 'http' && /failed$/.test(c.message));
  assert.ok(failCrumb, 'failed-fetch breadcrumb must be recorded');
  assert.equal(failCrumb.level, 'error');
});

test('instrumentFetch skips own-ingest URLs (no recursion)', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: true, autoConsoleBreadcrumbs: false,
  });
  AllStak.captureException(new Error('one'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  // The capture itself triggered a fetch to api.allstak.sa — it must NOT
  // appear as an http breadcrumb (the previous capture cleared crumbs).
  if (body.breadcrumbs) {
    for (const c of body.breadcrumbs) {
      assert.ok(!/api\.allstak\.sa/.test(String(c.data?.url || '')),
        'own-ingest URL must not be in breadcrumbs');
    }
  }
});

// ───────────────────────────────────────────────────────────────
// instrumentConsole
// ───────────────────────────────────────────────────────────────

test('instrumentConsole records warn/error breadcrumbs and forwards to console', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });

  const origWarn = console.warn;
  const origError = console.error;
  const calls = [];
  console.warn = (...a) => calls.push(['warn', a.join(' ')]);
  console.error = (...a) => calls.push(['error', a.join(' ')]);

  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });

  console.warn('a-warning');
  console.error('an-error');

  // Original console fns must still have been invoked.
  assert.deepEqual(calls, [['warn', 'a-warning'], ['error', 'an-error']]);

  console.warn = origWarn;
  console.error = origError;

  AllStak.captureException(new Error('after-logs'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const logCrumbs = body.breadcrumbs.filter((c) => c.type === 'log');
  assert.equal(logCrumbs.length, 2);
  assert.equal(logCrumbs[0].level, 'warn');
  assert.equal(logCrumbs[0].message, 'a-warning');
  assert.equal(logCrumbs[1].level, 'error');
});

// ───────────────────────────────────────────────────────────────
// Navigation helpers
// ───────────────────────────────────────────────────────────────

test('instrumentReactNavigation emits breadcrumbs on route change', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });

  // Fake @react-navigation/native NavigationContainerRef
  let currentRoute = { name: 'Home' };
  const listeners = new Set();
  const ref = {
    getCurrentRoute: () => currentRoute,
    addListener: (_evt, cb) => { listeners.add(cb); return () => listeners.delete(cb); },
  };
  const dispatch = () => listeners.forEach((cb) => cb());

  const unsub = instrumentReactNavigation(ref);

  currentRoute = { name: 'Profile' };
  dispatch();
  currentRoute = { name: 'Settings' };
  dispatch();
  currentRoute = { name: 'Settings' }; // duplicate — must NOT record
  dispatch();

  AllStak.captureException(new Error('after-nav'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const navCrumbs = body.breadcrumbs.filter((c) => c.type === 'navigation');
  assert.equal(navCrumbs.length, 2);
  assert.equal(navCrumbs[0].message, 'Home -> Profile');
  assert.equal(navCrumbs[1].message, 'Profile -> Settings');

  unsub();
});

test('instrumentNavigationFromLinking is a safe no-op without RN runtime', () => {
  // No Linking module available in node — must not throw.
  assert.doesNotThrow(() => instrumentNavigationFromLinking());
});

// ───────────────────────────────────────────────────────────────
// drainPendingNativeCrashes routes through captureException
// ───────────────────────────────────────────────────────────────

test('drainPendingNativeCrashes parses native payload and captures it', async () => {
  const { __setNativeModuleForTest, drainPendingNativeCrashes } = await import('../dist/index.mjs');
  __setNativeModuleForTest({
    install: async () => {},
    drainPendingCrash: async () => JSON.stringify({
      exceptionClass: 'NSException',
      message: 'native fatal',
      stackTrace: ['0   App                                 0x123'],
      metadata: { thread: 'main' },
    }),
  });

  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  await drainPendingNativeCrashes('mobile@1.0.0');
  await new Promise((r) => setTimeout(r, 50));

  __setNativeModuleForTest(null);

  assert.equal(sent.length, 1, 'a captureException must be issued');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'native fatal');
  assert.equal(body.exceptionClass, 'NSException');
  assert.equal(body.metadata['native.crash'], 'true');
  assert.equal(body.metadata.thread, 'main');
});

test('drainPendingNativeCrashes is a no-op when no native module is present', async () => {
  const { __setNativeModuleForTest, drainPendingNativeCrashes } = await import('../dist/index.mjs');
  __setNativeModuleForTest(null);
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  await drainPendingNativeCrashes();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0);
});
