/**
 * Compatibility API tests for @allstak/react-native:
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

test('event processors can mutate or drop events', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    eventProcessors: [
      (event) => ({ ...event, message: `processed:${event.message}` }),
      (event) => event.message.includes('drop-me') ? null : event,
    ],
  });
  AllStak.captureException(new Error('keep-me'));
  AllStak.captureException(new Error('drop-me'));
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].init.body).message, 'processed:keep-me');
});

test('addEventProcessor registers a runtime processor', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.addEventProcessor((event) => ({
    ...event,
    metadata: { ...(event.metadata ?? {}), runtimeProcessor: true },
  }));
  AllStak.captureException(new Error('runtime-processor'));
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(sent[0].init.body).metadata.runtimeProcessor, true);
});

test('ignoreErrors, allowUrls, and denyUrls filter error events', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    ignoreErrors: [/ignore-this/],
    allowUrls: [/\/allowed\.js/],
    denyUrls: [/\/blocked\.js/],
  });

  const ignored = new Error('ignore-this');
  ignored.stack = 'Error: ignore-this\n    at ignored (https://cdn.example.com/allowed.js:1:1)';
  const denied = new Error('denied');
  denied.stack = 'Error: denied\n    at denied (https://cdn.example.com/blocked.js:1:1)';
  const disallowed = new Error('disallowed');
  disallowed.stack = 'Error: disallowed\n    at disallowed (https://cdn.example.com/other.js:1:1)';
  const allowed = new Error('allowed');
  allowed.stack = 'Error: allowed\n    at allowed (https://cdn.example.com/allowed.js:1:1)';

  AllStak.captureException(ignored);
  AllStak.captureException(denied);
  AllStak.captureException(disallowed);
  AllStak.captureException(allowed);
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(sent.length, 1);
  assert.equal(JSON.parse(sent[0].init.body).message, 'allowed');
});

test('dedupe drops consecutive duplicate events and can be disabled', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  const error = new Error('dupe');
  AllStak.captureException(error);
  AllStak.captureException(error);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, 1);

  sent.length = 0;
  AllStak.init({ apiKey: 'k', dedupe: false });
  const optOutError = new Error('dupe');
  AllStak.captureException(optOutError);
  AllStak.captureException(optOutError);
  await new Promise((r) => setTimeout(r, 80));
  assert.equal(sent.length, 2);
});

test('flush() resolves true when buffer is empty', async () => {
  AllStak.init({ apiKey: 'k' });
  const ok = await AllStak.flush(500);
  assert.equal(ok, true);
});
