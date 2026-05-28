/**
 * Offline / persistent event queue (survive process restart + network outage).
 *
 * Layers under test:
 *   1. PersistentEventStore directly — append, cap/eviction (drop oldest by
 *      count + bytes + age), load/prune, remove, fail-open on a broken adapter.
 *   2. HttpTransport integration — persist on send failure, drain-and-resend on
 *      init, scrub-before-persist (only already-scrubbed payloads reach the
 *      transport, so nothing unredacted hits disk), session calls are NOT
 *      persisted, permanent 4xx drops the entry, graceful no-op when disabled.
 *   3. AllStakClient integration — opt-out flag, fail-open init.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';

process.env.NODE_ENV = 'test';

const {
  AllStak,
  HttpTransport,
  PersistentEventStore,
  setPersistence,
  detectDefaultStorage,
} = await import('../dist/index.mjs');

/** In-memory adapter matching the AsyncStorage/localStorage shape. */
function fakeStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, v); },
    removeItem: (k) => { map.delete(k); },
    raw: (k = 'allstak:offline-queue') => map.get(k) ?? null,
    entries: (k = 'allstak:offline-queue') => {
      const v = map.get(k);
      return v ? JSON.parse(v) : [];
    },
  };
}

/** An adapter that throws on every operation — exercises fail-open. */
function brokenStorage() {
  return {
    getItem: () => { throw new Error('read-only fs'); },
    setItem: () => { throw new Error('read-only fs'); },
    removeItem: () => { throw new Error('read-only fs'); },
  };
}

/** Async adapter (returns Promises) — proves we await storage correctly. */
function asyncStorage(initial = {}) {
  const map = new Map(Object.entries(initial));
  return {
    map,
    getItem: async (k) => (map.has(k) ? map.get(k) : null),
    setItem: async (k, v) => { map.set(k, v); },
    removeItem: async (k) => { map.delete(k); },
    entries: (k = 'allstak:offline-queue') => {
      const v = map.get(k);
      return v ? JSON.parse(v) : [];
    },
  };
}

// ── 1. PersistentEventStore: basic persist + load ──────────────────────────

test('store: persist then load round-trips the entry (oldest first)', async () => {
  const s = fakeStorage();
  const store = new PersistentEventStore({ storage: s });
  await store.persist('/ingest/v1/errors', { message: 'boom', a: 1 });
  await store.persist('/ingest/v1/logs', { message: 'log', b: 2 });
  const loaded = await store.load();
  assert.equal(loaded.length, 2);
  assert.equal(loaded[0].path, '/ingest/v1/errors');
  assert.deepEqual(loaded[0].payload, { message: 'boom', a: 1 });
  assert.equal(loaded[1].path, '/ingest/v1/logs');
});

test('store: remove drops a single entry by id', async () => {
  const s = fakeStorage();
  const store = new PersistentEventStore({ storage: s });
  const id1 = await store.persist('/ingest/v1/errors', { m: 1 });
  await store.persist('/ingest/v1/errors', { m: 2 });
  await store.remove(id1);
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
  assert.deepEqual(loaded[0].payload, { m: 2 });
});

test('store: async (Promise-returning) adapter works', async () => {
  const s = asyncStorage();
  const store = new PersistentEventStore({ storage: s });
  await store.persist('/ingest/v1/errors', { m: 1 });
  const loaded = await store.load();
  assert.equal(loaded.length, 1);
});

// ── 1b. Cap / eviction: drop OLDEST ─────────────────────────────────────────

test('store: count cap evicts the OLDEST entries first', async () => {
  const s = fakeStorage();
  const store = new PersistentEventStore({ storage: s, maxEntries: 3 });
  for (let i = 0; i < 6; i++) await store.persist('/ingest/v1/errors', { i });
  const loaded = await store.load();
  assert.equal(loaded.length, 3, 'capped at maxEntries');
  // Oldest (i=0,1,2) dropped; newest (3,4,5) kept in order.
  assert.deepEqual(loaded.map((e) => e.payload.i), [3, 4, 5]);
});

test('store: byte cap evicts oldest until it fits', async () => {
  const s = fakeStorage();
  // Tiny byte cap forces eviction even under the count cap.
  const store = new PersistentEventStore({ storage: s, maxEntries: 100, maxBytes: 200 });
  for (let i = 0; i < 10; i++) {
    await store.persist('/ingest/v1/errors', { i, blob: 'x'.repeat(50) });
  }
  const loaded = await store.load();
  assert.ok(loaded.length >= 1, 'always keeps at least one');
  assert.ok(loaded.length < 10, 'byte cap dropped older entries');
  const bytes = Buffer.byteLength(s.raw());
  assert.ok(bytes <= 200 || loaded.length === 1, `within byte cap (${bytes})`);
  // Whatever survived is the most-recent suffix.
  const ids = loaded.map((e) => e.payload.i);
  assert.equal(ids[ids.length - 1], 9, 'newest is retained');
});

test('store: max-age eviction prunes expired entries on load', async () => {
  // Pre-seed the store with an entry timestamped well in the past.
  const old = [{ id: 'old-1', path: '/ingest/v1/errors', payload: { m: 'stale' }, ts: Date.now() - 1000 }];
  const s = fakeStorage({ 'allstak:offline-queue': JSON.stringify(old) });
  const store = new PersistentEventStore({ storage: s, maxAgeMs: 100 });
  const loaded = await store.load();
  assert.equal(loaded.length, 0, 'expired entry pruned');
  // And it should be cleaned from storage too.
  assert.equal(s.raw(), null);
});

// ── 1c. Fail-open on a broken / unavailable store ───────────────────────────

test('store: broken adapter never throws and behaves as empty (fail-open)', async () => {
  const store = new PersistentEventStore({ storage: brokenStorage() });
  await assert.doesNotReject(() => store.persist('/ingest/v1/errors', { m: 1 }));
  const loaded = await store.load();
  assert.deepEqual(loaded, []);
  await assert.doesNotReject(() => store.remove('x'));
});

test('store: enabled:false is a no-op', async () => {
  const s = fakeStorage();
  const store = new PersistentEventStore({ storage: s, enabled: false });
  await store.persist('/ingest/v1/errors', { m: 1 });
  assert.equal(s.raw(), null);
  assert.deepEqual(await store.load(), []);
});

// ── 1d. detectDefaultStorage / setPersistence override ──────────────────────

test('setPersistence: global override is used by detectDefaultStorage', () => {
  const s = fakeStorage();
  setPersistence(s);
  try {
    assert.equal(detectDefaultStorage(), s);
  } finally {
    setPersistence(null);
  }
});

test('detectDefaultStorage: falls back to in-memory when nothing is present', () => {
  setPersistence(null);
  const store = detectDefaultStorage();
  // Memory fallback is storage-like and isolated per call.
  assert.equal(typeof store.getItem, 'function');
  store.setItem('k', 'v');
  assert.equal(store.getItem('k'), 'v');
});

test('setPersistence: rejects a non-storage-like value (stays unset)', () => {
  setPersistence({ not: 'a store' });
  assert.equal(detectDefaultStorage().getItem('allstak:offline-queue'), null);
  setPersistence(null);
});

// ── 2. HttpTransport: persist on send failure ───────────────────────────────

/** Install a fetch stub. mode: 'fail' network err, 'ok' 2xx, or a status code. */
function stubFetch(mode) {
  Object.defineProperty(globalThis, 'fetch', {
    value: async () => {
      if (mode === 'fail') throw new Error('network down');
      if (mode === 'ok') return { ok: true, status: 202, text: async () => '' };
      // numeric status
      return { ok: false, status: mode, text: async () => '' };
    },
    writable: true,
    configurable: true,
  });
}

async function settle(ms = 30) { await new Promise((r) => setTimeout(r, ms)); }

/**
 * Track every transport built by a test so we can drain their in-memory
 * buffers in `after()`. A transport whose send failed keeps a retry timer
 * alive that, once another suite installs its own global `fetch` stub, would
 * leak a late request into that suite's `sent` array. Draining here keeps each
 * suite hermetic regardless of file execution order.
 */
const liveTransports = [];
function mkTransport(persistence) {
  const t = new HttpTransport('https://api.allstak.sa', 'key', true, persistence);
  liveTransports.push(t);
  return t;
}

async function quiesceAll() {
  // Permanent 400 ⇒ the transport drops buffered items instead of re-queueing.
  stubFetch(400);
  const deadline = Date.now() + 2000;
  for (const t of liveTransports) {
    while (t.getBufferSize() > 0 && Date.now() < deadline) {
      try { await t.flush(200); } catch { /* ignore */ }
      await settle(40);
    }
  }
  liveTransports.length = 0;
}

test('transport: persists an already-scrubbed payload on send failure', async () => {
  stubFetch('fail');
  const s = fakeStorage();
  const t = mkTransport({ storage: s });
  // The payload reaching the transport is ALREADY scrubbed by the SDK pipeline.
  t.send('/ingest/v1/errors', { message: 'boom', token: '[Filtered]' });
  await settle();
  const persisted = s.entries();
  assert.equal(persisted.length, 1, 'failed event was persisted');
  assert.equal(persisted[0].path, '/ingest/v1/errors');
  // What we persisted is exactly the scrubbed payload — no raw secret.
  assert.equal(persisted[0].payload.token, '[Filtered]');
  assert.ok(!s.raw().includes('supersecret'), 'no unredacted secret hit disk');
});

test('transport: scrub-before-persist — no raw secret value reaches the store', async () => {
  stubFetch('fail');
  const s = fakeStorage();
  const t = mkTransport({ storage: s });
  // Whatever arrives here is post-scrub; simulate the SDK already replacing the
  // secret with the filtered marker. The store must contain ONLY that.
  t.send('/ingest/v1/logs', { message: 'login', password: '[Filtered]', authorization: '[REDACTED]' });
  await settle();
  const raw = s.raw();
  assert.ok(raw && !raw.includes('hunter2'), 'plaintext password never written');
  const e = s.entries()[0];
  assert.equal(e.payload.password, '[Filtered]');
  assert.equal(e.payload.authorization, '[REDACTED]');
});

test('transport: session lifecycle calls are NOT persisted', async () => {
  stubFetch('fail');
  const s = fakeStorage();
  const t = mkTransport({ storage: s });
  t.send('/ingest/v1/sessions/start', { sessionId: 's1', release: 'r' });
  t.send('/ingest/v1/sessions/end', { sessionId: 's1', status: 'ok' });
  t.send('/ingest/v1/errors', { message: 'keep me' });
  await settle();
  const persisted = s.entries();
  assert.equal(persisted.length, 1, 'only the error was persisted');
  assert.equal(persisted[0].path, '/ingest/v1/errors');
  assert.ok(!persisted.some((e) => e.path.includes('/sessions/')), 'no session call persisted');
});

test('transport: permanent 4xx (non-429) does NOT keep retrying / persist', async () => {
  // A drained entry that gets a 400 must be removed from the store.
  const seed = [{ id: 'dead-1', path: '/ingest/v1/errors', payload: { m: 'bad' }, ts: Date.now() }];
  const s = fakeStorage({ 'allstak:offline-queue': JSON.stringify(seed) });
  stubFetch(400);
  const t = mkTransport({ storage: s });
  await t.drainPersisted();
  await settle();
  assert.equal(s.entries().length, 0, 'permanently-rejected entry removed from store');
  assert.equal(t.getStats().persistedDropped, 1);
});

test('transport: 429 stays queued (transient, not permanent)', async () => {
  stubFetch(429);
  const s = fakeStorage();
  const t = mkTransport({ storage: s });
  t.send('/ingest/v1/errors', { message: 'rate-limited' });
  await settle();
  assert.equal(s.entries().length, 1, '429 is transient — kept for replay');
});

// ── 2b. Drain-and-resend on init ────────────────────────────────────────────

test('transport: drainPersisted re-sends persisted events and removes on 2xx', async () => {
  const seed = [
    { id: 'a', path: '/ingest/v1/errors', payload: { m: 1 }, ts: Date.now() },
    { id: 'b', path: '/ingest/v1/logs', payload: { m: 2 }, ts: Date.now() },
  ];
  const s = fakeStorage({ 'allstak:offline-queue': JSON.stringify(seed) });
  const sent = [];
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => { sent.push(String(url)); return { ok: true, status: 202, text: async () => '' }; },
    writable: true,
    configurable: true,
  });
  const t = mkTransport({ storage: s });
  const scheduled = await t.drainPersisted();
  assert.equal(scheduled, 2);
  await settle();
  assert.equal(sent.length, 2, 'both persisted events were re-sent');
  assert.ok(sent.some((u) => u.endsWith('/ingest/v1/errors')));
  assert.ok(sent.some((u) => u.endsWith('/ingest/v1/logs')));
  // Accepted (2xx) ⇒ removed from the durable store.
  assert.equal(s.entries().length, 0, 'store drained after successful replay');
  assert.equal(t.getStats().persistedReplayed, 2);
});

test('transport: drainPersisted keeps entries when the network is still down', async () => {
  const seed = [{ id: 'a', path: '/ingest/v1/errors', payload: { m: 1 }, ts: Date.now() }];
  const s = fakeStorage({ 'allstak:offline-queue': JSON.stringify(seed) });
  stubFetch('fail');
  const t = mkTransport({ storage: s });
  await t.drainPersisted();
  await settle();
  // Still offline ⇒ entry must survive for the NEXT drain.
  assert.equal(s.entries().length, 1, 'entry retained while offline');
});

test('transport: drainPersisted skips & cleans any stray session entry', async () => {
  const seed = [
    { id: 'sess', path: '/ingest/v1/sessions/start', payload: {}, ts: Date.now() },
    { id: 'err', path: '/ingest/v1/errors', payload: { m: 1 }, ts: Date.now() },
  ];
  const s = fakeStorage({ 'allstak:offline-queue': JSON.stringify(seed) });
  const sent = [];
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => { sent.push(String(url)); return { ok: true, status: 202, text: async () => '' }; },
    writable: true,
    configurable: true,
  });
  const t = mkTransport({ storage: s });
  const scheduled = await t.drainPersisted();
  await settle();
  assert.equal(scheduled, 1, 'only the error was scheduled');
  assert.ok(!sent.some((u) => u.includes('/sessions/')), 'session entry never replayed');
  assert.equal(s.entries().length, 0, 'stray session entry cleaned out');
});

// ── 2c. Survive-restart end-to-end (persist in one transport, drain in next) ─

test('transport: events persisted offline survive a "restart" and replay', async () => {
  // Persistent backing store shared across two transport instances = a restart.
  const s = fakeStorage();
  // 1) First "launch": offline, an event fails and is persisted.
  stubFetch('fail');
  const t1 = mkTransport({ storage: s });
  t1.send('/ingest/v1/errors', { message: 'survives' });
  await settle();
  assert.equal(s.entries().length, 1, 'persisted during outage');

  // 2) Second "launch": network back, new transport drains the store.
  const sent = [];
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => { sent.push(String(url)); return { ok: true, status: 202, text: async () => '' }; },
    writable: true,
    configurable: true,
  });
  const t2 = mkTransport({ storage: s });
  await t2.drainPersisted();
  await settle();
  assert.equal(sent.length, 1, 'persisted event replayed on next launch');
  assert.equal(s.entries().length, 0, 'store cleared after replay');
});

// ── 2d. Graceful no-op when the store is unavailable / disabled ──────────────

test('transport: no persistence options ⇒ no durable store (in-memory only)', async () => {
  stubFetch('fail');
  const t = mkTransport();
  t.send('/ingest/v1/errors', { message: 'x' });
  await settle();
  assert.equal(t.getStats().persistenceEnabled, false);
  assert.equal(await t.drainPersisted(), 0, 'drain is a no-op with no store');
});

test('transport: broken store degrades silently (capture never throws)', async () => {
  stubFetch('fail');
  const t = mkTransport({ storage: brokenStorage() });
  assert.doesNotThrow(() => t.send('/ingest/v1/errors', { message: 'x' }));
  await settle();
  await assert.doesNotReject(() => t.drainPersisted());
});

// ── 3. AllStakClient integration: opt-out + fail-open init ───────────────────
//
// These init a real singleton. To avoid leaking late async posts (the runtime
// `/releases` registration + post-drain flush timers) into the shared `fetch`
// stub of OTHER suites, each test settles AFTER destroy() so all pending
// transport work flushes against THIS test's stub.

async function destroyAndDrain() {
  AllStak.destroy();
  await settle(40);
}

test('client: enableOfflineQueue:false disables the durable store', async () => {
  stubFetch('ok');
  const client = AllStak.init({
    apiKey: 'k',
    release: 'rn@1.0.0',
    enableOfflineQueue: false,
    offlineQueue: { storage: fakeStorage() },
  });
  assert.equal(client.getTransportStats().persistenceEnabled, false);
  await destroyAndDrain();
});

test('client: explicit offlineQueue adapter enables persistence under test runtime', async () => {
  stubFetch('ok');
  const s = fakeStorage();
  const client = AllStak.init({
    apiKey: 'k',
    release: 'rn@1.0.0',
    offlineQueue: { storage: s },
  });
  assert.equal(client.getTransportStats().persistenceEnabled, true);
  await destroyAndDrain();
});

test('client: init drains persisted events on next launch (fail-open)', async () => {
  const seed = [{ id: 'x', path: '/ingest/v1/errors', payload: { m: 'replay-me' }, ts: Date.now() }];
  const s = fakeStorage({ 'allstak:offline-queue': JSON.stringify(seed) });
  const sent = [];
  Object.defineProperty(globalThis, 'fetch', {
    value: async (url) => { sent.push(String(url)); return { ok: true, status: 202, text: async () => '' }; },
    writable: true,
    configurable: true,
  });
  AllStak.init({ apiKey: 'k', release: 'rn@1.0.0', offlineQueue: { storage: s } });
  await settle(60);
  assert.ok(sent.some((u) => u.endsWith('/ingest/v1/errors')), 'persisted event replayed on init');
  assert.equal(s.entries().length, 0, 'store drained on init');
  await destroyAndDrain();
});

test('client: a broken persistence adapter never breaks init', async () => {
  stubFetch('ok');
  assert.doesNotThrow(() => {
    AllStak.init({ apiKey: 'k', release: 'rn@1.0.0', offlineQueue: { storage: brokenStorage() } });
  });
  await destroyAndDrain();
});

// Final cleanup: drain every transport built here, tear down any lingering
// singleton + global override, and let pending async transport work settle so
// this suite never leaks a late request into another suite's `fetch` stub.
after(async () => {
  await quiesceAll();
  setPersistence(null);
  try { AllStak.destroy(); } catch { /* ignore */ }
  await settle(60);
});
