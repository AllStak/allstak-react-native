/**
 * Minimal HTTP transport for React Native. Uses the global `fetch` (always
 * present in RN >= 0.60) with a 3s timeout. Failed sends fall into a small
 * in-memory ring buffer that we retry on the next successful flush.
 *
 * No window, no AbortController fallback shims — RN exposes both natively.
 */

const REQUEST_TIMEOUT = 3000;
const MAX_BUFFER = 100;

interface Pending {
  path: string;
  payload: unknown;
}

export class HttpTransport {
  private buffer: Pending[] = [];
  private flushing = false;

  constructor(
    private baseUrl: string,
    private apiKey: string,
  ) {}

  async send(path: string, payload: unknown): Promise<void> {
    try {
      await this.doFetch(path, payload);
      await this.flushBuffer();
    } catch {
      if (this.buffer.length >= MAX_BUFFER) this.buffer.shift();
      this.buffer.push({ path, payload });
    }
  }

  private async doFetch(path: string, payload: unknown): Promise<void> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
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
    }
  }

  private async flushBuffer(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;
    this.flushing = true;
    try {
      const items = this.buffer.splice(0, this.buffer.length);
      for (const item of items) {
        try { await this.doFetch(item.path, item.payload); }
        catch { /* drop on retry failure — buffer is best-effort */ }
      }
    } finally {
      this.flushing = false;
    }
  }

  getBufferSize(): number {
    return this.buffer.length;
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
