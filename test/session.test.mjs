/**
 * Release-health session tracking (one session per app-launch).
 *
 * Two layers under test:
 *   1. `SessionTracker` directly (skipNetwork:false) — start/end payload shape +
 *      ok→errored→crashed status transitions, against a fake transport.
 *   2. `AllStakClient` integration — the test-runtime guard suppresses the
 *      network POSTs, status still tracks through captureException, and
 *      `enableAutoSessionTracking:false` opts out entirely.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

// Make the SDK's unit-test runtime guard deterministic regardless of how this
// suite is invoked (`npm test` sets npm_lifecycle_event=test; a bare
// `node --test` does not). isLikelyTestRuntime() also keys off NODE_ENV=test.
process.env.NODE_ENV = 'test';

const { AllStak, SessionTracker, Session } = await import('../dist/index.mjs');

/** Minimal duck-typed transport that records every send() synchronously. */
function fakeTransport({ enabled = true } = {}) {
  const calls = [];
  return {
    calls,
    isEnabled: () => enabled,
    send: (path, payload) => {
      calls.push({ path, payload });
      return Promise.resolve();
    },
  };
}

// ── 1. SessionTracker: start payload shape ─────────────────────────────────

test('start: POSTs /ingest/v1/sessions/start with the full payload shape', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(
    t,
    {
      release: 'app@1.2.3',
      environment: 'staging',
      userId: 'user-7',
      sdkName: 'allstak-react-native',
      sdkVersion: '0.5.11',
      platform: 'react-native',
    },
    { sessionId: 'sess-abc' },
  );
  const session = tracker.start();

  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].path, '/ingest/v1/sessions/start');
  assert.deepEqual(t.calls[0].payload, {
    sessionId: 'sess-abc',
    release: 'app@1.2.3',
    environment: 'staging',
    userId: 'user-7',
    sdkName: 'allstak-react-native',
    sdkVersion: '0.5.11',
    platform: 'react-native',
  });
  assert.equal(session.id, 'sess-abc');
  assert.equal(session.status, 'ok');
});

test('start: userId defaults to null when no user is set', () => {
  const t = fakeTransport();
  new SessionTracker(t, { release: 'r' }, { sessionId: 's1' }).start();
  assert.equal(t.calls[0].payload.userId, null);
});

test('start: never sampled — always sends (no sampleRate gate)', () => {
  const t = fakeTransport();
  new SessionTracker(t, { release: 'r' }, { sessionId: 's1' }).start();
  assert.equal(t.calls.length, 1);
});

test('start: idempotent — second start() does not re-POST', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: 'r' }, { sessionId: 's1' });
  const a = tracker.start();
  const b = tracker.start();
  assert.equal(t.calls.length, 1);
  assert.equal(a.id, b.id);
});

test('start: skips network when release is missing (still tracks in-memory)', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: '' }, { sessionId: 's1' });
  const session = tracker.start();
  assert.equal(t.calls.length, 0);
  assert.ok(session); // status tracking still works
  tracker.recordError();
  assert.equal(session.status, 'errored');
});

test('start: skips network when transport is disabled', () => {
  const t = fakeTransport({ enabled: false });
  new SessionTracker(t, { release: 'r' }, { sessionId: 's1' }).start();
  assert.equal(t.calls.length, 0);
});

test('start: skipNetwork option suppresses POST but keeps tracking', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: 'r' }, { sessionId: 's1', skipNetwork: true });
  const session = tracker.start();
  assert.equal(t.calls.length, 0);
  tracker.recordCrash();
  assert.equal(session.status, 'crashed');
});

// ── 2. SessionTracker: end payload shape + status transitions ──────────────

test('end: ok status when no errors recorded', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: 'r' }, { sessionId: 's1' });
  tracker.start();
  tracker.end();
  const end = t.calls.find((c) => c.path === '/ingest/v1/sessions/end');
  assert.ok(end);
  assert.equal(end.payload.sessionId, 's1');
  assert.equal(end.payload.status, 'ok');
  assert.equal(typeof end.payload.durationMs, 'number');
  assert.ok(end.payload.durationMs >= 0);
});

test('status transition: ok → errored on handled error', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: 'r' }, { sessionId: 's1' });
  tracker.start();
  assert.equal(tracker.current().status, 'ok');
  tracker.recordError();
  assert.equal(tracker.current().status, 'errored');
  tracker.end();
  const end = t.calls.find((c) => c.path === '/ingest/v1/sessions/end');
  assert.equal(end.payload.status, 'errored');
});

test('status transition: ok → errored → crashed (crash overrides errored)', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: 'r' }, { sessionId: 's1' });
  tracker.start();
  tracker.recordError();
  assert.equal(tracker.current().status, 'errored');
  tracker.recordCrash();
  assert.equal(tracker.current().status, 'crashed');
  tracker.end();
  const end = t.calls.find((c) => c.path === '/ingest/v1/sessions/end');
  assert.equal(end.payload.status, 'crashed');
});

test('status: crashed is terminal — a later handled error does not downgrade it', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: 'r' }, { sessionId: 's1' });
  tracker.start();
  tracker.recordCrash();
  tracker.recordError();
  assert.equal(tracker.current().status, 'crashed');
});

test('end: explicit final status overrides accumulated status', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: 'r' }, { sessionId: 's1' });
  tracker.start();
  tracker.recordError();
  tracker.end('crashed');
  const end = t.calls.find((c) => c.path === '/ingest/v1/sessions/end');
  assert.equal(end.payload.status, 'crashed');
});

test('end: idempotent — second end() does not re-POST and current() is null', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: 'r' }, { sessionId: 's1' });
  tracker.start();
  tracker.end();
  const before = t.calls.length;
  tracker.end();
  assert.equal(t.calls.length, before);
  assert.equal(tracker.current(), null);
});

test('recordError/recordCrash after end are no-ops', () => {
  const t = fakeTransport();
  const tracker = new SessionTracker(t, { release: 'r' }, { sessionId: 's1' });
  tracker.start();
  tracker.end();
  assert.doesNotThrow(() => tracker.recordError());
  assert.doesNotThrow(() => tracker.recordCrash());
});

// ── 3. Session model: status semantics (mirrors Java reference) ────────────

test('Session: recordError counts and bumps ok→errored only', () => {
  const s = new Session('s');
  assert.equal(s.status, 'ok');
  s.recordError();
  assert.equal(s.status, 'errored');
  assert.equal(s.getErrorCount(), 1);
});

test('Session: recordCrash is terminal even after errored', () => {
  const s = new Session('s');
  s.recordError();
  s.recordCrash();
  assert.equal(s.status, 'crashed');
});

test('Session: durationMs is non-negative', () => {
  const s = new Session('s');
  assert.ok(s.durationMs() >= 0);
});

// ── 4. AllStakClient integration ───────────────────────────────────────────

test('client: test-runtime guard suppresses session POSTs but tracker exists', async () => {
  const calls = [];
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url, init) => { calls.push({ url: String(url), init }); return { ok: true, status: 202 }; },
    writable: true,
    configurable: true,
  });
  const client = AllStak.init({ apiKey: 'k', host: 'https://api.allstak.sa', release: 'rn@1.0.0' });
  await new Promise((r) => setTimeout(r, 20));
  // Under `npm test`, isLikelyTestRuntime() === true → skipNetwork, so NO
  // /sessions/* POSTs leave the SDK even though the tracker is active.
  assert.ok(!calls.some((c) => /\/ingest\/v1\/sessions\//.test(c.url)), 'no session POST under test runtime');
  assert.ok(client.__getSessionTracker(), 'tracker still created for status tracking');
  AllStak.destroy();
});

test('client: captureException drives session status (ok→errored→crashed)', () => {
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => ({ ok: true, status: 202 }),
    writable: true,
    configurable: true,
  });
  const client = AllStak.init({ apiKey: 'k', release: 'rn@1.0.0' });
  const tracker = client.__getSessionTracker();
  assert.equal(tracker.current().status, 'ok');

  // Handled error → errored.
  AllStak.captureException(new Error('handled'));
  assert.equal(tracker.current().status, 'errored');

  // Unhandled/fatal → crashed.
  AllStak.captureException(new Error('boom'), {}, { mechanism: 'onerror', handled: false });
  assert.equal(tracker.current().status, 'crashed');
  AllStak.destroy();
});

test('client: enableAutoSessionTracking:false opts out (no tracker)', () => {
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => ({ ok: true, status: 202 }),
    writable: true,
    configurable: true,
  });
  const client = AllStak.init({ apiKey: 'k', release: 'rn@1.0.0', enableAutoSessionTracking: false });
  assert.equal(client.__getSessionTracker(), null);
  // captureException must still work and not throw with tracking disabled.
  assert.doesNotThrow(() => AllStak.captureException(new Error('x')));
  AllStak.destroy();
});

test('client: close() / endSession() are fail-open and idempotent', () => {
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => ({ ok: true, status: 202 }),
    writable: true,
    configurable: true,
  });
  AllStak.init({ apiKey: 'k', release: 'rn@1.0.0' });
  assert.doesNotThrow(() => AllStak.endSession());
  assert.doesNotThrow(() => AllStak.close());
  assert.doesNotThrow(() => AllStak.close());
});
