/**
 * HTTP request batching + transport for the React Native SDK.
 *
 * Mirrors the wire shape accepted by the backend ingest endpoint
 * (`/ingest/v1/http-requests`). Headers are serialized as JSON strings and
 * body capture metadata uses the backend's `*BodyCapture*` field names.
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
  traceId: string;
  requestId: string;
  spanId?: string;
  parentSpanId?: string;
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
  requestBodyStatus?: string;
  responseBodyStatus?: string;
  requestBodyCaptureStatus?: string;
  responseBodyCaptureStatus?: string;
  requestBodyCaptureReason?: string;
  responseBodyCaptureReason?: string;
  requestBodyRedactedFields?: string[];
  responseBodyRedactedFields?: string[];
  requestBodyTruncated?: boolean;
  responseBodyTruncated?: boolean;
  capturePolicy?: string;
  linkConfidence?: 'exact' | 'inferred' | 'weak' | 'none';
}

export interface HttpRequestIngestItem {
  type: 'http_request';
  traceId: string;
  requestId: string;
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
  requestHeaders?: string;
  responseHeaders?: string;
  error?: string;
  spanId?: string;
  parentSpanId?: string;
  requestBodyCaptureStatus?: string;
  responseBodyCaptureStatus?: string;
  requestBodyCaptureReason?: string;
  responseBodyCaptureReason?: string;
  requestBodyRedactedFields?: string[];
  responseBodyRedactedFields?: string[];
  requestBodyTruncated?: boolean;
  responseBodyTruncated?: boolean;
  capturePolicy?: string;
  linkConfidence?: 'exact' | 'inferred' | 'weak' | 'none';
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

function genRequestId(): string {
  return genTraceId();
}

export function generateHttpId(): string {
  return genTraceId();
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
      requestId: ev.requestId ?? genRequestId(),
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
      requestHeaders: serializeHeaders(ev.requestHeaders),
      responseHeaders: serializeHeaders(ev.responseHeaders),
      error: ev.error,
      spanId: ev.spanId,
      parentSpanId: ev.parentSpanId,
      requestBodyCaptureStatus: normalizeCaptureStatus(ev.requestBodyCaptureStatus ?? ev.requestBodyStatus),
      responseBodyCaptureStatus: normalizeCaptureStatus(ev.responseBodyCaptureStatus ?? ev.responseBodyStatus),
      requestBodyCaptureReason: ev.requestBodyCaptureReason ?? captureReason(ev.requestBodyTruncated, ev.requestBodyRedactedFields, ev.capturePolicy),
      responseBodyCaptureReason: ev.responseBodyCaptureReason ?? captureReason(ev.responseBodyTruncated, ev.responseBodyRedactedFields, ev.capturePolicy),
      requestBodyRedactedFields: ev.requestBodyRedactedFields,
      responseBodyRedactedFields: ev.responseBodyRedactedFields,
      requestBodyTruncated: ev.requestBodyTruncated,
      responseBodyTruncated: ev.responseBodyTruncated,
      capturePolicy: ev.capturePolicy,
      linkConfidence: ev.linkConfidence ?? 'exact',
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
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      (this.flushTimer as any)?.unref?.();
    }
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

function serializeHeaders(headers: Record<string, string> | undefined): string | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;
  try { return JSON.stringify(headers); } catch { return undefined; }
}

function normalizeCaptureStatus(status: string | undefined): string | undefined {
  if (!status) return undefined;
  return status === 'empty' ? 'disabled' : status;
}

function captureReason(
  truncated: boolean | undefined,
  redactedFields: string[] | undefined,
  policy: string | undefined,
): string | undefined {
  if (truncated) return 'Body exceeded the configured size limit and was truncated';
  if (redactedFields && redactedFields.length > 0) return `Sensitive fields redacted: ${redactedFields.join(', ')}`;
  if (policy === 'empty_body') return 'No body was provided for this request';
  if (policy && policy !== 'automatic_body_capture') return policy;
  return undefined;
}
