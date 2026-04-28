/**
 * Tracing tests for @allstak/react-native:
 *   - startSpan creates a Span; finish enqueues with correct shape
 *   - nested startSpan parents to outer
 *   - tracesSampleRate=0 returns a no-op span (never enqueues)
 *   - getTraceId is stable; setTraceId overrides; resetTrace clears
 *   - captureException auto-attaches traceId/spanId to the error metadata
 *   - span batch flushes on threshold and on destroy
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const baseFetch = async (url, init) => {
  sent.push({ url: String(url), init });
  return new Response('{}', { status: 200 });
};
Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

const { AllStak } = await import('../dist/index.mjs');

const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));
const spansFromBody = (body) => JSON.parse(body).spans;
const errorPath = (s) => /\/ingest\/v1\/errors$/.test(s.url);
const spanPath = (s) => /\/ingest\/v1\/spans$/.test(s.url);

test('startSpan creates a span; finish enqueues with correct shape', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', release: 'web@1.0.0', service: 'svc-A' });
  const span = AllStak.startSpan('http.client', { description: 'GET /api', tags: { route: '/api' } });
  await wait(20);
  span.setTag('userId', 'u-1');
  span.finish('ok');

  // Force a flush by destroying the singleton.
  AllStak.destroy();
  await wait(20);

  const spanBatch = sent.find(spanPath);
  assert.ok(spanBatch, 'a span batch must have been sent');
  const spans = spansFromBody(spanBatch.init.body);
  assert.equal(spans.length, 1);
  const s = spans[0];
  assert.equal(s.operation, 'http.client');
  assert.equal(s.description, 'GET /api');
  assert.equal(s.status, 'ok');
  assert.equal(s.tags.route, '/api');
  assert.equal(s.tags.userId, 'u-1');
  assert.equal(s.service, 'svc-A');
  assert.ok(typeof s.traceId === 'string' && s.traceId.length > 0);
  assert.ok(typeof s.spanId === 'string' && s.spanId.length > 0);
  assert.equal(s.parentSpanId, '');
  assert.ok(s.durationMs >= 0);
});

test('nested startSpan parents to outer', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', release: 'r' });
  const outer = AllStak.startSpan('outer');
  const inner = AllStak.startSpan('inner');
  inner.finish();
  outer.finish();
  AllStak.destroy();
  await wait(20);
  const spans = spansFromBody(sent.find(spanPath).init.body);
  const innerSpan = spans.find((s) => s.operation === 'inner');
  const outerSpan = spans.find((s) => s.operation === 'outer');
  assert.equal(innerSpan.parentSpanId, outerSpan.spanId);
  assert.equal(innerSpan.traceId, outerSpan.traceId);
});

test('tracesSampleRate=0 returns a no-op span (never enqueues)', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', release: 'r', tracesSampleRate: 0 });
  for (let i = 0; i < 5; i++) AllStak.startSpan(`op-${i}`).finish();
  AllStak.destroy();
  await wait(20);
  assert.equal(sent.filter(spanPath).length, 0, 'no spans must be sent when sampleRate=0');
});

test('getTraceId is stable; setTraceId overrides; resetTrace clears', async () => {
  AllStak.init({ apiKey: 'k', release: 'r' });
  const t1 = AllStak.getTraceId();
  const t2 = AllStak.getTraceId();
  assert.equal(t1, t2, 'getTraceId must be stable across calls');
  AllStak.setTraceId('00000000-0000-4000-8000-000000000000');
  assert.equal(AllStak.getTraceId(), '00000000-0000-4000-8000-000000000000');
  AllStak.resetTrace();
  const t3 = AllStak.getTraceId();
  assert.notEqual(t3, '00000000-0000-4000-8000-000000000000', 'resetTrace must drop the override');
});

test('captureException auto-attaches traceId and spanId to the error metadata', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', release: 'r' });
  const span = AllStak.startSpan('checkout');
  AllStak.captureException(new Error('payment-failed'));
  span.finish('error');
  AllStak.destroy();
  await wait(30);
  const errorBody = JSON.parse(sent.find(errorPath).init.body);
  assert.ok(errorBody.metadata.traceId, 'traceId must be on the error metadata');
  assert.equal(errorBody.metadata.traceId, span.traceId);
  assert.equal(errorBody.metadata.spanId, span.spanId);
});

test('span batch flushes when batch size threshold (20) is reached', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', release: 'r' });
  for (let i = 0; i < 20; i++) AllStak.startSpan(`op-${i}`).finish();
  await wait(40);
  const spanBatches = sent.filter(spanPath);
  assert.ok(spanBatches.length >= 1, 'a span batch must flush at the 20-span threshold');
  AllStak.destroy();
});
