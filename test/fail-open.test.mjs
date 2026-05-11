import { test } from 'node:test';
import assert from 'node:assert/strict';

const calls = [];
Object.defineProperty(globalThis, 'fetch', {
  value: async (url, init) => {
    calls.push({ url: String(url), init });
    throw new Error('AllStak DNS failed');
  },
  writable: true,
  configurable: true,
});

const { AllStak } = await import('../dist/index.mjs');

test('public API calls fail open before init', async () => {
  AllStak.destroy();
  assert.doesNotThrow(() => AllStak.captureException(new Error('before init')));
  assert.doesNotThrow(() => AllStak.captureMessage('before init'));
  assert.doesNotThrow(() => AllStak.addBreadcrumb('ui', 'tap'));
  assert.equal(AllStak.getTraceId(), '');
  assert.equal(AllStak.getCurrentSpanId(), null);
  assert.equal(AllStak.getReplay(), null);
  assert.deepEqual(AllStak.getTransportStats(), {
    queued: 0,
    sent: 0,
    failed: 0,
    dropped: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
  });
});

test('missing api key disables telemetry without throwing', async () => {
  calls.length = 0;
  assert.doesNotThrow(() => AllStak.init({ apiKey: '', release: 'r' }));
  assert.doesNotThrow(() => AllStak.captureException(new Error('missing key')));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(calls.length, 0);
  assert.ok(AllStak.getTransportStats().dropped >= 1);
  AllStak.destroy();
});

test('SDK capture fails open when AllStak ingest is unavailable', async () => {
  AllStak.init({ apiKey: 'k', release: 'r' });
  assert.doesNotThrow(() => AllStak.captureException(new Error('mobile fail-open')));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.ok(calls.some((call) => /\/ingest\/v1\/errors$/.test(call.url)));
  assert.ok(AllStak.getTransportStats().failed >= 1);
  AllStak.destroy();
});

test('circuit breaker opens after FAILURE_THRESHOLD failures and short-circuits subsequent sends', async () => {
  let attempts = 0;
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => {
      if (/api\.allstak\.sa/.test(String(url))) {
        attempts++;
        throw new Error('boom');
      }
      return { ok: true, status: 200 };
    },
    writable: true,
    configurable: true,
  });
  AllStak.init({ apiKey: 'k', release: 'r' });
  // Phase 1: send sequentially so each failure is observed before the next dispatch.
  for (let i = 0; i < 5; i++) {
    AllStak.captureException(new Error(`primer ${i}`));
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const phase1Attempts = attempts;
  const stats1 = AllStak.getTransportStats();
  assert.ok(stats1.consecutiveFailures >= 3, `consecutive failures recorded (got ${stats1.consecutiveFailures})`);
  assert.ok(stats1.circuitOpenUntil > Date.now(), 'circuit is open');

  // Phase 2: with breaker open, captures must not produce new fetch attempts.
  for (let i = 0; i < 50; i++) AllStak.captureException(new Error(`gated ${i}`));
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(attempts, phase1Attempts, `circuit must short-circuit dispatch (phase1=${phase1Attempts}, total=${attempts})`);
  AllStak.destroy();
});

test('backoff is bounded — circuit close horizon never exceeds 30s', async () => {
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => {
      if (/api\.allstak\.sa/.test(String(url))) throw new Error('HTTP 503');
      return { ok: true, status: 200 };
    },
    writable: true,
    configurable: true,
  });
  AllStak.init({ apiKey: 'k', release: 'r' });
  // Force enough failures to saturate the exponential backoff.
  for (let i = 0; i < 12; i++) AllStak.captureException(new Error(`fail ${i}`));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const stats = AllStak.getTransportStats();
  const horizonMs = stats.circuitOpenUntil - Date.now();
  // 503 path uses BACKOFF_MAX_MS (30s) directly. Allow 100ms slop for clock drift.
  assert.ok(horizonMs <= 30_000 + 100, `backoff bounded; got horizonMs=${horizonMs}`);
  assert.ok(horizonMs > 0, 'circuit should still be open');
  AllStak.destroy();
});

test('queue is bounded — overflow drops and never grows past MAX_BUFFER', async () => {
  // Fail ingestion so everything queues, then verify queue cap.
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => {
      if (/api\.allstak\.sa/.test(String(url))) throw new Error('boom');
      return { ok: true, status: 200 };
    },
    writable: true,
    configurable: true,
  });
  AllStak.init({ apiKey: 'k', release: 'r' });
  // Enqueue well over MAX_BUFFER (100) to force FIFO drop.
  for (let i = 0; i < 250; i++) AllStak.captureException(new Error(`overflow ${i}`));
  await new Promise((resolve) => setTimeout(resolve, 80));
  const stats = AllStak.getTransportStats();
  assert.ok(stats.queued <= 100, `queue must be bounded by MAX_BUFFER; got queued=${stats.queued}`);
  assert.ok(stats.dropped > 0, 'overflow must record dropped count');
  AllStak.destroy();
});

test('screenshot provider is opt-in, bounded, and fail-open', async () => {
  calls.length = 0;
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url, init) => {
      calls.push({ url: String(url), init });
      return { ok: true, status: 202 };
    },
    writable: true,
    configurable: true,
  });

  AllStak.init({
    apiKey: 'k',
    release: 'r',
    screenshot: {
      enabled: true,
      maxBytes: 1024,
      provider: async () => ({
        data: 'data:image/png;base64,AAAA',
        contentType: 'image/png',
        width: 10,
        height: 10,
        sizeBytes: 24,
        redacted: true,
        redactionStrategy: 'native-mask',
      }),
    },
  });

  assert.doesNotThrow(() => AllStak.captureException(new Error('mobile screenshot')));
  await new Promise((resolve) => setTimeout(resolve, 30));

  const errorCall = calls.find((call) => /\/ingest\/v1\/errors$/.test(call.url));
  assert.ok(errorCall);
  const body = JSON.parse(errorCall.init.body);
  assert.equal(body.metadata['screenshot.status'], 'captured');
  assert.equal(body.metadata['screenshot.contentType'], 'image/png');
  assert.equal(body.metadata['screenshot.redacted'], true);
  assert.equal(body.metadata['screenshot.redactionStrategy'], 'native-mask');
  AllStak.destroy();
});
