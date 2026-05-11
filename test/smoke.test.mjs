/**
 * Smoke tests for the standalone RN SDK. Run under plain Node (no jsdom):
 * verifies the SDK never references window/document/localStorage during
 * init or capture, and that the public surface behaves.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Ensure no browser globals are present — this run is the React-Native-style
// environment check. If any of these are defined, fail loudly.
for (const banned of ['window', 'document', 'localStorage', 'sessionStorage']) {
  if (typeof globalThis[banned] !== 'undefined') {
    throw new Error(`Test environment must not define ${banned}`);
  }
}

const sent = [];
const mockFetch = async (url, init) => {
  sent.push({ url, init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
// Define as a non-configurable getter so node:test can't restore the
// real fetch between top-level setup and test execution.
Object.defineProperty(globalThis, 'fetch', {
  get() { return mockFetch; },
  configurable: false,
});

const { AllStak } = await import('../dist/index.mjs');

test('init without apiKey fails open and disables transport', async () => {
  sent.length = 0;
  assert.doesNotThrow(() => AllStak.init({}));
  assert.doesNotThrow(() => AllStak.captureException(new Error('no-key')));
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0);
  assert.ok(AllStak.getTransportStats().dropped >= 1);
});

test('init + captureException posts to /ingest/v1/errors with X-AllStak-Key', async () => {
  AllStak.init({ apiKey: 'ask_test_key', environment: 'test', release: 'mobile@1.0.0' });
  AllStak.captureException(new Error('boom'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.match(sent[0].url, /\/ingest\/v1\/errors$/);
  assert.equal(sent[0].init.headers['X-AllStak-Key'], 'ask_test_key');
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'boom');
  assert.equal(body.platform, 'react-native');
  assert.equal(body.sdkName, 'allstak-react-native');
  assert.equal(body.environment, 'test');
  assert.equal(body.release, 'mobile@1.0.0');
});

test('addBreadcrumb is attached to next exception and cleared after', async () => {
  sent.length = 0;
  AllStak.addBreadcrumb('navigation', 'open Home', 'info');
  AllStak.captureException(new Error('after-crumb'));
  await new Promise((r) => setTimeout(r, 10));
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.breadcrumbs.length, 1);
  assert.equal(body.breadcrumbs[0].message, 'open Home');

  sent.length = 0;
  AllStak.captureException(new Error('after-clear'));
  await new Promise((r) => setTimeout(r, 10));
  const body2 = JSON.parse(sent[0].init.body);
  assert.equal(body2.breadcrumbs, undefined);
});

test('setUser / setTag / setIdentity flow through wire payload', async () => {
  sent.length = 0;
  AllStak.setUser({ id: 'u-1', email: 'a@b.com' });
  AllStak.setTag('feature', 'login');
  AllStak.setIdentity({ dist: 'ios-hermes' });
  AllStak.captureException(new Error('with-meta'));
  await new Promise((r) => setTimeout(r, 10));
  const body = JSON.parse(sent[0].init.body);
  assert.deepEqual(body.user, { id: 'u-1', email: 'a@b.com' });
  assert.equal(body.dist, 'ios-hermes');
  assert.equal(body.metadata['feature'], 'login');
});

test('captureMessage routes info → logs and error → both', async () => {
  sent.length = 0;
  AllStak.captureMessage('hello info', 'info');
  AllStak.captureMessage('boom error', 'error');
  await new Promise((r) => setTimeout(r, 10));
  const paths = sent.map((s) => new URL(s.url).pathname);
  // info → logs only (1); error → logs + errors (2). Total 3.
  assert.equal(paths.filter((p) => p === '/ingest/v1/logs').length, 2);
  assert.equal(paths.filter((p) => p === '/ingest/v1/errors').length, 1);
});

test('source code contains no banned browser APIs', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../dist/index.mjs', import.meta.url), 'utf8');
  // Allow `addEventListener?.` on XHR / AppState references; ban window./document./localStorage/sessionStorage member access.
  for (const re of [/\bwindow\./, /\bdocument\./, /\blocalStorage\b/, /\bsessionStorage\b/]) {
    assert.ok(!re.test(src), `dist must not reference ${re}`);
  }
});
