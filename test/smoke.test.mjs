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
  const eventId = AllStak.captureException(new Error('boom'));
  assert.match(eventId, /^[0-9a-f-]{36}$/);
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

test('captureMessage creates message events by default', async () => {
  sent.length = 0;
  const infoId = AllStak.captureMessage('hello info', 'info');
  const errorId = AllStak.captureMessage('boom error', 'error');
  assert.match(infoId, /^[0-9a-f-]{36}$/);
  assert.match(errorId, /^[0-9a-f-]{36}$/);
  await new Promise((r) => setTimeout(r, 10));
  const paths = sent.map((s) => new URL(s.url).pathname);
  assert.equal(paths.filter((p) => p === '/ingest/v1/logs').length, 0);
  assert.equal(paths.filter((p) => p === '/ingest/v1/errors').length, 2);
  const bodies = sent.map((s) => JSON.parse(s.init.body));
  assert.deepEqual(bodies.map((b) => b.exceptionClass), ['Message', 'Message']);
  assert.deepEqual(bodies.map((b) => b.level), ['info', 'error']);
});

test('structured logger posts to /ingest/v1/logs with attributes', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'ask_test_key', environment: 'test', release: 'mobile@1.0.0', enableLogs: true });
  AllStak.log('warn', 'hello log', { feature: 'checkout' });
  AllStak.logger.info('info log', { step: 2 });
  await new Promise((r) => setTimeout(r, 10));
  const paths = sent.map((s) => new URL(s.url).pathname);
  assert.equal(paths.filter((p) => p === '/ingest/v1/logs').length, 2);
  assert.equal(paths.filter((p) => p === '/ingest/v1/errors').length, 0);
  const bodies = sent.map((s) => JSON.parse(s.init.body));
  assert.deepEqual(bodies.map((b) => b.level), ['warn', 'info']);
  assert.equal(bodies[0].metadata.feature, 'checkout');
  assert.equal(bodies[1].metadata.step, 2);
});

test('structured logs are gated and filterable', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'ask_test_key', enableLogs: false });
  AllStak.logger.info('disabled');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 0);

  AllStak.init({
    apiKey: 'ask_test_key',
    enableLogs: true,
    beforeSendLog: (log) => log.level === 'info'
      ? null
      : { ...log, message: `[log] ${log.message}`, attributes: { ...log.attributes, filtered: true } },
  });
  AllStak.logger.info('drop');
  AllStak.logger.error('keep');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(sent.length, 1);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, '[log] keep');
  assert.equal(body.metadata.filtered, true);
});

test('captureMessage supports debug and log severities', async () => {
  sent.length = 0;
  AllStak.captureMessage('debug msg', 'debug');
  AllStak.captureMessage('log msg', 'log');
  await new Promise((r) => setTimeout(r, 10));
  const bodies = sent.map((s) => JSON.parse(s.init.body));
  assert.deepEqual(bodies.map((b) => b.level), ['debug', 'log']);
  assert.ok(sent.every((s) => new URL(s.url).pathname === '/ingest/v1/errors'));
});

test('source code contains no banned browser APIs', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../dist/index.mjs', import.meta.url), 'utf8');
  // Allow `addEventListener?.` on XHR / AppState references; ban window./document./localStorage/sessionStorage member access.
  for (const re of [/\bwindow\./, /\bdocument\./, /\blocalStorage\b/, /\bsessionStorage\b/]) {
    assert.ok(!re.test(src), `dist must not reference ${re}`);
  }
});
