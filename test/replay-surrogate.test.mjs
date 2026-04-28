/**
 * Privacy-default tests for the React Native replay surrogate.
 *
 * Hard rule (asserted below): without explicit `safeParams`, route params
 * NEVER appear in the recorded payload. Manual checkpoints with arbitrary
 * `data` are recorded as-is — the host app is responsible for not putting
 * sensitive data in those checkpoints (the API surface makes this obvious).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => { sent.push({ url: String(url), init }); return new Response('{}', { status: 200 }); },
  writable: true, configurable: true,
});

const { AllStak } = await import('../dist/index.mjs');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('replay is OFF by default — getReplay() returns null', async () => {
  AllStak.init({ apiKey: 'k' });
  assert.equal(AllStak.getReplay(), null, 'default config must not enable replay');
});

test('replay with sampleRate=1 starts and records screen view + appstate', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', replay: { sampleRate: 1 } });
  const r = AllStak.getReplay();
  assert.ok(r, 'replay must be active when sampleRate=1');
  assert.equal(r.isActive(), true);
  r.recordScreenView('Home');
  r.recordAppState('background');
  r.recordManual('checkout-start', { step: 1 });
  AllStak.destroy();
  await wait(20);
  const replayPayload = sent.find((s) => s.url.endsWith('/ingest/v1/replay'));
  assert.ok(replayPayload, 'a replay batch must have been sent on destroy');
  const body = JSON.parse(replayPayload.init.body);
  assert.equal(body.events.length, 3);
  assert.equal(body.events[0].k, 'screen');
  assert.equal(body.events[0].data.route, 'Home');
});

test('route params are DROPPED unless explicitly listed in safeParams', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', replay: { sampleRate: 1 } });
  const r = AllStak.getReplay();
  r.recordScreenView('Profile', { userId: 'u-1', email: 'x@y.com', creditCard: '4111-1111' });
  AllStak.destroy();
  await wait(20);
  const body = JSON.parse(sent.find((s) => s.url.endsWith('/ingest/v1/replay')).init.body);
  assert.deepEqual(body.events[0].data.params, {},
    'params must be dropped when safeParams is empty (default)');
});

test('safeParams whitelist allows ONLY enumerated keys through', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', replay: { sampleRate: 1, safeParams: ['screenId'] } });
  const r = AllStak.getReplay();
  r.recordScreenView('Profile', { screenId: 'profile-main', userId: 'u-1', email: 'x@y.com' });
  AllStak.destroy();
  await wait(20);
  const body = JSON.parse(sent.find((s) => s.url.endsWith('/ingest/v1/replay')).init.body);
  assert.deepEqual(body.events[0].data.params, { screenId: 'profile-main' },
    'only safeParams keys must survive');
});

test('replay with sampleRate=0 stays inactive — no events sent', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', replay: { sampleRate: 0 } });
  const r = AllStak.getReplay();
  // ReplaySurrogate is constructed but start() returned false.
  // recordScreenView is a no-op when not active.
  r.recordScreenView('Home');
  AllStak.destroy();
  await wait(20);
  const replayPayload = sent.find((s) => s.url.endsWith('/ingest/v1/replay'));
  assert.equal(replayPayload, undefined, 'no replay events must be sent when sampleRate=0');
});
