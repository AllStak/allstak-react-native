/**
 * Sentry-parity API tests for @allstak/react-native:
 *   beforeSend / sampleRate / setTags / setExtra(s) / setContext / flush()
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const mockFetch = async (url, init) => {
  sent.push({ url, init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', { get() { return mockFetch; }, configurable: false });

const { AllStak } = await import('../dist/index.mjs');

test('beforeSend can mutate the event', async () => {
  AllStak.init({
    apiKey: 'k',
    beforeSend: (ev) => ({ ...ev, message: `[scrubbed] ${ev.message}` }),
  });
  AllStak.captureException(new Error('secret-token-12345'));
  await new Promise((r) => setTimeout(r, 50));
  const body = JSON.parse(sent.at(-1).init.body);
  assert.match(body.message, /^\[scrubbed\] /);
});

test('beforeSend can drop the event by returning null', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', beforeSend: () => null });
  AllStak.captureException(new Error('drop-me'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0);
});

test('beforeSend supports async hooks', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    beforeSend: async (ev) => { await new Promise((r) => setTimeout(r, 5)); return { ...ev, message: 'async-' + ev.message }; },
  });
  AllStak.captureException(new Error('payload'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(JSON.parse(sent[0].init.body).message, 'async-payload');
});

test('a throwing beforeSend never drops telemetry — sends original payload', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', beforeSend: () => { throw new Error('hook-broken'); } });
  AllStak.captureException(new Error('original'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].init.body).message, 'original');
});

test('sampleRate=0 drops everything', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', sampleRate: 0 });
  for (let i = 0; i < 10; i++) AllStak.captureException(new Error(`e${i}`));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 0);
});

test('sampleRate=1 sends everything', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', sampleRate: 1 });
  for (let i = 0; i < 5; i++) AllStak.captureException(new Error(`e${i}`));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(sent.length, 5);
});

test('setTags merges with existing tags', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', tags: { region: 'eu' } });
  AllStak.setTags({ feature: 'login', tier: 'pro' });
  AllStak.captureException(new Error('e'));
  await new Promise((r) => setTimeout(r, 50));
  const meta = JSON.parse(sent[0].init.body).metadata;
  assert.equal(meta.region, 'eu');
  assert.equal(meta.feature, 'login');
  assert.equal(meta.tier, 'pro');
});

test('setExtra and setExtras land in metadata', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setExtra('cart_id', 'c-42');
  AllStak.setExtras({ ab_bucket: 'B', flag_x: true });
  AllStak.captureException(new Error('e'));
  await new Promise((r) => setTimeout(r, 50));
  const meta = JSON.parse(sent[0].init.body).metadata;
  assert.equal(meta.cart_id, 'c-42');
  assert.equal(meta.ab_bucket, 'B');
  assert.equal(meta.flag_x, true);
});

test('setContext stores under metadata["context.<name>"]', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setContext('app', { version: '1.2.3', startedAt: 'now' });
  AllStak.captureException(new Error('e'));
  await new Promise((r) => setTimeout(r, 50));
  const meta = JSON.parse(sent[0].init.body).metadata;
  assert.deepEqual(meta['context.app'], { version: '1.2.3', startedAt: 'now' });
});

test('setContext(name, null) removes a context bag', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.setContext('app', { v: 1 });
  AllStak.setContext('app', null);
  AllStak.captureException(new Error('e'));
  await new Promise((r) => setTimeout(r, 50));
  const meta = JSON.parse(sent[0].init.body).metadata;
  assert.equal(meta['context.app'], undefined);
});

test('flush() resolves true when buffer is empty', async () => {
  AllStak.init({ apiKey: 'k' });
  const ok = await AllStak.flush(500);
  assert.equal(ok, true);
});
