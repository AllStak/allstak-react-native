/**
 * Lightweight distributed tracing primitives.
 *
 * A `Span` represents a unit of work — `startSpan('http.client', { description: 'GET /api/users' })`
 * returns a Span; call `span.finish()` when the work completes. Spans
 * batch into the transport's `/ingest/v1/spans` channel and ship every 5s
 * (or when 20 spans accumulate).
 *
 * Trace propagation: each span carries a `traceId` (UUID, generated lazily
 * on first call to `getTraceId()`) and a `spanId`. Nested calls to
 * `startSpan()` automatically inherit the active span as their parent.
 *
 * Sampling: `tracesSampleRate` (config) gates whether `startSpan` actually
 * records anything — drops when `Math.random() >= rate`. The returned
 * Span is a no-op shim in that case so call sites don't need to null-check.
 */

import type { HttpTransport } from './transport';

const SPAN_INGEST_PATH = '/ingest/v1/spans';
const FLUSH_INTERVAL_MS = 5_000;
const BATCH_SIZE_THRESHOLD = 20;

export interface SpanData {
  traceId: string;
  spanId: string;
  parentSpanId: string;
  operation: string;
  op?: string;
  platform?: string;
  description: string;
  status: 'ok' | 'error' | 'timeout';
  durationMs: number;
  startTimeMillis: number;
  endTimeMillis: number;
  service: string;
  environment: string;
  release?: string;
  sessionId?: string;
  sampleRate?: number;
  sampleWeight?: number;
  tags: Record<string, string>;
  measurements?: Record<string, number>;
  attributes?: Record<string, string>;
  data: string;
}

export interface SpanOptions {
  description?: string;
  tags?: Record<string, string>;
  op?: string;
  platform?: string;
  measurements?: Record<string, number>;
  attributes?: Record<string, string | number | boolean | null | undefined>;
  startTimeMillis?: number;
}

function id(): string {
  // Same v4 shape used elsewhere in the SDK — RN doesn't ship
  // crypto.randomUUID reliably across versions.
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16).padStart(1, '0');
  const seg = (len: number) => Array.from({ length: len }, () => hex(16)).join('');
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${seg(3)}-${seg(12)}`;
}

export class Span {
  private _finished = false;
  private _startTimeMillis: number;
  private _data = '';

  constructor(
    private _traceId: string,
    private _spanId: string,
    private _parentSpanId: string,
    private _operation: string,
    private _op: string,
    private _platform: string,
    private _description: string,
    private _service: string,
    private _environment: string,
    private _release: string | undefined,
    private _sessionId: string | undefined,
    private _sampleRate: number,
    private _sampleWeight: number,
    private _tags: Record<string, string>,
    private _measurements: Record<string, number>,
    private _attributes: Record<string, string>,
    private _onFinish: (data: SpanData) => void,
    startTimeMillis?: number,
  ) {
    this._startTimeMillis = startTimeMillis ?? Date.now();
  }

  setTag(key: string, value: string): this { this._tags[key] = value; return this; }
  setData(data: string): this { this._data = data; return this; }
  setDescription(description: string): this { this._description = description; return this; }
  setMeasurement(key: string, value: number): this {
    if (Number.isFinite(value)) this._measurements[key] = value;
    return this;
  }
  setAttribute(key: string, value: string | number | boolean | null | undefined): this {
    if (value != null) this._attributes[key] = String(value);
    return this;
  }

  finish(status: 'ok' | 'error' | 'timeout' = 'ok', endTimeMillis?: number): void {
    if (this._finished) return;
    this._finished = true;
    const end = endTimeMillis ?? Date.now();
    this._onFinish({
      traceId: this._traceId,
      spanId: this._spanId,
      parentSpanId: this._parentSpanId,
      operation: this._operation,
      op: this._op,
      platform: this._platform,
      description: this._description,
      status,
      durationMs: Math.max(0, end - this._startTimeMillis),
      startTimeMillis: this._startTimeMillis,
      endTimeMillis: end,
      service: this._service,
      environment: this._environment,
      release: this._release,
      sessionId: this._sessionId,
      sampleRate: this._sampleRate,
      sampleWeight: this._sampleWeight,
      tags: this._tags,
      measurements: this._measurements,
      attributes: this._attributes,
      data: this._data,
    });
  }

  get traceId(): string { return this._traceId; }
  get spanId(): string { return this._spanId; }
  get isFinished(): boolean { return this._finished; }
}

/** A no-op span returned when `tracesSampleRate` drops the trace. */
class NoopSpan extends Span {
  constructor(traceId: string, spanId: string) {
    super(traceId, spanId, '', '', '', '', '', '', '', undefined, undefined, 0, 0, {}, {}, {}, () => {});
  }
  finish(): void { /* never enqueues anything */ }
}

interface TracingOptions {
  service: string;
  environment: string;
  release?: string;
  sessionId?: string;
  platform?: string;
  /** 0..1 — probability to record a span. Default 1. */
  tracesSampleRate?: number;
  beforeSendSpan?: (span: SpanData) => SpanData | null | undefined;
}

export class TracingModule {
  private spans: SpanData[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private currentTraceId: string | null = null;
  private currentSampled: boolean | null = null;
  private currentSampleRate = 1;
  private spanStack: Span[] = [];
  private destroyed = false;

  constructor(private transport: HttpTransport, private opts: TracingOptions) {
    // Lazy timer — only kick off when the first span finishes, so an app
    // that never traces doesn't pay an interval cost.
  }

  /** Get (and lazily create) the active trace ID. */
  getTraceId(): string {
    if (!this.currentTraceId) {
      this.currentTraceId = id();
      this.ensureSamplingDecision();
    }
    return this.currentTraceId;
  }

  /** Override the active trace ID, e.g. from an inbound request header. */
  setTraceId(traceId: string): void {
    this.currentTraceId = traceId;
    this.ensureSamplingDecision();
  }

  /** Get the active span's ID, or null if no span is active. */
  getCurrentSpanId(): string | null {
    return this.spanStack.length > 0 ? this.spanStack[this.spanStack.length - 1].spanId : null;
  }

  /** Reset both the trace ID and the in-flight span stack. */
  resetTrace(): void {
    this.currentTraceId = null;
    this.currentSampled = null;
    this.currentSampleRate = 1;
    this.spanStack = [];
  }

  /**
   * Start a new span. The returned Span automatically inherits the active
   * span as its parent. If `tracesSampleRate` drops this trace, returns a
   * no-op Span so the call site doesn't have to null-check.
   */
  startSpan(operation: string, options: SpanOptions = {}): Span {
    const traceId = this.getTraceId();
    const spanId = id();
    const parentSpanId = this.getCurrentSpanId() ?? '';

    if (!this.ensureSamplingDecision()) {
      // Sampled out — return a no-op so the public API shape is stable.
      return new NoopSpan(traceId, spanId);
    }

    const attributes: Record<string, string> = {};
    for (const [key, value] of Object.entries(options.attributes ?? {})) {
      if (value != null) attributes[key] = String(value);
    }
    const span = new Span(
      traceId, spanId, parentSpanId,
      operation, options.op ?? operation, options.platform ?? this.opts.platform ?? '',
      options.description ?? '',
      this.opts.service ?? '', this.opts.environment ?? '',
      this.opts.release, this.opts.sessionId,
      this.currentSampleRate, this.currentSampleRate > 0 ? 1 / this.currentSampleRate : 0,
      { ...(options.tags ?? {}) },
      { ...(options.measurements ?? {}) },
      attributes,
      (data) => this.enqueue(data, span),
      options.startTimeMillis,
    );
    this.spanStack.push(span);
    return span;
  }

  private ensureSamplingDecision(): boolean {
    if (this.currentSampled !== null) return this.currentSampled;
    const r = this.opts.tracesSampleRate;
    this.currentSampleRate = typeof r === 'number' ? Math.max(0, Math.min(1, r)) : 1;
    if (this.currentSampleRate >= 1) this.currentSampled = true;
    else if (this.currentSampleRate <= 0) this.currentSampled = false;
    else this.currentSampled = Math.random() < this.currentSampleRate;
    return this.currentSampled;
  }

  private enqueue(data: SpanData, span: Span): void {
    if (this.destroyed) return;
    // Pop the finishing span from the stack (if it's the top — usually is,
    // but tolerate out-of-order finishes from misbehaving callers).
    const idx = this.spanStack.lastIndexOf(span);
    if (idx >= 0) this.spanStack.splice(idx, 1);

    const finalData = this.opts.beforeSendSpan ? this.opts.beforeSendSpan(data) : data;
    if (!finalData) return;

    this.spans.push(finalData);
    if (this.spans.length >= BATCH_SIZE_THRESHOLD) {
      this.flush();
      return;
    }
    if (!this.flushTimer) {
      this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
      (this.flushTimer as any)?.unref?.();
    }
  }

  flush(): void {
    if (this.spans.length === 0) return;
    const batch = this.spans;
    this.spans = [];
    this.transport.send(SPAN_INGEST_PATH, { spans: batch });
  }

  destroy(): void {
    this.destroyed = true;
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    this.flush();
    this.currentTraceId = null;
    this.currentSampled = null;
    this.currentSampleRate = 1;
    this.spanStack = [];
  }
}
