/**
 * Tests for tryAutoInstrumentNavigation — the zero-config path that
 * monkey-patches @react-navigation/native's NavigationContainer when the
 * package is installed.
 *
 * Verifies:
 *   - No crash when @react-navigation/native is NOT installed
 *   - Auto-detection patches NavigationContainer when package IS present
 *   - Patch is idempotent (second call doesn't double-wrap)
 *   - Patched container forwards user refs and emits breadcrumbs on
 *     route change
 *   - Manual API (instrumentReactNavigation) still works as a fallback
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => {
    if (/api\.allstak\.sa/.test(String(url))) sent.push({ url: String(url), init });
    return new Response('{}', { status: 200 });
  },
  writable: true,
  configurable: true,
});

// ── Mock @react-navigation/native via globalThis.require ───────
// The compiled bundle uses tsup's __require helper that falls back to
// `globalThis.require`. We supply a fake module so we can drive the
// auto-instrumentation path without installing the real package.
//
// React itself is a real dev dependency, so let `require('react')` go
// through to the real package. Same for `react-native` (we don't need it
// for these tests).
let fakeRNavModule = null;  // null => simulate "not installed"
const realRequire = (await import('node:module')).createRequire(import.meta.url);
globalThis.require = (id) => {
  if (id === '@react-navigation/native') {
    if (fakeRNavModule === null) {
      throw new Error("Cannot find module '@react-navigation/native'");
    }
    return fakeRNavModule;
  }
  if (id === 'react') return realRequire('react');
  if (id === 'react-test-renderer') return realRequire('react-test-renderer');
  if (id === 'react-native') {
    throw new Error("Cannot find module 'react-native'");
  }
  if (id === 'promise/setimmediate/rejection-tracking') {
    throw new Error("not in this test");
  }
  // Defer to real require for anything else (shouldn't happen).
  return realRequire(id);
};

const {
  AllStak,
  installReactNative,
  tryAutoInstrumentNavigation,
  __resetAutoNavigationFlagForTest,
  __resetConsoleInstrumentationFlagForTest,
  instrumentReactNavigation,
} = await import('../dist/index.mjs');

// We'll need React + test renderer for the patched-container test.
const React = realRequire('react');
const { default: TestRenderer, act } = await import('react-test-renderer');

function fresh() {
  AllStak.destroy();
  __resetConsoleInstrumentationFlagForTest();
  fakeRNavModule = null;
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
}

// ───────────────────────────────────────────────────────────────
// 1. Package not installed → no-op, no crash
// ───────────────────────────────────────────────────────────────

test('tryAutoInstrumentNavigation returns false when @react-navigation/native is not installed', () => {
  fresh();
  fakeRNavModule = null;
  assert.equal(tryAutoInstrumentNavigation(), false);
});

test('installReactNative does NOT throw when @react-navigation/native is missing', () => {
  fresh();
  fakeRNavModule = null;
  // autoNavigationBreadcrumbs is true by default — must silently no-op.
  assert.doesNotThrow(() => installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoConsoleBreadcrumbs: false,
  }));
});

// ───────────────────────────────────────────────────────────────
// 2. Package present → patch installed
// ───────────────────────────────────────────────────────────────

test('tryAutoInstrumentNavigation patches NavigationContainer when package is present', () => {
  fresh();
  // A minimal stand-in for @react-navigation/native's exports.
  function FakeNavigationContainer(props) {
    return React.createElement('div', { 'data-fake': '1' }, props.children);
  }
  fakeRNavModule = { NavigationContainer: FakeNavigationContainer };

  const result = tryAutoInstrumentNavigation();
  assert.equal(result, true);
  assert.notEqual(fakeRNavModule.NavigationContainer, FakeNavigationContainer,
    'NavigationContainer must be replaced by the patched wrapper');
  assert.equal(fakeRNavModule.NavigationContainer.displayName, 'AllStakNavigationContainer');
});

// ───────────────────────────────────────────────────────────────
// 3. Idempotent
// ───────────────────────────────────────────────────────────────

test('tryAutoInstrumentNavigation is idempotent — calling twice does not double-wrap', () => {
  fresh();
  function FakeNavigationContainer() { return null; }
  fakeRNavModule = { NavigationContainer: FakeNavigationContainer };

  const first = tryAutoInstrumentNavigation();
  const wrappedAfterFirst = fakeRNavModule.NavigationContainer;
  const second = tryAutoInstrumentNavigation();
  const wrappedAfterSecond = fakeRNavModule.NavigationContainer;

  assert.equal(first, true);
  assert.equal(second, true);
  assert.equal(wrappedAfterFirst, wrappedAfterSecond,
    'second call must not replace the wrapper a second time');
});

// ───────────────────────────────────────────────────────────────
// 4. Patched container emits breadcrumb on route change
// ───────────────────────────────────────────────────────────────

test('patched NavigationContainer auto-instruments user refs — route changes emit breadcrumbs', async () => {
  fresh();

  // Build a fake NavigationContainer that exposes a navigationRef-like
  // API to whatever ref it receives, and lets the test trigger state
  // changes manually.
  let listeners = new Set();
  let currentRoute = { name: 'Home' };
  function FakeNavigationContainer(props) {
    // The wrapper passes a ref via props.ref — but React.forwardRef
    // converts that into the second arg of the inner render fn, not
    // props.ref. The wrapper uses createElement(Orig, { ref: setRef }).
    // React routes `ref` to the FakeNavigationContainer-as-class-component
    // path... but FakeNavigationContainer is a function component which
    // can't receive refs. So we expose a global hook for the test:
    // the wrapper forwards a callback ref via the special `ref` prop, but
    // function components ignore it. To test the user-ref forwarding, we
    // use a FakeNavigationContainer that grabs the ref via React.useImperativeHandle
    // is NOT possible without forwardRef. Simpler approach: have the
    // FakeNavigationContainer forward its own ref via React.forwardRef.
    return React.createElement('div', null, props.children);
  }
  const FakeWithForwardRef = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({
      getCurrentRoute: () => currentRoute,
      addListener: (event, cb) => {
        if (event === 'state') listeners.add(cb);
        return () => listeners.delete(cb);
      },
    }), []);
    return FakeNavigationContainer(props);
  });

  fakeRNavModule = { NavigationContainer: FakeWithForwardRef };
  assert.equal(tryAutoInstrumentNavigation(), true);

  const PatchedContainer = fakeRNavModule.NavigationContainer;

  // Mount the patched container with a child.
  let tree;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(PatchedContainer, null,
        React.createElement('span', null, 'app')),
    );
  });

  // useEffect runs → instrumentReactNavigation called → listener attached.
  // Drive a route change.
  currentRoute = { name: 'Profile' };
  act(() => { listeners.forEach((cb) => cb()); });

  // Capture an exception to flush breadcrumbs.
  AllStak.captureException(new Error('after-route-change'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const navCrumbs = (body.breadcrumbs ?? []).filter((c) => c.type === 'navigation');
  const homeProfile = navCrumbs.find((c) => c.message === 'Home -> Profile');
  assert.ok(homeProfile, 'a Home -> Profile breadcrumb must be emitted');
  assert.equal(homeProfile.data.from, 'Home');
  assert.equal(homeProfile.data.to, 'Profile');
  assert.equal(homeProfile.level, 'info');

  act(() => { tree.unmount(); });
});

// ───────────────────────────────────────────────────────────────
// 5. User ref is still forwarded
// ───────────────────────────────────────────────────────────────

test('patched NavigationContainer forwards the user-supplied ref', () => {
  fresh();
  __resetAutoNavigationFlagForTest();

  let exposedToUser = null;
  const FakeWithForwardRef = React.forwardRef((props, ref) => {
    React.useImperativeHandle(ref, () => ({
      getCurrentRoute: () => ({ name: 'X' }),
      addListener: () => () => {},
      __isFakeRef: true,
    }), []);
    return null;
  });
  fakeRNavModule = { NavigationContainer: FakeWithForwardRef };
  assert.equal(tryAutoInstrumentNavigation(), true);

  const Patched = fakeRNavModule.NavigationContainer;
  const userRef = React.createRef();

  let tree;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(Patched, { ref: userRef }, null),
    );
  });

  exposedToUser = userRef.current;
  assert.ok(exposedToUser, 'user ref must be populated');
  assert.equal(exposedToUser.__isFakeRef, true,
    'user ref must point at the underlying FakeWithForwardRef instance');
  act(() => { tree.unmount(); });
});

// ───────────────────────────────────────────────────────────────
// 6. Manual fallback still works
// ───────────────────────────────────────────────────────────────

test('manual instrumentReactNavigation still works regardless of auto-patch state', async () => {
  fresh();
  let listeners = new Set();
  let currentRoute = { name: 'A' };
  const ref = {
    getCurrentRoute: () => currentRoute,
    addListener: (event, cb) => {
      if (event === 'state') listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
  const unsub = instrumentReactNavigation(ref);
  currentRoute = { name: 'B' };
  listeners.forEach((cb) => cb());

  AllStak.captureException(new Error('after-manual-nav'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  const navCrumbs = (body.breadcrumbs ?? []).filter((c) => c.type === 'navigation');
  const found = navCrumbs.find((c) => c.message === 'A -> B');
  assert.ok(found, 'manual instrumentReactNavigation must emit breadcrumbs');
  unsub();
});

// ───────────────────────────────────────────────────────────────
// 7. autoNavigationBreadcrumbs:false skips auto-patch
// ───────────────────────────────────────────────────────────────

test('autoNavigationBreadcrumbs:false skips auto-patching even when package is present', () => {
  fresh();
  function FakeNavigationContainer() { return null; }
  fakeRNavModule = { NavigationContainer: FakeNavigationContainer };

  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoConsoleBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
  });

  // The original FakeNavigationContainer must remain unwrapped.
  assert.equal(fakeRNavModule.NavigationContainer, FakeNavigationContainer);
});

// ───────────────────────────────────────────────────────────────
// 8. autoNavigationBreadcrumbs default ON — installReactNative patches
// ───────────────────────────────────────────────────────────────

test('autoNavigationBreadcrumbs default ON — installReactNative patches when package is present', () => {
  fresh();
  __resetAutoNavigationFlagForTest();
  function FakeNavigationContainer() { return null; }
  fakeRNavModule = { NavigationContainer: FakeNavigationContainer };

  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoConsoleBreadcrumbs: false,
    // autoNavigationBreadcrumbs omitted → defaults to true
  });

  assert.notEqual(fakeRNavModule.NavigationContainer, FakeNavigationContainer);
  assert.equal(fakeRNavModule.NavigationContainer.displayName, 'AllStakNavigationContainer');
});
