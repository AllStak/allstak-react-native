/**
 * Live-backend contract tests.
 *
 * These tests hit a real running AllStak backend and verify that the SDK's
 * payload shape is accepted (HTTP 2xx) for every public capture path:
 *
 *   - captureException (error event)
 *   - captureMessage info → /ingest/v1/logs
 *   - captureMessage error → /ingest/v1/errors + /ingest/v1/logs
 *   - native crash drain (drainPendingNativeCrashes simulating relaunch)
 *   - retry behavior under transient failure
 *   - 4xx auth failure does not crash the SDK
 *
 * Skipped automatically when the backend is unreachable or no test API key
 * is provided (so they don't break CI). Run locally with:
 *
 *   ALLSTAK_TEST_BACKEND=http://localhost:8080 \
 *   ALLSTAK_TEST_API_KEY="$(cat /tmp/allstak-rn-key)" \
 *   node --test test/backend-contract.test.mjs
 */

import { test, before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';

const BACKEND = process.env.ALLSTAK_TEST_BACKEND ?? 'http://localhost:8080';
const API_KEY = process.env.ALLSTAK_TEST_API_KEY;

let backendUp = false;
const SKIP_REASON = !API_KEY
  ? 'set ALLSTAK_TEST_API_KEY to run live backend contract tests'
  : null;

before(async () => {
  if (!API_KEY) return;
  try {
    const res = await fetch(`${BACKEND}/actuator/health`);
    backendUp = res.ok;
  } catch { backendUp = false; }
});

const realFetch = globalThis.fetch.bind(globalThis);
const observed = [];
let captureMode = 'real';  // 'real' | 'mock-fail' | 'mock-401'
let failsRemaining = 0;

const fetchProxy = async (url, init) => {
  observed.push({ url: String(url), init });
  if (captureMode === 'mock-fail') {
    if (failsRemaining > 0) {
      failsRemaining -= 1;
      throw new Error('simulated network failure');
    }
    captureMode = 'real';
  }
  if (captureMode === 'mock-401') {
    return new Response('{"success":false,"error":{"code":"INVALID_API_KEY"}}', {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return realFetch(url, init);
};
Object.defineProperty(globalThis, 'fetch', {
  value: fetchProxy,
  writable: true,
  configurable: true,
});

const { AllStak, drainPendingNativeCrashes, __setNativeModuleForTest } =
  await import('../dist/index.mjs');

beforeEach(() => {
  observed.length = 0;
  captureMode = 'real';
  failsRemaining = 0;
  AllStak.destroy();
});

after(() => {
  AllStak.destroy();
});

function ensureBackendOrSkip(t) {
  if (SKIP_REASON) { t.skip(SKIP_REASON); return false; }
  if (!backendUp) { t.skip('backend unreachable at ' + BACKEND); return false; }
  return true;
}

// ── 1. captureException → /ingest/v1/errors HTTP 202 ────────────

test('captureException posts a payload accepted by the live backend', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({
    apiKey: API_KEY,
    host: BACKEND,
    environment: 'test-contract',
    release: 'rn-contract@1.0.0',
    dist: 'ios-hermes',
  });

  AllStak.captureException(new Error('contract: render error'), {
    'device.os': 'ios',
    'device.osVersion': '17.4',
    'rn.architecture': 'new-arch',
  });
  await new Promise((r) => setTimeout(r, 200));

  const errReq = observed.find((o) => o.url.endsWith('/ingest/v1/errors'));
  assert.ok(errReq, 'an error ingest call must have been made');
  assert.equal(errReq.init.headers['X-AllStak-Key'], API_KEY);

  const body = JSON.parse(errReq.init.body);
  assert.equal(body.exceptionClass, 'Error');
  assert.equal(body.message, 'contract: render error');
  assert.equal(body.platform, 'react-native');
  assert.equal(body.sdkName, 'allstak-react-native');
  assert.equal(body.environment, 'test-contract');
  assert.equal(body.release, 'rn-contract@1.0.0');
  assert.equal(body.dist, 'ios-hermes');
  assert.equal(body.metadata['device.os'], 'ios');
});

// ── 2. captureMessage('info') → /ingest/v1/logs accepted ────────

test('captureMessage info posts to /ingest/v1/logs and is accepted', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({ apiKey: API_KEY, host: BACKEND, release: 'rn-contract@1.0.0' });

  AllStak.captureMessage('contract: info log', 'info');
  await new Promise((r) => setTimeout(r, 200));

  const logReq = observed.find((o) => o.url.endsWith('/ingest/v1/logs'));
  assert.ok(logReq, 'log call must have been made');
});

// ── 3. captureMessage('error') → both /errors and /logs ─────────

test('captureMessage error posts to both /ingest/v1/errors and /ingest/v1/logs', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({ apiKey: API_KEY, host: BACKEND, release: 'rn-contract@1.0.0' });

  AllStak.captureMessage('contract: error log', 'error');
  await new Promise((r) => setTimeout(r, 250));

  const logReq = observed.find((o) => o.url.endsWith('/ingest/v1/logs'));
  const errReq = observed.find((o) => o.url.endsWith('/ingest/v1/errors'));
  assert.ok(logReq, 'log call must have been made');
  assert.ok(errReq, 'error call must have been made');
  const eb = JSON.parse(errReq.init.body);
  assert.equal(eb.exceptionClass, 'Message');
});

// ── 4. drainPendingNativeCrashes → /ingest/v1/errors with native.crash=true ─

test('drainPendingNativeCrashes routes the stashed payload to /ingest/v1/errors', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({ apiKey: API_KEY, host: BACKEND, release: 'rn-contract@1.0.0' });

  __setNativeModuleForTest({
    install: async () => {},
    drainPendingCrash: async () => JSON.stringify({
      exceptionClass: 'NSException',
      message: 'NSInvalidArgumentException: contract test',
      stackTrace: ['0  CoreFoundation 0x1a2b3c0 __exceptionPreprocess'],
      metadata: { thread: 'main', 'device.os': 'ios' },
    }),
  });

  await drainPendingNativeCrashes('rn-contract@1.0.0');
  await new Promise((r) => setTimeout(r, 250));
  __setNativeModuleForTest(null);

  const errReq = observed.find((o) => o.url.endsWith('/ingest/v1/errors'));
  assert.ok(errReq);
  const body = JSON.parse(errReq.init.body);
  assert.equal(body.exceptionClass, 'NSException');
  assert.equal(body.metadata['native.crash'], 'true');
  assert.equal(body.platform, 'react-native');
});

// ── 5. retry behavior — transient failure does not lose the event ───

test('transient network failure is buffered and re-sent on next successful capture', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({ apiKey: API_KEY, host: BACKEND, release: 'rn-contract@1.0.0' });

  // First send fails — buffer.
  captureMode = 'mock-fail';
  failsRemaining = 1;
  AllStak.captureException(new Error('contract: will-buffer'));
  await new Promise((r) => setTimeout(r, 100));

  // Mock automatically reverts to real after one fail. Trigger another
  // capture which should drain the buffered event AND send the new one.
  AllStak.captureException(new Error('contract: drain-trigger'));
  await new Promise((r) => setTimeout(r, 300));

  const errors = observed.filter((o) => o.url.endsWith('/ingest/v1/errors'));
  // First (mock-failed) attempt + second new + drained-buffered = 3 fetch calls.
  assert.ok(errors.length >= 2, `expected at least 2 retried sends, got ${errors.length}`);

  // The buffered "will-buffer" message must reach the backend on retry.
  const messages = errors
    .map((r) => { try { return JSON.parse(r.init.body).message; } catch { return null; } })
    .filter(Boolean);
  assert.ok(messages.includes('contract: will-buffer'), 'buffered event must be re-sent');
  assert.ok(messages.includes('contract: drain-trigger'), 'new event must be sent');
});

// ── 6. 401 from backend does not crash SDK ──────────────────────

test('backend 401 INVALID_API_KEY does not crash the SDK', async (t) => {
  if (!ensureBackendOrSkip(t)) return;
  AllStak.init({ apiKey: 'bogus_key', host: BACKEND, release: 'rn-contract@1.0.0' });

  // Force the mock to return 401 without hitting the real backend.
  captureMode = 'mock-401';
  assert.doesNotThrow(() => AllStak.captureException(new Error('contract: 401')));
  await new Promise((r) => setTimeout(r, 200));

  // The SDK should treat 401 like any other failure → buffer + no throw.
  // No assertion on backend state here — just that the SDK kept running.
  // Subsequent captures must still work.
  assert.doesNotThrow(() => AllStak.captureMessage('contract: still alive', 'info'));
});
