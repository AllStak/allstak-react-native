/**
 * Core-path tests — exercise the critical wiring that production depends on:
 *
 *   1. ErrorUtils integration (installReactNative auto-error capture)
 *   2. Hermes/globalThis unhandled rejection capture
 *   3. Stack parser correctness across V8, Hermes, and Gecko traces
 *   4. Transport offline buffer + retry on next successful send
 *
 * These tests use only Node primitives + the built dist; no React Native
 * runtime is required. They prove the integration glue actually fires the
 * documented capture path, rather than only verifying wire format.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
let failNextN = 0;
const mockFetch = async (url, init) => {
  if (failNextN > 0) {
    failNextN -= 1;
    throw new Error('network');
  }
  sent.push({ url, init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', { get() { return mockFetch; }, configurable: false });

const { AllStak, installReactNative } = await import('../dist/index.mjs');

// ───────────────────────────────────────────────────────────────
// 1. ErrorUtils auto-capture (the core RN integration path)
// ───────────────────────────────────────────────────────────────

test('installReactNative wires ErrorUtils.setGlobalHandler and forwards to captureException', async () => {
  // Install a fake ErrorUtils BEFORE installReactNative — that's how RN exposes it.
  let installedHandler = null;
  let prevHandlerCalled = false;
  const prev = (_e, _f) => { prevHandlerCalled = true; };
  globalThis.ErrorUtils = {
    getGlobalHandler: () => prev,
    setGlobalHandler: (h) => { installedHandler = h; },
  };

  sent.length = 0;
  AllStak.init({ apiKey: 'k', environment: 'test', release: 'mobile@1.0.0' });
  installReactNative({
    autoErrorHandler: true,
    autoPromiseRejections: false,
    autoDeviceTags: false,
    autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false,
  });

  assert.equal(typeof installedHandler, 'function', 'setGlobalHandler must be called');

  // Simulate RN firing the global error handler.
  installedHandler(new Error('boom-from-RN'), true /* isFatal */);
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 1, 'captureException must fire for the unhandled error');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'boom-from-RN');
  assert.equal(body.metadata.source, 'react-native-ErrorUtils');
  assert.equal(body.metadata.fatal, 'true');
  assert.equal(body.platform, 'react-native');
  assert.ok(prevHandlerCalled, 'previous handler must still be invoked (chained)');

  delete globalThis.ErrorUtils;
});

// ───────────────────────────────────────────────────────────────
// 2. Unhandled promise rejection fallback path
// ───────────────────────────────────────────────────────────────

test('installReactNative falls back to globalThis addEventListener for unhandled rejection', async () => {
  // Simulate an environment WITHOUT promise/setimmediate/rejection-tracking
  // (the default in plain Node). Provide a fake addEventListener on globalThis
  // so the SDK can register a handler.
  let registered = null;
  globalThis.addEventListener = (evt, h) => {
    if (evt === 'unhandledrejection') registered = h;
  };

  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  installReactNative({
    autoErrorHandler: false,
    autoPromiseRejections: true,
    autoDeviceTags: false,
    autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false,
  });

  assert.equal(typeof registered, 'function', 'unhandledrejection handler must be registered');

  registered({ reason: new Error('rejected!') });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'rejected!');
  assert.equal(body.metadata.source, 'unhandledRejection');

  delete globalThis.addEventListener;
});

test('unhandled rejection with non-Error reason is wrapped', async () => {
  let registered = null;
  globalThis.addEventListener = (evt, h) => { if (evt === 'unhandledrejection') registered = h; };

  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  installReactNative({
    autoErrorHandler: false,
    autoPromiseRejections: true,
    autoDeviceTags: false,
    autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false,
  });
  registered({ reason: 'string-rejection' });
  await new Promise((r) => setTimeout(r, 50));

  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].init.body).message, 'string-rejection');

  delete globalThis.addEventListener;
});

// ───────────────────────────────────────────────────────────────
// 3. Stack parser correctness
// ───────────────────────────────────────────────────────────────

test('stack parser produces frames for V8 / Hermes traces', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  const err = new Error('boom');
  err.stack = [
    'Error: boom',
    '    at handler (file:///app/src/index.js:42:15)',
    '    at Object.<anonymous> (file:///app/main.js:7:1)',
  ].join('\n');
  AllStak.captureException(err);
  await new Promise((r) => setTimeout(r, 50));

  const body = JSON.parse(sent[0].init.body);
  assert.ok(Array.isArray(body.frames), 'frames must be present');
  assert.equal(body.frames.length, 2);
  assert.equal(body.frames[0].function, 'handler');
  assert.equal(body.frames[0].lineno, 42);
  assert.equal(body.frames[0].colno, 15);
  assert.match(body.frames[0].filename, /\/app\/src\/index\.js$/);
});

test('stack parser handles Gecko-style traces (fn@file:line:col)', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  const err = new Error('gecko');
  err.stack = [
    'doThing@file:///app/lib.js:10:5',
    '@file:///app/main.js:1:1',
  ].join('\n');
  AllStak.captureException(err);
  await new Promise((r) => setTimeout(r, 50));

  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.frames.length, 2);
  assert.equal(body.frames[0].function, 'doThing');
  assert.equal(body.frames[0].lineno, 10);
});

test('stack parser tolerates missing/garbage stacks without crashing', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  const err = new Error('no stack');
  err.stack = undefined;
  AllStak.captureException(err);
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  // No frames is OK — message + no crash is the requirement.
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.frames, undefined);
});

// ───────────────────────────────────────────────────────────────
// 4. Transport offline buffer + retry on next successful send
// ───────────────────────────────────────────────────────────────

test('failed send is buffered and re-sent on next successful capture', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });

  // First capture: fetch fails → payload should be buffered.
  failNextN = 1;
  AllStak.captureException(new Error('first-fail'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, 0, 'first failed send must not appear in sent[]');

  // Second capture: fetch succeeds → its own payload + the buffered one go out.
  AllStak.captureException(new Error('second-success'));
  await new Promise((r) => setTimeout(r, 100));

  const messages = sent.map((s) => JSON.parse(s.init.body).message).sort();
  assert.deepEqual(messages, ['first-fail', 'second-success'].sort(),
    'both the previously-buffered and the new event must reach the server');
});
