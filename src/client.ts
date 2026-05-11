/**
 * Standalone AllStak client for React Native. No browser APIs, no Node APIs —
 * only what RN guarantees: global `fetch`, AbortController, Date, JSON.
 *
 * Surface mirrors the public AllStak API used by mobile apps:
 *   init / captureException / captureMessage / addBreadcrumb / clearBreadcrumbs
 *   setUser / setTag / setIdentity / getSessionId
 */

import { HttpTransport, TransportStats } from './transport';
import { parseStack } from './stack';
import { resolveDebugId } from './utils/debug-id';
import { Scope, mergeScopes } from './scope';
import { TracingModule, Span } from './tracing';
import { ReplaySurrogate, ReplaySurrogateOptions } from './replay-surrogate';
import { HttpRequestModule } from './http-requests';
import type { HttpTrackingOptions } from './http-redact';
import { installHttpInstrumentation, unbindHttpInstrumentation } from './http-instrumentation';
import type { ConsoleCaptureOptions } from './auto-breadcrumbs';

export const INGEST_HOST = 'https://api.allstak.sa';
export const SDK_NAME = 'allstak-react-native';
export const SDK_VERSION = '0.3.1';

export { Scope } from './scope';
export { Span, TracingModule } from './tracing';
export type { SpanData } from './tracing';

const ERRORS_PATH = '/ingest/v1/errors';
const LOGS_PATH = '/ingest/v1/logs';

const VALID_BREADCRUMB_TYPES = new Set(['http', 'log', 'ui', 'navigation', 'query', 'default']);
const VALID_BREADCRUMB_LEVELS = new Set(['info', 'warn', 'error', 'debug']);
const DEFAULT_MAX_BREADCRUMBS = 50;

export interface AllStakConfig {
  /** Project API key (`ask_live_…`). Required. */
  apiKey: string;
  /** Optional ingest host override; defaults to {@link INGEST_HOST}. */
  host?: string;
  environment?: string;
  release?: string;
  user?: { id?: string; email?: string };
  tags?: Record<string, string>;
  /** Per-event extra data attached to every capture (override per call via context arg). */
  extras?: Record<string, unknown>;
  /** Named context bags (e.g. `app`, `device`). Each lives under `metadata['context.<name>']`. */
  contexts?: Record<string, Record<string, unknown>>;
  /**
   * Default severity level for events that don't specify their own.
   * Affects `captureException` (sets `payload.level`) and the default of
   * `captureMessage`. Customer-set default severity, mirrors `setLevel`.
   */
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  /**
   * Custom grouping fingerprint applied to every event. The backend uses
   * this in place of stack-based grouping. Customer-set grouping override —
   * `setFingerprint`. Pass an empty array or `null` to clear.
   */
  fingerprint?: string[];
  /** Probability in [0, 1] that any new span is recorded. Default 1. */
  tracesSampleRate?: number;
  /** Service name attached to every span (defaults to release if unset). */
  service?: string;
  /**
   * Privacy-first view-state replay surrogate. **Off by default.** Enable
   * with `replay: { sampleRate: 0.1, safeParams: ['screenId'] }`. Captures
   * route names + AppState transitions + manual checkpoints — never inputs
   * or rendered text. See `src/replay-surrogate.ts` for the privacy contract.
   */
  replay?: ReplaySurrogateOptions;
  /**
   * Auto-instrument outbound HTTP — wraps `fetch`, `XMLHttpRequest`, and
   * (when present) `axios`. Default: false. Combine with `httpTracking`
   * to control body/header capture and redaction. Idempotent.
   */
  enableHttpTracking?: boolean;
  /**
   * Privacy + capture controls for HTTP instrumentation. Bodies and
   * headers are OFF by default; auth headers and sensitive query params
   * are ALWAYS redacted.
   */
  httpTracking?: HttpTrackingOptions;
  /**
   * Per-console-method capture flags. Defaults: warn + error captured,
   * log + info NOT captured (to avoid breadcrumb spam from typical app
   * logging). Set `{ log: true, info: true }` to opt-in.
   */
  captureConsole?: ConsoleCaptureOptions;
  maxBreadcrumbs?: number;
  /**
   * Probability in [0, 1] that any given error is sent. Default: 1 (no sampling).
   * Applied per event before {@link beforeSend}.
   */
  sampleRate?: number;
  /**
   * Mutate or drop an event before it is sent. Return `null` (or a falsy
   * value) to drop. Sync or async. Errors thrown inside the hook are caught
   * — the event is sent as-is so a buggy hook can't black-hole telemetry.
   */
  beforeSend?: (event: ErrorIngestPayload) =>
    | ErrorIngestPayload | null | undefined
    | Promise<ErrorIngestPayload | null | undefined>;
  /**
   * Optional fail-open screenshot capture. Off by default and provider-based
   * so Expo/RN apps choose their own native or JS screenshot implementation.
   * The SDK bounds timeout/size/sampling and drops screenshots before it can
   * hurt app navigation, JS thread responsiveness, or telemetry delivery.
   */
  screenshot?: ScreenshotCaptureOptions;
  /** SDK identity overrides (set automatically by installReactNative). */
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
  dist?: string;
  commitSha?: string;
  branch?: string;
}

export interface ScreenshotArtifact {
  data?: string;
  contentType?: 'image/png' | 'image/jpeg' | 'image/webp';
  width?: number;
  height?: number;
  sizeBytes?: number;
  redacted?: boolean;
  redactionStrategy?: string;
}

export interface ScreenshotCaptureOptions {
  enabled?: boolean;
  captureOnError?: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  sampleRate?: number;
  provider?: (reason: { type: 'error'; error: Error; traceId?: string; requestId?: string }) =>
    | ScreenshotArtifact | null | undefined
    | Promise<ScreenshotArtifact | null | undefined>;
}

export interface Breadcrumb {
  timestamp: string;
  type: string;
  message: string;
  level: string;
  data?: Record<string, unknown>;
}

interface PayloadFrame {
  filename?: string;
  absPath?: string;
  function?: string;
  lineno?: number;
  colno?: number;
  inApp?: boolean;
  platform?: string;
  debugId?: string;
}

export interface ErrorIngestPayload {
  exceptionClass: string;
  message: string;
  stackTrace?: string[];
  frames?: PayloadFrame[];
  platform?: string;
  sdkName?: string;
  sdkVersion?: string;
  dist?: string;
  level: string;
  environment?: string;
  release?: string;
  sessionId?: string;
  traceId?: string;
  spanId?: string;
  parentSpanId?: string;
  requestId?: string;
  replayId?: string;
  service?: string;
  user?: { id?: string; email?: string };
  metadata?: Record<string, unknown>;
  breadcrumbs?: Breadcrumb[];
  fingerprint?: string[];
  debugMeta?: { images: Array<{ type: string; debugId: string }> };
}

function frameToString(f: PayloadFrame): string {
  const fn = f.function && f.function.length > 0 ? f.function : '<anonymous>';
  const file = f.filename || f.absPath || '<anonymous>';
  return `    at ${fn} (${file}:${f.lineno ?? 0}:${f.colno ?? 0})`;
}

function generateId(): string {
  // RFC4122-ish v4 — RN doesn't ship `crypto.randomUUID` reliably across
  // versions, so build one from Math.random. Good enough for session IDs.
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16).padStart(1, '0');
  const seg = (len: number) => Array.from({ length: len }, () => hex(16)).join('');
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${seg(3)}-${seg(12)}`;
}

function stringContextValue(context: Record<string, unknown>, key: string): string | undefined {
  const value = context[key];
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function firstRecentRequestId(recentFailed: ReadonlyArray<{ requestId?: string }>): string | undefined {
  for (let i = recentFailed.length - 1; i >= 0; i--) {
    const requestId = recentFailed[i]?.requestId;
    if (requestId && requestId.trim().length > 0) return requestId;
  }
  return undefined;
}

export class AllStakClient {
  private transport: HttpTransport;
  private config: AllStakConfig;
  private sessionId: string;
  private breadcrumbs: Breadcrumb[] = [];
  private maxBreadcrumbs: number;
  private scopeStack: Scope[] = [];
  private tracing: TracingModule;
  private replay: ReplaySurrogate | null = null;
  private httpRequests: HttpRequestModule | null = null;
  private _instrumentAxios: ((axios: any) => any) | null = null;

  constructor(config: AllStakConfig) {
    this.config = { ...config };
    if (!this.config.environment) this.config.environment = 'production';
    if (!this.config.sdkName) this.config.sdkName = SDK_NAME;
    if (!this.config.sdkVersion) this.config.sdkVersion = SDK_VERSION;
    if (!this.config.platform) this.config.platform = 'react-native';
    this.sessionId = generateId();
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    const baseUrl = (config.host ?? INGEST_HOST).replace(/\/$/, '');
    this.transport = new HttpTransport(baseUrl, config.apiKey ?? '', Boolean(config.apiKey));
    this.tracing = new TracingModule(this.transport, {
      service: config.service ?? config.release ?? '',
      environment: this.config.environment ?? 'production',
      tracesSampleRate: config.tracesSampleRate,
    });
    if (config.replay && (config.replay.enabled ?? true)) {
      try {
        this.replay = new ReplaySurrogate(this.transport, this.sessionId, config.replay);
        this.replay.start();
      } catch { /* never break init */ }
    }
    if (config.enableHttpTracking) {
      try {
        this.httpRequests = new HttpRequestModule(this.transport);
        this.httpRequests.setDefaults({
          environment: this.config.environment,
          release: this.config.release,
          dist: this.config.dist,
          platform: this.config.platform,
          sdkName: this.config.sdkName,
          sdkVersion: this.config.sdkVersion,
        });
        const { instrumentAxios } = installHttpInstrumentation(
          this.httpRequests, config.httpTracking ?? {}, baseUrl,
          {
            tracing: this.tracing,
            replay: this.replay,
            release: this.config.release,
            dist: this.config.dist,
            platform: this.config.platform,
            environment: this.config.environment,
          },
        );
        this._instrumentAxios = instrumentAxios;
      } catch { /* never break init */ }
    }
  }

  /** Access the replay surrogate (or null if not initialized / sampled out). */
  getReplay(): ReplaySurrogate | null { return this.replay; }

  /** Manually instrument an axios instance. No-op when HTTP tracking is off. */
  instrumentAxios<T = any>(axios: T): T {
    return this._instrumentAxios ? (this._instrumentAxios(axios) as T) : axios;
  }
  /** Snapshot of recent failed HTTP requests for error-linking. */
  getRecentFailedHttp() { return this.httpRequests?.getRecentFailed() ?? []; }

  // ── Public API ────────────────────────────────────────────────────

  captureException(error: Error, context?: Record<string, unknown>): void {
    if (!this.passesSampleRate()) return;
    const frames = parseStack(error.stack).map((f) => ({
      ...f,
      platform: this.config.platform,
      debugId: resolveDebugId(f.filename),
    }));

    // Aggregate unique debug-ids into debugMeta.images[] so the
    // symbolicator can match by image-level debugId.
    const debugIdSet = new Set<string>();
    for (const f of frames) if (f.debugId) debugIdSet.add(f.debugId);
    const debugMeta = debugIdSet.size > 0
      ? { images: Array.from(debugIdSet).map((id) => ({ type: 'sourcemap' as const, debugId: id })) }
      : undefined;

    const stackTrace = frames.length > 0 ? frames.map(frameToString) : undefined;

    const currentBreadcrumbs = this.breadcrumbs.length > 0 ? [...this.breadcrumbs] : undefined;
    this.breadcrumbs = [];

    // Prefer an explicit `error.name` override (e.g. native crashes set
    // it to 'NSException'); fall back to constructor name then to 'Error'.
    // `new Error()` always has constructor.name === 'Error', so an explicit
    // name set after construction would otherwise be silently dropped.
    const exceptionClass =
      (error.name && error.name !== 'Error' ? error.name : undefined) ||
      error.constructor?.name ||
      'Error';
    const eff = this.effective();
    const traceContext: Record<string, unknown> = {};
    const recentFailed = this.httpRequests?.getRecentFailed() ?? [];
    const linkedRequest = recentFailed.length > 0 ? recentFailed[recentFailed.length - 1] : undefined;
    if (linkedRequest?.traceId) this.tracing.setTraceId(linkedRequest.traceId);
    const exceptionSpan = linkedRequest ? this.tracing.startSpan('mobile.exception', {
      description: error.message,
      tags: {
        requestId: linkedRequest.requestId,
        exceptionClass,
      },
    }) : null;
    exceptionSpan?.finish('error');
    const traceId = linkedRequest?.traceId ?? this.tracing.getTraceId();
    if (traceId) traceContext.traceId = traceId;
    const spanId = exceptionSpan?.spanId || this.tracing.getCurrentSpanId();
    if (spanId) traceContext.spanId = spanId;
    if (recentFailed.length > 0) {
      traceContext['http.recentFailed'] = recentFailed.map((r) => ({
        method: r.method, url: r.url, statusCode: r.statusCode,
        durationMs: r.durationMs, error: r.error,
        requestId: r.requestId, traceId: r.traceId,
        confidence: r.requestId === linkedRequest?.requestId ? 'inferred' : 'weak',
      }));
      traceContext['http.linkConfidence'] = 'inferred';
    }
    try {
      if (!linkedRequest) throw new Error('no linked request');
      this.replay?.recordTimelineMarker?.('exception', 'exception_captured', {
        exceptionClass,
        message: error.message,
        requestLinkConfidence: linkedRequest ? 'inferred' : 'none',
      }, {
        traceId,
        requestId: linkedRequest?.requestId,
        spanId: spanId ?? undefined,
        release: this.config.release,
        dist: this.config.dist,
      });
    } catch { /* never break capture */ }

    const payload: ErrorIngestPayload = {
      exceptionClass,
      message: error.message,
      stackTrace,
      frames: frames.length > 0 ? frames : undefined,
      debugMeta,
      platform: this.config.platform,
      sdkName: this.config.sdkName,
      sdkVersion: this.config.sdkVersion,
      dist: this.config.dist,
      level: eff.level ?? 'error',
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      traceId: stringContextValue(traceContext, 'traceId'),
      spanId: stringContextValue(traceContext, 'spanId'),
      requestId: linkedRequest?.requestId ?? firstRecentRequestId(recentFailed),
      service: this.config.service,
      user: eff.user,
      metadata: { ...this.buildMetadata(context), ...traceContext },
      breadcrumbs: currentBreadcrumbs,
      fingerprint: eff.fingerprint,
    };

    if (this.shouldCaptureScreenshot()) {
      void this.withScreenshotMetadata(error, payload)
        .then((enriched) => this.sendThroughBeforeSend(enriched))
        .catch(() => this.sendThroughBeforeSend({
          ...payload,
          metadata: { ...(payload.metadata ?? {}), 'screenshot.status': 'failed' },
        }));
      return;
    }
    this.sendThroughBeforeSend({
      ...payload,
      metadata: {
        ...(payload.metadata ?? {}),
        'screenshot.status': this.config.screenshot?.enabled ? 'unsupported' : 'disabled',
      },
    });
  }

  /** Start a new span. Auto-parented to any currently-active span. */
  startSpan(operation: string, options?: { description?: string; tags?: Record<string, string> }): Span {
    return this.tracing.startSpan(operation, options);
  }
  /** Get (and lazily create) the active trace ID. */
  getTraceId(): string { return this.tracing.getTraceId(); }
  /** Override the active trace ID, e.g. from an inbound request header. */
  setTraceId(traceId: string): void { this.tracing.setTraceId(traceId); }
  /** ID of the currently-active span, or null. */
  getCurrentSpanId(): string | null { return this.tracing.getCurrentSpanId(); }
  /** Reset the trace ID and the active span stack. */
  resetTrace(): void { this.tracing.resetTrace(); }

  captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
    options: { as?: 'log' | 'error' | 'both' } = {},
  ): void {
    const as = options.as ?? (level === 'fatal' || level === 'error' ? 'both' : 'log');
    if (as === 'log' || as === 'both') {
      this.sendLog(level === 'warning' ? 'warn' : level, message);
    }
    if (as === 'error' || as === 'both') {
      if (!this.passesSampleRate()) return;
      const eff = this.effective();
      const payload: ErrorIngestPayload = {
        exceptionClass: 'Message',
        message,
        platform: this.config.platform,
        sdkName: this.config.sdkName,
        sdkVersion: this.config.sdkVersion,
        dist: this.config.dist,
        level,
        environment: this.config.environment,
        release: this.config.release,
        sessionId: this.sessionId,
        traceId: this.tracing.getTraceId(),
        spanId: this.tracing.getCurrentSpanId() ?? undefined,
        service: this.config.service,
        user: eff.user,
        metadata: this.buildMetadata(),
        fingerprint: eff.fingerprint,
      };
      this.sendThroughBeforeSend(payload);
    }
  }

  addBreadcrumb(
    type: string,
    message: string,
    level?: string,
    data?: Record<string, unknown>,
  ): void {
    const crumb: Breadcrumb = {
      timestamp: new Date().toISOString(),
      type: VALID_BREADCRUMB_TYPES.has(type) ? type : 'default',
      message,
      level: level && VALID_BREADCRUMB_LEVELS.has(level) ? level : 'info',
      ...(data ? { data } : {}),
    };
    if (this.breadcrumbs.length >= this.maxBreadcrumbs) this.breadcrumbs.shift();
    this.breadcrumbs.push(crumb);
  }

  clearBreadcrumbs(): void {
    this.breadcrumbs = [];
  }

  setUser(user: { id?: string; email?: string }): void {
    this.config.user = user;
  }

  setTag(key: string, value: string): void {
    if (!this.config.tags) this.config.tags = {};
    this.config.tags[key] = value;
  }

  /** Bulk-set tags. Merges with existing tags. */
  setTags(tags: Record<string, string>): void {
    if (!this.config.tags) this.config.tags = {};
    Object.assign(this.config.tags, tags);
  }

  /** Set a single extra value. */
  setExtra(key: string, value: unknown): void {
    if (!this.config.extras) this.config.extras = {};
    this.config.extras[key] = value;
  }

  /** Bulk-set extras. Merges with existing extras. */
  setExtras(extras: Record<string, unknown>): void {
    if (!this.config.extras) this.config.extras = {};
    Object.assign(this.config.extras, extras);
  }

  /**
   * Attach a named context bag (e.g. `app`, `device`, `runtime`) — appears
   * under `metadata['context.<name>']` on every subsequent event. Pass
   * `null` to remove a previously-set context.
   */
  setContext(name: string, ctx: Record<string, unknown> | null): void {
    if (!this.config.contexts) this.config.contexts = {};
    if (ctx === null) delete this.config.contexts[name];
    else this.config.contexts[name] = ctx;
  }

  /**
   * Wait for the in-flight retry-buffer to drain. Resolves `true` if the
   * buffer empties within `timeoutMs` (default 2000ms), `false` otherwise.
   */
  flush(timeoutMs?: number): Promise<boolean> {
    return this.transport.flush(timeoutMs);
  }

  /** Set the default severity level applied to subsequent captures. */
  setLevel(level: 'fatal' | 'error' | 'warning' | 'info' | 'debug'): void {
    this.config.level = level;
  }

  /**
   * Set a custom grouping fingerprint applied to subsequent events.
   * Pass `null` or an empty array to clear and revert to default grouping.
   */
  setFingerprint(fingerprint: string[] | null): void {
    this.config.fingerprint = fingerprint && fingerprint.length > 0 ? fingerprint : undefined;
  }

  setIdentity(identity: { sdkName?: string; sdkVersion?: string; platform?: string; dist?: string }): void {
    if (identity.sdkName) this.config.sdkName = identity.sdkName;
    if (identity.sdkVersion) this.config.sdkVersion = identity.sdkVersion;
    if (identity.platform) this.config.platform = identity.platform;
    if (identity.dist) this.config.dist = identity.dist;
  }

  getSessionId(): string { return this.sessionId; }

  getConfig(): AllStakConfig { return this.config; }

  getTransportStats(): TransportStats { return this.transport.getStats(); }

  destroy(): void {
    this.tracing.destroy();
    if (this.replay) { this.replay.destroy(); this.replay = null; }
    if (this.httpRequests) { this.httpRequests.destroy(); this.httpRequests = null; }
    unbindHttpInstrumentation();
    this._instrumentAxios = null;
    this.breadcrumbs = [];
  }

  // ── Internal ──────────────────────────────────────────────────────

  private sendLog(level: string, message: string): void {
    this.transport.send(LOGS_PATH, {
      timestamp: new Date().toISOString(),
      level,
      message,
      sessionId: this.sessionId,
      environment: this.config.environment,
      release: this.config.release,
      platform: this.config.platform,
      sdkName: this.config.sdkName,
      sdkVersion: this.config.sdkVersion,
      metadata: this.buildMetadata(),
    });
  }

  private shouldCaptureScreenshot(): boolean {
    const screenshot = this.config.screenshot;
    if (!screenshot?.enabled || screenshot.captureOnError === false || !screenshot.provider) return false;
    const sampleRate = screenshot.sampleRate ?? 1;
    return !(sampleRate <= 0 || (sampleRate < 1 && Math.random() >= sampleRate));
  }

  private async withScreenshotMetadata(error: Error, payload: ErrorIngestPayload): Promise<ErrorIngestPayload> {
    const screenshot = this.config.screenshot;
    if (!screenshot?.provider) {
      return { ...payload, metadata: { ...(payload.metadata ?? {}), 'screenshot.status': 'unsupported' } };
    }
    const timeoutMs = Math.max(100, Math.min(screenshot.timeoutMs ?? 1500, 5000));
    const maxBytes = Math.max(1024, screenshot.maxBytes ?? 200_000);
    try {
      const artifact = await Promise.race([
        Promise.resolve(screenshot.provider({
          type: 'error',
          error,
          traceId: payload.traceId,
          requestId: payload.requestId,
        })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (!artifact) {
        return { ...payload, metadata: { ...(payload.metadata ?? {}), 'screenshot.status': 'timeout_or_empty' } };
      }
      const size = artifact.sizeBytes ?? byteSize(artifact.data);
      if (size > maxBytes) {
        this.transport.noteDropped();
        return {
          ...payload,
          metadata: { ...(payload.metadata ?? {}), 'screenshot.status': 'dropped_too_large', 'screenshot.sizeBytes': size },
        };
      }
      return {
        ...payload,
        metadata: {
          ...(payload.metadata ?? {}),
          'screenshot.status': 'captured',
          'screenshot.contentType': artifact.contentType,
          'screenshot.width': artifact.width,
          'screenshot.height': artifact.height,
          'screenshot.sizeBytes': size,
          'screenshot.redacted': artifact.redacted ?? false,
          'screenshot.redactionStrategy': artifact.redactionStrategy,
          ...(artifact.data ? { 'screenshot.data': artifact.data } : {}),
        },
      };
    } catch {
      return { ...payload, metadata: { ...(payload.metadata ?? {}), 'screenshot.status': 'failed' } };
    }
  }

  private passesSampleRate(): boolean {
    const r = this.config.sampleRate;
    if (typeof r !== 'number' || r >= 1) return true;
    if (r <= 0) return false;
    return Math.random() < r;
  }

  /**
   * Returns the effective config layer = base config + every scope on the
   * stack. Inner code reads from this instead of `this.config` directly so
   * scope-only overrides (set inside `withScope`) flow into the wire
   * payload without leaking out of the callback.
   */
  private effective(): AllStakConfig {
    return mergeScopes(this.config, this.scopeStack);
  }

  private buildMetadata(perCallContext?: Record<string, unknown>): Record<string, unknown> {
    const eff = this.effective();
    const out: Record<string, unknown> = {
      ...this.releaseTags(),
      ...eff.tags,
      ...(eff.extras ?? {}),
      ...(perCallContext ?? {}),
    };
    if (eff.contexts) {
      for (const [name, ctx] of Object.entries(eff.contexts)) {
        out[`context.${name}`] = ctx;
      }
    }
    return out;
  }

  /**
   * Run `callback` with a fresh, temporary {@link Scope} that isolates
   * any user/tag/extra/context/fingerprint/level it sets. The scope is
   * popped automatically when the callback returns or throws — including
   * for `Promise`-returning callbacks (the pop runs in `.finally`).
   *
   * Use this on the server to attach per-request context without leaking
   * across concurrent requests.
   */
  withScope<T>(callback: (scope: Scope) => T): T {
    const scope = new Scope();
    this.scopeStack.push(scope);
    let popped = false;
    const pop = () => { if (!popped) { popped = true; this.scopeStack.pop(); } };
    try {
      const result = callback(scope);
      if (result && typeof (result as any).then === 'function') {
        return (result as any).then(
          (v: any) => { pop(); return v; },
          (e: any) => { pop(); throw e; },
        );
      }
      pop();
      return result;
    } catch (err) {
      pop();
      throw err;
    }
  }

  /** Direct access to the topmost active scope, or null. @internal */
  getCurrentScope(): Scope | null {
    return this.scopeStack[this.scopeStack.length - 1] ?? null;
  }

  private async sendThroughBeforeSend(payload: ErrorIngestPayload): Promise<void> {
    let final: ErrorIngestPayload | null | undefined = payload;
    if (this.config.beforeSend) {
      try { final = await this.config.beforeSend(payload); }
      catch { final = payload; /* never let a buggy hook drop telemetry */ }
    }
    if (!final) return;
    this.transport.send(ERRORS_PATH, final);
  }

  private releaseTags(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (this.config.sdkName) out['sdk.name'] = this.config.sdkName;
    if (this.config.sdkVersion) out['sdk.version'] = this.config.sdkVersion;
    if (this.config.platform) out['platform'] = this.config.platform;
    if (this.config.dist) out['dist'] = this.config.dist;
    if (this.config.commitSha) out['commit.sha'] = this.config.commitSha;
    if (this.config.branch) out['commit.branch'] = this.config.branch;
    return out;
  }
}

// ── Public singleton facade ──────────────────────────────────────────

let instance: AllStakClient | null = null;

function maybeInit(): AllStakClient | null {
  return instance;
}

function noopSpan(operation = ''): Span {
  return new Span('', '', '', operation, '', '', '', {}, () => undefined);
}

function emptyStats(): TransportStats {
  return {
    queued: 0,
    sent: 0,
    failed: 0,
    dropped: 0,
    consecutiveFailures: 0,
    circuitOpenUntil: 0,
  };
}

/**
 * Module-level breadcrumb forwarder used by auto-instrumentation wrappers
 * (fetch/console/navigation) so they always target the current `instance`
 * after re-init, and silently no-op when there is none.
 */
export function __safeAddBreadcrumbForInstrumentation(
  type: string,
  message: string,
  level?: string,
  data?: Record<string, unknown>,
): void {
  try { instance?.addBreadcrumb(type, message, level, data); }
  catch { /* never break host */ }
}

export const AllStak = {
  init(config: AllStakConfig): AllStakClient {
    try {
      if (instance) instance.destroy();
      instance = new AllStakClient(config);
      return instance;
    } catch {
      instance = new AllStakClient({ ...config, apiKey: '' });
      return instance;
    }
  },
  captureException(error: Error, context?: Record<string, unknown>): void {
    try { maybeInit()?.captureException(error, context); } catch { /* fail-open */ }
  },
  captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
    options?: { as?: 'log' | 'error' | 'both' },
  ): void {
    try { maybeInit()?.captureMessage(message, level, options); } catch { /* fail-open */ }
  },
  addBreadcrumb(type: string, message: string, level?: string, data?: Record<string, unknown>): void {
    try { maybeInit()?.addBreadcrumb(type, message, level, data); } catch { /* fail-open */ }
  },
  clearBreadcrumbs(): void { try { maybeInit()?.clearBreadcrumbs(); } catch { /* fail-open */ } },
  setUser(user: { id?: string; email?: string }): void { try { maybeInit()?.setUser(user); } catch { /* fail-open */ } },
  setTag(key: string, value: string): void { try { maybeInit()?.setTag(key, value); } catch { /* fail-open */ } },
  setTags(tags: Record<string, string>): void { try { maybeInit()?.setTags(tags); } catch { /* fail-open */ } },
  setExtra(key: string, value: unknown): void { try { maybeInit()?.setExtra(key, value); } catch { /* fail-open */ } },
  setExtras(extras: Record<string, unknown>): void { try { maybeInit()?.setExtras(extras); } catch { /* fail-open */ } },
  setContext(name: string, ctx: Record<string, unknown> | null): void { try { maybeInit()?.setContext(name, ctx); } catch { /* fail-open */ } },
  setLevel(level: 'fatal' | 'error' | 'warning' | 'info' | 'debug'): void { try { maybeInit()?.setLevel(level); } catch { /* fail-open */ } },
  setFingerprint(fingerprint: string[] | null): void { try { maybeInit()?.setFingerprint(fingerprint); } catch { /* fail-open */ } },
  flush(timeoutMs?: number): Promise<boolean> {
    try { return maybeInit()?.flush(timeoutMs) ?? Promise.resolve(true); }
    catch { return Promise.resolve(false); }
  },
  setIdentity(identity: { sdkName?: string; sdkVersion?: string; platform?: string; dist?: string }): void {
    try { maybeInit()?.setIdentity(identity); } catch { /* fail-open */ }
  },
  /**
   * Run `callback` with a fresh scoped context. Any user/tag/extra/context/
   * fingerprint/level set on the passed `Scope` is visible only inside the
   * callback (and any captures made within it). Pop is automatic, including
   * for async callbacks and thrown errors.
   */
  withScope<T>(callback: (scope: Scope) => T): T {
    try {
      const client = maybeInit();
      return client ? client.withScope(callback) : callback(new Scope());
    }
    catch { return callback(new Scope()); }
  },
  startSpan(operation: string, options?: { description?: string; tags?: Record<string, string> }): Span {
    try { return maybeInit()?.startSpan(operation, options) ?? noopSpan(operation); }
    catch { return noopSpan(operation); }
  },
  getTraceId(): string {
    try { return maybeInit()?.getTraceId() ?? ''; } catch { return ''; }
  },
  setTraceId(traceId: string): void { try { maybeInit()?.setTraceId(traceId); } catch { /* fail-open */ } },
  getCurrentSpanId(): string | null {
    try { return maybeInit()?.getCurrentSpanId() ?? null; } catch { return null; }
  },
  resetTrace(): void { try { maybeInit()?.resetTrace(); } catch { /* fail-open */ } },
  /** Access the privacy-first replay surrogate (or null if disabled / sampled out). */
  getReplay(): ReplaySurrogate | null {
    try { return maybeInit()?.getReplay() ?? null; } catch { return null; }
  },
  /** Manually instrument an axios instance. No-op when HTTP tracking is off. */
  instrumentAxios<T = any>(axios: T): T {
    try { return maybeInit()?.instrumentAxios(axios) ?? axios; } catch { return axios; }
  },
  getSessionId(): string {
    try { return maybeInit()?.getSessionId() ?? ''; } catch { return ''; }
  },
  getConfig(): AllStakConfig | null { return instance?.getConfig() ?? null; },
  getTransportStats(): TransportStats {
    try { return maybeInit()?.getTransportStats() ?? emptyStats(); } catch { return emptyStats(); }
  },
  destroy(): void { instance?.destroy(); instance = null; },
  /** @internal — exposed for testing */
  _getInstance(): AllStakClient | null { return instance; },
};

function byteSize(value?: string): number {
  if (!value) return 0;
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  } catch {
    /* ignore */
  }
  return value.length;
}
