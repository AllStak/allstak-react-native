/**
 * Capture-matrix coverage tests.
 *
 * Documents and asserts the actual automatic-capture behavior of
 * @allstak/react-native:
 *
 *   - HTTP 4xx response → http breadcrumb at level=error
 *   - HTTP 5xx response → http breadcrumb at level=error
 *   - fetch network failure → http breadcrumb with error data, rethrows
 *   - console.warn capture → log breadcrumb at level=warn
 *   - console.error capture → log breadcrumb at level=error
 *   - AppState breadcrumb when react-native is available
 *   - Platform tags (device.os / device.osVersion / device.model) in
 *     event payload when react-native is available
 *   - Architecture tags (rn.architecture / rn.bridgeless / rn.hermes)
 *     present even without react-native
 *   - SDK identity (sdkName / sdkVersion / platform / dist) on events
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// ── Mock react-native and rejection-tracking via globalThis.require ──
// The compiled bundle uses tsup's __require helper which falls back to
// `globalThis.require` when defined. Setting it here lets us exercise
// the install.ts paths that lazy-require RN modules.
const fakeAppStateListeners = [];
const fakeRN = {
  Platform: {
    OS: 'ios',
    Version: '17.4',
    constants: { Model: 'iPhone 15 Pro' },
  },
  AppState: {
    addEventListener: (event, cb) => {
      if (event === 'change') fakeAppStateListeners.push(cb);
      return { remove: () => {} };
    },
  },
  NativeModules: {},
  Linking: { addEventListener: () => {} },
};
const fakeRejectionTrackingHandlers = [];
const fakeRejectionTracking = {
  enable: (opts) => fakeRejectionTrackingHandlers.push(opts),
};
globalThis.require = (id) => {
  if (id === 'react-native') return fakeRN;
  if (id === 'promise/setimmediate/rejection-tracking') return fakeRejectionTracking;
  throw new Error(`module not found: ${id}`);
};

// ── HTTP mock that we control per-test ───────────────────────────
const sent = [];
let nextResponseStatus = 200;
let nextResponseBody = 'ok';
let nextThrow = null;
const baseFetch = async (url, _init) => {
  if (/api\.allstak\.sa/.test(String(url))) {
    sent.push({ url: String(url), init: _init });
    return new Response('{}', { status: 200 });
  }
  if (nextThrow) {
    const err = nextThrow;
    nextThrow = null;
    throw err;
  }
  return new Response(nextResponseBody, { status: nextResponseStatus });
};
Object.defineProperty(globalThis, 'fetch', {
  value: baseFetch,
  writable: true,
  configurable: true,
});

const { AllStak, installReactNative } = await import('../dist/index.mjs');

function freshInit() {
  AllStak.destroy();
  sent.length = 0;
  fakeAppStateListeners.length = 0;
  fakeRejectionTrackingHandlers.length = 0;
  AllStak.init({ apiKey: 'k', release: 'mobile@1.0.0' });
}

// ───────────────────────────────────────────────────────────────
// HTTP 4xx / 5xx breadcrumb level
// ───────────────────────────────────────────────────────────────

test('HTTP 4xx response is recorded as a breadcrumb at level=error', async () => {
  freshInit();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: true,
    autoConsoleBreadcrumbs: false,
  });

  nextResponseStatus = 404;
  nextResponseBody = 'not found';
  await fetch('https://example.com/api/missing');

  AllStak.captureException(new Error('after-404'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const httpCrumb = body.breadcrumbs.find((c) => c.type === 'http' && c.message.includes('404'));
  assert.ok(httpCrumb, 'a 404 breadcrumb must be recorded');
  assert.equal(httpCrumb.level, 'error', '4xx must be level=error');
  assert.equal(httpCrumb.data.statusCode, 404);
});

test('HTTP 5xx response is recorded as a breadcrumb at level=error', async () => {
  freshInit();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: true,
    autoConsoleBreadcrumbs: false,
  });

  nextResponseStatus = 502;
  nextResponseBody = 'bad gateway';
  await fetch('https://example.com/api/down');

  AllStak.captureException(new Error('after-502'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const httpCrumb = body.breadcrumbs.find((c) => c.type === 'http' && c.message.includes('502'));
  assert.ok(httpCrumb, 'a 502 breadcrumb must be recorded');
  assert.equal(httpCrumb.level, 'error', '5xx must be level=error');
  assert.equal(httpCrumb.data.statusCode, 502);
});

test('fetch network failure records a breadcrumb with error data and rethrows', async () => {
  freshInit();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: true,
    autoConsoleBreadcrumbs: false,
  });

  nextThrow = new Error('connection refused');
  await assert.rejects(() => fetch('https://example.com/api/dead'), /connection refused/);

  AllStak.captureException(new Error('after-net-fail'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const failCrumb = body.breadcrumbs.find((c) => c.type === 'http' && /failed$/.test(c.message));
  assert.ok(failCrumb, 'network-failure breadcrumb must be recorded');
  assert.equal(failCrumb.level, 'error');
  assert.match(String(failCrumb.data.error), /connection refused/);
  assert.equal(failCrumb.data.statusCode, undefined);
});

// ───────────────────────────────────────────────────────────────
// console.warn / console.error
// ───────────────────────────────────────────────────────────────

test('console.warn AND console.error are captured as log breadcrumbs at the right level', async () => {
  freshInit();

  // Stub both BEFORE install so instrumentConsole captures the stubs as the
  // originals (avoids printing test noise to the test runner).
  const origWarn = console.warn;
  const origError = console.error;
  console.warn = () => {};
  console.error = () => {};

  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });

  console.warn('warn-test-message');
  console.error('error-test-message');

  // Restore for downstream tests / test reporter.
  console.warn = origWarn;
  console.error = origError;

  AllStak.captureException(new Error('after-console'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const warnCrumb = body.breadcrumbs.find((c) => c.type === 'log' && c.message === 'warn-test-message');
  const errorCrumb = body.breadcrumbs.find((c) => c.type === 'log' && c.message === 'error-test-message');
  assert.ok(warnCrumb, 'console.warn must produce a log breadcrumb');
  assert.equal(warnCrumb.level, 'warn');
  assert.ok(errorCrumb, 'console.error must produce a log breadcrumb');
  assert.equal(errorCrumb.level, 'error');
});

// ───────────────────────────────────────────────────────────────
// AppState breadcrumb (requires fake react-native via globalThis.require)
// ───────────────────────────────────────────────────────────────

test('AppState change emits a navigation breadcrumb when autoAppStateBreadcrumbs is on (default)', async () => {
  freshInit();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false,
    autoAppStateBreadcrumbs: true,  // explicit ON for clarity
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoConsoleBreadcrumbs: false,
  });

  assert.ok(fakeAppStateListeners.length >= 1, 'AppState.addEventListener("change", ...) must be called');

  // Simulate the OS pushing an AppState transition.
  fakeAppStateListeners[0]('background');
  fakeAppStateListeners[0]('active');

  AllStak.captureException(new Error('after-appstate'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const navCrumbs = body.breadcrumbs.filter((c) => c.type === 'navigation' && /AppState/.test(c.message));
  assert.equal(navCrumbs.length, 2);
  assert.match(navCrumbs[0].message, /AppState\b.*background/);
  assert.match(navCrumbs[1].message, /AppState\b.*active/);
  assert.equal(navCrumbs[0].data.appState, 'background');
});

// ───────────────────────────────────────────────────────────────
// Platform / device tags
// ───────────────────────────────────────────────────────────────

test('Platform.OS / Platform.Version / Model land on the event payload when autoDeviceTags is on', async () => {
  freshInit();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: true,
    autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoConsoleBreadcrumbs: false,
  });

  AllStak.captureException(new Error('tag-check'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.metadata['device.os'], 'ios');
  assert.equal(body.metadata['device.osVersion'], '17.4');
  assert.equal(body.metadata['device.model'], 'iPhone 15 Pro');
});

test('SDK identity is stamped: sdkName / platform / dist on every event', async () => {
  freshInit();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoConsoleBreadcrumbs: false,
  });

  AllStak.captureException(new Error('identity-check'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.sdkName, 'allstak-react-native');
  assert.equal(body.platform, 'react-native');
  // dist auto-detected to ios-jsc (Hermes flag not set in this Node env)
  assert.equal(body.dist, 'ios-jsc');
});

test('Architecture tags (rn.architecture, rn.bridgeless, rn.hermes) are set on init', async () => {
  freshInit();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoConsoleBreadcrumbs: false,
  });

  AllStak.captureException(new Error('arch-check'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  // In Node test env none of the RN globals are set, so tag is "unknown".
  // The point is they ARE present on the payload — install.ts always
  // calls applyArchitectureTags.
  assert.ok('rn.architecture' in body.metadata, 'rn.architecture tag must be set');
  assert.ok('rn.hermes' in body.metadata, 'rn.hermes tag must be set');
  assert.ok('rn.bridgeless' in body.metadata, 'rn.bridgeless tag must be set');
});

// ───────────────────────────────────────────────────────────────
// Release / environment / user / tags propagation
// ───────────────────────────────────────────────────────────────

test('release + environment from init flow into every payload', async () => {
  AllStak.destroy();
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    release: 'expo-test@2.0.0+42',
    environment: 'staging',
  });
  AllStak.captureException(new Error('release-tag'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.release, 'expo-test@2.0.0+42');
  assert.equal(body.environment, 'staging');
});

test('setUser, setTag, setContext propagate to subsequent events', async () => {
  AllStak.destroy();
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setUser({ id: 'u-9', email: 'x@y.com' });
  AllStak.setTag('feature', 'cart');
  AllStak.setContext('app', { build: '42' });
  AllStak.captureException(new Error('with-context'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.user, { id: 'u-9', email: 'x@y.com' });
  assert.equal(body.metadata.feature, 'cart');
  assert.deepEqual(body.metadata['context.app'], { build: '42' });
});
