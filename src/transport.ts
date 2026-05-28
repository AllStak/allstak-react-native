/**
 * Fail-open HTTP transport for React Native. Telemetry sends are best-effort:
 * they use a short timeout, never reject into the host app, and fall into a
 * bounded in-memory ring buffer with circuit-breaker backoff when AllStak is
 * unavailable.
 *
 * No window, no AbortController fallback shims — RN exposes both natively.
 *
 * Offline durability (0.5.12+): when an event still can't be delivered after
 * the in-memory ring buffer (network outage, retries exhausted, app shutting
 * down), the ALREADY-PII-SCRUBBED payload is written to a pluggable persistent
 * store and replayed on the next init through this same transport (so retry /
 * backoff / circuit-breaker behavior is inherited). Session lifecycle calls
 * (/sessions/start, /sessions/end) are excluded — a replayed stale session
 * would skew release-health durations. Fully fail-open: a broken/unwritable
 * store degrades silently to the prior in-memory-only behavior.
 */

import {
  PersistentEventStore,
  type PersistenceOptions,
  type PersistedEntry,
} from './persistence';

declare const __DEV__: boolean | undefined;

const REQUEST_TIMEOUT = 2000;
const MAX_BUFFER = 100;
const FAILURE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

/**
 * Paths that must NEVER be persisted across a restart. Session lifecycle is
 * best-effort live-only: replaying a stale `/sessions/start` or `/sessions/end`
 * after a relaunch would corrupt release-health durations / crash-free rates.
 */
const NON_PERSISTABLE_PATH_PREFIXES = ['/ingest/v1/sessions/'];

function isPersistablePath(path: string): boolean {
  return !NON_PERSISTABLE_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));
}

/**
 * A 4xx (other than 429) is a permanent rejection — the server will never
 * accept this payload, so it must be removed from the persistent store rather
 * than retried forever. Everything else (network error, timeout, 429, 5xx) is
 * transient and stays queued. Status is parsed from the `HTTP <code>` error
 * thrown by {@link HttpTransport.doFetch}; a network error has no status and is
 * therefore treated as transient (keep).
 */
function isPermanentFailure(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const match = /HTTP\s+(\d{3})/.exec(message);
  if (!match) return false;
  const status = Number(match[1]);
  return status >= 400 && status < 500 && status !== 429;
}

interface Pending {
  path: string;
  payload: unknown;
  /** Set when this item originated from the persistent store (drained on init). */
  persistedId?: string;
}

export interface TransportStats {
  queued: number;
  sent: number;
  failed: number;
  dropped: number;
  consecutiveFailures: number;
  circuitOpenUntil: number;
  lastTransportLatencyMs?: number;
  lastFlushDurationMs?: number;
  /** Whether the durable offline queue is active. */
  persistenceEnabled?: boolean;
  /** Entries replayed from the durable store this session and accepted. */
  persistedReplayed?: number;
  /** Persisted entries dropped due to a permanent (4xx non-429) rejection. */
  persistedDropped?: number;
}

export class HttpTransport {
  private buffer: Pending[] = [];
  private inFlight = new Set<Promise<void>>();
  private flushing = false;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private sent = 0;
  private failed = 0;
  private dropped = 0;
  private lastTransportLatencyMs: number | undefined;
  private lastFlushDurationMs: number | undefined;
  /** Persistent offline store (null when offline-queue is disabled). */
  private store: PersistentEventStore | null = null;
  private persistedReplayed = 0;
  private persistedDropped = 0;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private enabled = true,
    persistence?: PersistenceOptions,
  ) {
    if (persistence && persistence.enabled !== false) {
      try {
        this.store = new PersistentEventStore(persistence);
        if (!this.store.isEnabled()) this.store = null;
      } catch {
        // Store construction must never break SDK init.
        this.store = null;
      }
    }
  }

  send(path: string, payload: unknown): Promise<void> {
    if (!this.enabled) {
      this.noteDropped();
      return Promise.resolve();
    }
    this.enqueueOrDispatch({ path, payload });
    return Promise.resolve();
  }

  /**
   * One-shot POST that resolves with the parsed JSON response body. Used
   * by `captureException` to retrieve the server-assigned event id so
   * follow-up attachment uploads can be linked.
   *
   * Fail-open: returns `null` on any error (network, non-2xx, parse).
   * Respects {@link timeoutMs} via `AbortController`. Bounded retries.
   */
  async sendAndRead<T = any>(
    path: string,
    payload: unknown,
    options: { timeoutMs?: number; retries?: number } = {},
  ): Promise<T | null> {
    if (!this.enabled) return null;
    const timeoutMs = options.timeoutMs ?? 5000;
    const retries = Math.max(0, options.retries ?? 1);
    let attempt = 0;
    let lastError: unknown = null;
    while (attempt <= retries) {
      try {
        const url = `${this.baseUrl}${path}`;
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-AllStak-Key': this.apiKey,
            },
            body: JSON.stringify(payload),
            signal: controller.signal,
          });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          const text = await res.text();
          if (!text) return null;
          try { return JSON.parse(text) as T; } catch { return null; }
        } finally {
          clearTimeout(timeoutId);
        }
      } catch (err) {
        lastError = err;
        attempt += 1;
        if (attempt > retries) break;
        // Brief backoff between retries (best-effort).
        await new Promise((r) => setTimeout(r, 200 * attempt));
      }
    }
    if (lastError && typeof __DEV__ !== 'undefined' && __DEV__) {
      // eslint-disable-next-line no-console
      console.warn('[AllStak] sendAndRead failed:', (lastError as Error)?.message);
    }
    return null;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  private enqueueOrDispatch(item: Pending): void {
    if (Date.now() < this.circuitOpenUntil) {
      this.push(item);
      return;
    }
    this.track(this.dispatch(item));
  }

  private track(promise: Promise<void>): void {
    this.inFlight.add(promise);
    promise.finally(() => this.inFlight.delete(promise)).catch(() => undefined);
  }

  private async dispatch(item: Pending): Promise<void> {
    try {
      await this.doFetch(item.path, item.payload);
      this.sent++;
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      this.onDelivered(item);
      this.scheduleFlush();
    } catch (err) {
      this.failed++;
      this.recordFailure(err);
      this.onFailed(item, err);
    }
  }

  /**
   * Called when an item is accepted (2xx). If it came from (or was written to)
   * the persistent store, remove it now that it's safely delivered.
   */
  private onDelivered(item: Pending): void {
    if (item.persistedId && this.store) {
      this.persistedReplayed++;
      void this.store.remove(item.persistedId).catch(() => undefined);
    }
  }

  /**
   * Called when an item failed delivery. Re-queue it in the in-memory buffer
   * (existing behavior) AND, for persistable telemetry, write the
   * already-scrubbed payload to the durable store so it survives a restart.
   * A permanent 4xx (non-429) is dropped from the store instead of retried.
   */
  private onFailed(item: Pending, err: unknown): void {
    if (this.store && isPersistablePath(item.path)) {
      if (isPermanentFailure(err)) {
        // Server will never accept this — drop it, don't keep retrying.
        this.dropped++;
        if (item.persistedId) {
          this.persistedDropped++;
          void this.store.remove(item.persistedId).catch(() => undefined);
        }
        return;
      }
      if (item.persistedId) {
        // Already in the store from a previous launch — keep it for the next
        // drain; just retry in-memory this session.
        this.push(item);
        return;
      }
      // First failure for a live event: persist the scrubbed payload and tag
      // the in-memory copy with its id so a later in-memory 2xx removes the
      // durable entry (no duplicate replay on the next init).
      void this.store
        .persist(item.path, item.payload)
        .then((id) => {
          if (id) item.persistedId = id;
        })
        .catch(() => undefined);
    }
    this.push(item);
  }

  private async doFetch(path: string, payload: unknown): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    const started = Date.now();
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-AllStak-Key': this.apiKey,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } finally {
      clearTimeout(timeoutId);
      this.lastTransportLatencyMs = Date.now() - started;
    }
  }

  private push(item: Pending): void {
    if (this.buffer.length >= MAX_BUFFER) {
      this.buffer.shift();
      this.dropped++;
    }
    this.buffer.push(item);
  }

  private scheduleFlush(): void {
    if (this.flushing || this.buffer.length === 0) return;
    const delay = Math.max(0, this.circuitOpenUntil - Date.now());
    const timer = setTimeout(() => {
      void this.flushBuffer().catch(() => undefined);
    }, delay);
    if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
  }

  private async flushBuffer(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    const started = Date.now();
    try {
      const items = this.buffer.splice(0, this.buffer.length);
      for (const item of items) {
        if (Date.now() < this.circuitOpenUntil) {
          this.push(item);
          continue;
        }
        try {
          await this.doFetch(item.path, item.payload);
          this.sent++;
          this.consecutiveFailures = 0;
          this.circuitOpenUntil = 0;
          this.onDelivered(item);
        } catch (err) {
          this.failed++;
          this.recordFailure(err);
          this.onFailed(item, err);
        }
      }
    } finally {
      this.lastFlushDurationMs = Date.now() - started;
      this.flushing = false;
      if (this.buffer.length > 0) this.scheduleFlush();
    }
  }

  private recordFailure(error: unknown): void {
    this.consecutiveFailures++;
    if (this.consecutiveFailures < FAILURE_THRESHOLD) return;
    const retryAfterMs = retryAfterFromError(error);
    const backoff = retryAfterMs ?? jitteredBackoff(this.consecutiveFailures);
    this.circuitOpenUntil = Date.now() + backoff;
  }

  /**
   * Replay events persisted on a previous launch/outage. Loads the durable
   * store and re-enqueues each entry through the normal transport path so the
   * existing retry / backoff / circuit-breaker applies. Entries are removed
   * from the store only after a 2xx accept (in {@link onDelivered}) or a
   * permanent 4xx (in {@link onFailed}). Fully fail-open and asynchronous — it
   * never blocks init or capture. No-op when the offline queue is disabled.
   *
   * Returns the number of entries scheduled for replay (0 on any failure).
   */
  async drainPersisted(): Promise<number> {
    if (!this.enabled || !this.store) return 0;
    let entries: PersistedEntry[] = [];
    try {
      entries = await this.store.load();
    } catch {
      return 0;
    }
    let scheduled = 0;
    for (const entry of entries) {
      // Defence in depth: never replay a session-lifecycle call even if one
      // somehow landed in the store.
      if (!isPersistablePath(entry.path)) {
        void this.store.remove(entry.id).catch(() => undefined);
        continue;
      }
      this.enqueueOrDispatch({ path: entry.path, payload: entry.payload, persistedId: entry.id });
      scheduled++;
    }
    return scheduled;
  }

  getBufferSize(): number {
    return this.buffer.length;
  }

  noteDropped(count = 1): void {
    this.dropped += Math.max(0, count);
  }

  getStats(): TransportStats {
    return {
      queued: this.buffer.length,
      sent: this.sent,
      failed: this.failed,
      dropped: this.dropped,
      consecutiveFailures: this.consecutiveFailures,
      circuitOpenUntil: this.circuitOpenUntil,
      lastTransportLatencyMs: this.lastTransportLatencyMs,
      lastFlushDurationMs: this.lastFlushDurationMs,
      persistenceEnabled: this.store !== null,
      persistedReplayed: this.persistedReplayed,
      persistedDropped: this.persistedDropped,
    };
  }

  /** @internal — test seam: the durable store, or null when disabled. */
  __getStoreForTest(): PersistentEventStore | null {
    return this.store;
  }

  /**
   * Wait for queued and in-flight telemetry to drain. Resolves `true` if
   * telemetry drains within `timeoutMs` (default 2000ms), `false` otherwise.
   * Useful before navigation away or during native crash drain.
   */
  async flush(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (true) {
      if (this.buffer.length > 0 && !this.flushing && Date.now() >= this.circuitOpenUntil) {
        await this.flushBuffer();
      }
      if (this.buffer.length === 0 && this.inFlight.size === 0 && !this.flushing) {
        return true;
      }
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function jitteredBackoff(failures: number): number {
  const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** Math.min(8, failures - FAILURE_THRESHOLD));
  return Math.floor(exp / 2 + Math.random() * (exp / 2));
}

function retryAfterFromError(error: unknown): number | null {
  const message = error instanceof Error ? error.message : '';
  return /HTTP\s+(429|503)/.test(message) ? BACKOFF_MAX_MS : null;
}
