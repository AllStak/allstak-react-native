/**
 * Fail-open HTTP transport for React Native. Telemetry sends are best-effort:
 * they use a short timeout, never reject into the host app, and fall into a
 * bounded in-memory ring buffer with circuit-breaker backoff when AllStak is
 * unavailable.
 *
 * No window, no AbortController fallback shims — RN exposes both natively.
 */

const REQUEST_TIMEOUT = 2000;
const MAX_BUFFER = 100;
const FAILURE_THRESHOLD = 3;
const BACKOFF_BASE_MS = 500;
const BACKOFF_MAX_MS = 30_000;

interface Pending {
  path: string;
  payload: unknown;
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
}

export class HttpTransport {
  private buffer: Pending[] = [];
  private flushing = false;
  private consecutiveFailures = 0;
  private circuitOpenUntil = 0;
  private sent = 0;
  private failed = 0;
  private dropped = 0;
  private lastTransportLatencyMs: number | undefined;
  private lastFlushDurationMs: number | undefined;

  constructor(
    private baseUrl: string,
    private apiKey: string,
    private enabled = true,
  ) {}

  send(path: string, payload: unknown): Promise<void> {
    if (!this.enabled) {
      this.noteDropped();
      return Promise.resolve();
    }
    this.enqueueOrDispatch({ path, payload });
    return Promise.resolve();
  }

  private enqueueOrDispatch(item: Pending): void {
    if (Date.now() < this.circuitOpenUntil) {
      this.push(item);
      return;
    }
    void this.dispatch(item).catch(() => undefined);
  }

  private async dispatch(item: Pending): Promise<void> {
    try {
      await this.doFetch(item.path, item.payload);
      this.sent++;
      this.consecutiveFailures = 0;
      this.circuitOpenUntil = 0;
      this.scheduleFlush();
    } catch (err) {
      this.failed++;
      this.recordFailure(err);
      this.push(item);
    }
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
        } catch (err) {
          this.failed++;
          this.recordFailure(err);
          this.push(item);
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
    };
  }

  /**
   * Wait for the in-flight retry-buffer to drain. Resolves `true` if the
   * buffer empties within `timeoutMs` (default 2000ms), `false` otherwise.
   * Useful before navigation away or during native crash drain.
   */
  async flush(timeoutMs = 2000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    await this.flushBuffer();
    while (this.buffer.length > 0 || this.flushing) {
      if (Date.now() >= deadline) return false;
      await new Promise((r) => setTimeout(r, 25));
      await this.flushBuffer();
    }
    return true;
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
