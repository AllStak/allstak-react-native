/**
 * HTTP request batching + transport for the React Native SDK.
 *
 * Mirrors the wire shape used by `@allstak/js`'s HttpRequestModule so the
 * existing backend ingest endpoint (`/ingest/v1/http-requests`) accepts
 * events from this SDK without a schema change. Adds optional rich fields
 * (headers, bodies, error string) — these ride alongside the existing
 * required fields and are tolerated as additive metadata server-side.
 *
 * Batching:
 *   - flushes on a 5s timer OR when 20 events queue up
 *   - flushes immediately on `destroy()`
 *   - `getRecentFailed(n)` returns the last n failed requests (statusCode
 *     >= 400 OR error set), used by error-linking on the next captureException
 */

import type { HttpTransport } from './transport';

const INGEST_PATH = '/ingest/v1/http-requests';
const FLUSH_INTERVAL_MS = 5_000;
const BATCH_SIZE_THRESHOLD = 20;
const RECENT_FAILED_BUFFER_SIZE = 10;

/** What instrumentation hands to the module per request. */
export interface HttpRequestEvent {
  type: 'http_request';
  method: string;
  url: string;        // already sanitized
  statusCode?: number;
  durationMs: number;
  requestSize?: number;
  responseSize?: number;
  requestBody?: string;
  responseBody?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  error?: string;
  traceId?: string;
}

export interface HttpRequestIngestItem {
  type: 'http_request';
  traceId: string;
  direction: 'outbound';
  method: string;
  // Backend wants host + path separately; we also keep the full sanitized
  // URL alongside in case the consumer wants it.
  host: string;
  path: string;
  url: string;
  statusCode: number;
  durationMs: number;
  requestSize?: number;
  responseSize?: number;
  requestBody?: string;
  responseBody?: string;
  requestHeaders?: Record<string, string>;
  responseHeaders?: Record<string, string>;
  error?: string;
  environment?: string;
  release?: string;
  dist?: string;
  platform?: string;
  'sdk.name'?: string;
  'sdk.version'?: string;
  timestamp: string;
}

interface IngestPayload {
  requests: HttpRequestIngestItem[];
}

interface ModuleDefaults {
  environment?: string;
  release?: string;
  dist?: string;
  platform?: string;
  sdkName?: string;
  sdkVersion?: string;
}

function genTraceId(): string {
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16).padStart(1, '0');
  const seg = (len: number) => Array.from({ length: len }, () => hex(16)).join('');
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${seg(3)}-${seg(12)}`;
}

function splitHostPath(url: string): { host: string; path: string } {
  try {
    const u = new URL(url);
    return { host: u.host, path: u.pathname || '/' };
  } catch {
    // Relative URL — treat the whole thing as path.
    return { host: '', path: url.split('?')[0] };
  }
}

export class HttpRequestModule {
  private queue: HttpRequestIngestItem[] = [];
  private recentFailed: HttpRequestIngestItem[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private destroyed = false;
  private defaults: ModuleDefaults = {};

  constructor(private transport: HttpTransport) {}

  setDefaults(defaults: ModuleDefaults): void {
    this.defaults = { ...this.defaults, ...defaults };
  }

  capture(ev: HttpRequestEvent): void {
    if (this.destroyed) return;
    const { host, path } = splitHostPath(ev.url);
    const item: HttpRequestIngestItem = {
      type: 'http_request',
      traceId: ev.traceId ?? genTraceId(),
      direction: 'outbound',
      method: (ev.method || 'GET').toUpperCase(),
      host,
      path,
      url: ev.url,
      statusCode: ev.statusCode ?? 0,
      durationMs: Math.max(0, Math.floor(ev.durationMs)),
      requestSize: ev.requestSize,
      responseSize: ev.responseSize,
      requestBody: ev.requestBody,
      responseBody: ev.responseBody,
      requestHeaders: ev.requestHeaders,
      responseHeaders: ev.responseHeaders,
      error: ev.error,
      environment: this.defaults.environment,
      release: this.defaults.release,
      dist: this.defaults.dist,
      platform: this.defaults.platform,
      'sdk.name': this.defaults.sdkName,
      'sdk.version': this.defaults.sdkVersion,
      timestamp: new Date().toISOString(),
    };

    this.queue.push(item);
    const isFailed = (item.statusCode >= 400) || !!item.error;
    if (isFailed) {
      this.recentFailed.push(item);
      if (this.recentFailed.length > RECENT_FAILED_BUFFER_SIZE) this.recentFailed.shift();
    }

    if (this.queue.length >= BATCH_SIZE_THRESHOLD) { this.flush(); return; }
    if (!this.flushTimer) this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
  }

  /** Snapshot of the last failed requests for error-linking. Newest last. */
  getRecentFailed(): ReadonlyArray<HttpRequestIngestItem> {
    return this.recentFailed;
  }

  flush(): void {
    if (this.queue.length === 0) return;
    const batch = this.queue;
    this.queue = [];
    const payload: IngestPayload = { requests: batch };
    this.transport.send(INGEST_PATH, payload);
  }

  destroy(): void {
    this.destroyed = true;
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    this.flush();
    this.recentFailed = [];
  }

  /** @internal — for tests. */
  getQueueSize(): number { return this.queue.length; }
}
