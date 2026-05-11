/**
 * Tests for the extended console capture surface:
 *   - warn / error captured by default
 *   - log / info NOT captured by default
 *   - log / info captured when explicitly enabled via captureConsole
 *   - per-method opt-out
 *   - safe stringification: primitives, objects, errors, circular refs
 *   - truncation past 5KB
 *   - breadcrumb shape: type=log, level mapping, data.category=console,
 *     data.method, data.args
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

const {
  AllStak,
  installReactNative,
  __resetConsoleInstrumentationFlagForTest,
} = await import('../dist/index.mjs');

function fresh(captureConsole) {
  AllStak.destroy();
  __resetConsoleInstrumentationFlagForTest();
  sent.length = 0;
  AllStak.init({ apiKey: 'k', captureConsole });
}

function silenceConsole() {
  const restore = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = () => {};
  console.info = () => {};
  console.warn = () => {};
  console.error = () => {};
  return () => {
    console.log = restore.log;
    console.info = restore.info;
    console.warn = restore.warn;
    console.error = restore.error;
  };
}

async function captureAndExtract(triggerErrorMsg = 'flush-marker') {
  AllStak.captureException(new Error(triggerErrorMsg));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent[0].init.body);
  return body.breadcrumbs ?? [];
}

// ───────────────────────────────────────────────────────────────
// Defaults: warn + error captured, log + info NOT
// ───────────────────────────────────────────────────────────────

test('default: console.warn + console.error are captured, log + info are NOT', async () => {
  fresh();  // no captureConsole config
  const restore = silenceConsole();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });

  console.log('debug-line');
  console.info('info-line');
  console.warn('warn-line');
  console.error('error-line');
  restore();

  const crumbs = await captureAndExtract();
  const logCrumbs = crumbs.filter((c) => c.type === 'log');
  const messages = logCrumbs.map((c) => c.message);
  assert.ok(messages.includes('warn-line'));
  assert.ok(messages.includes('error-line'));
  assert.ok(!messages.includes('debug-line'), 'console.log must NOT be captured by default');
  assert.ok(!messages.includes('info-line'), 'console.info must NOT be captured by default');
});

// ───────────────────────────────────────────────────────────────
// Opt-in: log + info captured when enabled
// ───────────────────────────────────────────────────────────────

test('captureConsole={log:true,info:true}: log + info captured at level=info', async () => {
  fresh({ log: true, info: true });
  const restore = silenceConsole();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });

  console.log('debug-line-2');
  console.info('info-line-2');
  restore();

  const crumbs = await captureAndExtract();
  const logCrumb = crumbs.find((c) => c.message === 'debug-line-2');
  const infoCrumb = crumbs.find((c) => c.message === 'info-line-2');
  assert.ok(logCrumb, 'console.log must be captured when log:true');
  assert.equal(logCrumb.level, 'info');
  assert.equal(logCrumb.data.category, 'console');
  assert.equal(logCrumb.data.method, 'log');
  assert.ok(Array.isArray(logCrumb.data.args));
  assert.equal(logCrumb.data.args[0], 'debug-line-2');
  assert.ok(infoCrumb, 'console.info must be captured when info:true');
  assert.equal(infoCrumb.level, 'info');
  assert.equal(infoCrumb.data.method, 'info');
});

// ───────────────────────────────────────────────────────────────
// Per-method opt-out
// ───────────────────────────────────────────────────────────────

test('captureConsole={warn:false,error:false}: warn + error suppressed', async () => {
  fresh({ warn: false, error: false });
  const restore = silenceConsole();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });

  console.warn('should-not-appear');
  console.error('also-should-not-appear');
  restore();

  const crumbs = await captureAndExtract();
  const logCrumbs = crumbs.filter((c) => c.type === 'log');
  assert.equal(logCrumbs.length, 0, 'no log breadcrumbs when both flags are off');
});

test('captureConsole={log:true,warn:false}: only log wrapped; warn passthrough has no breadcrumb', async () => {
  fresh({ log: true, warn: false });
  const restore = silenceConsole();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });

  console.log('captured');
  console.warn('not-captured');
  restore();

  const crumbs = await captureAndExtract();
  const messages = crumbs.filter((c) => c.type === 'log').map((c) => c.message);
  assert.ok(messages.includes('captured'));
  assert.ok(!messages.includes('not-captured'));
});

// ───────────────────────────────────────────────────────────────
// Safe stringification
// ───────────────────────────────────────────────────────────────

test('object args are safely stringified to JSON in data.args', async () => {
  fresh({ log: true });
  const restore = silenceConsole();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });
  console.log('payload', { id: 42, name: 'x' }, [1, 2, 3]);
  restore();

  const crumbs = await captureAndExtract();
  const crumb = crumbs.find((c) => c.message?.startsWith('payload'));
  assert.ok(crumb);
  assert.equal(crumb.data.args[0], 'payload');
  assert.equal(crumb.data.args[1], '{"id":42,"name":"x"}');
  assert.equal(crumb.data.args[2], '[1,2,3]');
});

test('Error args are stringified with name/message and stack snippet', async () => {
  fresh({ log: true });
  const restore = silenceConsole();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });
  console.log(new TypeError('whoops'));
  restore();

  const crumbs = await captureAndExtract();
  const crumb = crumbs.find((c) => c.data?.method === 'log');
  assert.ok(crumb);
  assert.match(crumb.data.args[0], /^TypeError: whoops/);
});

test('circular references do not crash and are tagged [Circular]', async () => {
  fresh({ log: true });
  const restore = silenceConsole();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });

  const cyclic = { name: 'root' };
  cyclic.self = cyclic;
  // Must not throw
  console.log(cyclic);
  restore();

  const crumbs = await captureAndExtract();
  const crumb = crumbs.find((c) => c.data?.method === 'log');
  assert.ok(crumb);
  assert.match(crumb.data.args[0], /\[Circular\]/);
  assert.match(crumb.data.args[0], /"name":"root"/);
});

test('arguments larger than 5KB are truncated with marker', async () => {
  fresh({ log: true });
  const restore = silenceConsole();
  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });

  const huge = 'X'.repeat(8000);
  console.log(huge);
  restore();

  const crumbs = await captureAndExtract();
  const crumb = crumbs.find((c) => c.data?.method === 'log');
  assert.ok(crumb);
  assert.ok(crumb.message.length <= 5000 + '…[truncated]'.length, 'message must be truncated');
  assert.ok(crumb.message.endsWith('…[truncated]'), 'truncation marker must be present');
});

// ───────────────────────────────────────────────────────────────
// Original console fns still receive calls (passthrough)
// ───────────────────────────────────────────────────────────────

test('wrapped methods still call the underlying console method (passthrough)', async () => {
  fresh({ log: true, info: true });

  const calls = [];
  const orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
  };
  console.log = (...a) => calls.push(['log', a.join(' ')]);
  console.info = (...a) => calls.push(['info', a.join(' ')]);
  console.warn = (...a) => calls.push(['warn', a.join(' ')]);
  console.error = (...a) => calls.push(['error', a.join(' ')]);

  installReactNative({
    autoErrorHandler: false, autoPromiseRejections: false,
    autoDeviceTags: false, autoAppStateBreadcrumbs: false,
    autoNetworkCapture: false, autoFetchBreadcrumbs: false,
    autoNavigationBreadcrumbs: false,
    autoConsoleBreadcrumbs: true,
  });

  console.log('a');
  console.info('b');
  console.warn('c');
  console.error('d');

  console.log = orig.log;
  console.info = orig.info;
  console.warn = orig.warn;
  console.error = orig.error;

  assert.deepEqual(calls, [
    ['log', 'a'],
    ['info', 'b'],
    ['warn', 'c'],
    ['error', 'd'],
  ], 'underlying console methods must still be invoked');
});
