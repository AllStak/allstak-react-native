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
import { Scope, mergeScopes, type Severity } from './scope';
import { TracingModule, Span, type SpanData, type SpanOptions } from './tracing';
import { ReplaySurrogate, ReplaySurrogateOptions } from './replay-surrogate';
import { HttpRequestModule } from './http-requests';
import type { HttpTrackingOptions } from './http-redact';
import { scrubString, scrubValueTree, type ValueScrubOptions } from './value-scrub';
import { installHttpInstrumentation, unbindHttpInstrumentation } from './http-instrumentation';
import type { ConsoleCaptureOptions } from './auto-breadcrumbs';
import {
  resolveScreenshotConfig,
  pickScreenshotConfig,
  maybeCaptureScreenshot,
  warnIfBothApisPresent,
  type ScreenshotConfig,
  type ScreenshotRedactionMode,
  type ScreenshotMaskStyle,
  type ScreenshotFormat,
  type ScreenshotNativeMode,
  type ScreenshotFailPolicy,
  type ScreenshotContext,
} from './screenshot';
import { detectRuntimeMode, tryRequire } from './runtime';
import {
  collectAutoContexts,
  buildUserContext,
  buildAutoRelease,
  type AllStakContexts,
  type CollectContextOptions,
} from './contexts';
import { resolveRelease } from './release-detect';
import { SessionTracker } from './session';
import type { PersistenceOptions, PersistenceStorage } from './persistence';
import {
  buildExceptionChain,
  maybeExtractHttpRequest,
  type MechanismType,
  type ExceptionValue,
  type SanitizedHttpRequest,
} from './mechanism';

interface AsyncScopeStorage {
  getStore(): Scope[] | undefined;
  run<T>(store: Scope[], callback: () => T): T;
}

declare const require: undefined | ((id: string) => { AsyncLocalStorage?: new () => AsyncScopeStorage });

export const INGEST_HOST = 'https://api.allstak.sa';
export const SDK_NAME = 'allstak-react-native';
export const SDK_VERSION = '0.6.1';

export { Scope } from './scope';
export { Span, TracingModule } from './tracing';
export type { SpanData, SpanOptions } from './tracing';

const ERRORS_PATH = '/ingest/v1/errors';
const LOGS_PATH = '/ingest/v1/logs';
const PROFILES_PATH = '/ingest/v1/profiles';
const SDK_LOAD_TIME = Date.now();

const VALID_BREADCRUMB_TYPES = new Set(['http', 'log', 'ui', 'navigation', 'query', 'default']);
const VALID_BREADCRUMB_LEVELS = new Set(['fatal', 'error', 'warning', 'warn', 'log', 'info', 'debug']);
const DEFAULT_MAX_BREADCRUMBS = 100;
const DEFAULT_IGNORE_ERRORS: EventFilterPattern[] = [
  /^Script error\.?$/i,
  /ResizeObserver loop limit exceeded/i,
  /ResizeObserver loop completed with undelivered notifications/i,
  /^Non-Error promise rejection captured with value: (?:null|undefined)$/i,
];

export type SeverityLevel = Severity;
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'warning' | 'error' | 'fatal';
export type EventId = string;
type EventFilterPattern = string | RegExp;
export type ErrorEventProcessor = (
  event: ErrorIngestPayload,
) => ErrorIngestPayload | null | undefined | Promise<ErrorIngestPayload | null | undefined>;

export interface LogEnvelope {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';
  message: string;
  timestamp: number;
  attributes?: Record<string, unknown>;
}

export interface AllStakConfig {
  /** Project API key (`ask_live_…`). Required. */
  apiKey: string;
  /** Optional ingest host override; defaults to {@link INGEST_HOST}. */
  host?: string;
  environment?: string;
  release?: string;
  /**
   * Auto-detect `release` when it is not set explicitly. Default: `true`.
   *
   * NOTE: a React Native JS runtime has no `child_process`, so RUNTIME local-git
   * detection is impossible — the git step is a documented no-op. The realistic
   * RN release is a build-time value. The effective order on RN is:
   * explicit → env vars (bundle-time) → native app-config (`buildAutoRelease`:
   * `<bundleId>@<version>+<build>`) → SDK version. Set `false` to disable the
   * git probe AND the SDK-version fallback (release may then be left empty).
   * App-config and env detection are unaffected by this flag.
   */
  autoDetectRelease?: boolean;
  /** Register the resolved release with AllStak at SDK init. Default true. */
  autoRegisterRelease?: boolean;
  /**
   * Release-health session tracking: one session per app-launch. On init the
   * SDK POSTs `/ingest/v1/sessions/start`; on graceful shutdown (app
   * background→terminate / `close()`) it POSTs `/ingest/v1/sessions/end` with
   * the final status (`ok` / `errored` / `crashed`). Sessions are never sampled
   * and the lifecycle is fully fail-open. Default: `true`. Set `false` to
   * opt out. Automatically skipped under a unit-test runtime.
   */
  enableAutoSessionTracking?: boolean;
  /**
   * Offline / persistent event queue (0.5.12+). When an event can't be
   * delivered (network outage, retries exhausted, app shutting down) its
   * already-PII-scrubbed payload is written to a durable store and replayed on
   * the next init through the same transport (so retry / backoff /
   * circuit-breaker apply). Bounded by count, bytes and age; oldest dropped
   * when full. Session lifecycle calls are never persisted. Fully fail-open: a
   * read-only / sandboxed / missing store degrades silently to in-memory.
   *
   * RN bundles no native filesystem, so persistence is a pluggable adapter.
   * Provide one via `offlineQueue.storage` or the global `setPersistence(...)`
   * (e.g. `@react-native-async-storage/async-storage`). Without an adapter the
   * SDK auto-detects a global AsyncStorage/localStorage and otherwise keeps the
   * prior in-memory-only behavior.
   *
   * Default: `true`. Set `false` to opt out entirely. Automatically skipped
   * under a unit-test runtime unless `offlineQueue` is configured explicitly.
   */
  enableOfflineQueue?: boolean;
  /** Fine-grained persistence options for the offline event queue. */
  offlineQueue?: PersistenceOptions;
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
  level?: SeverityLevel;
  /**
   * Custom grouping fingerprint applied to every event. The backend uses
   * this in place of stack-based grouping. Customer-set grouping override —
   * `setFingerprint`. Pass an empty array or `null` to clear.
   */
  fingerprint?: string[];
  /** Probability in [0, 1] that any new span is recorded. Default 1. */
  tracesSampleRate?: number;
  /** Master switch for namespace-compatible performance spans. Default: true. */
  enablePerformance?: boolean;
  /** Mutate or drop a performance span before it leaves the SDK. */
  beforeSendSpan?: (span: SpanData) => SpanData | null | undefined;
  /** URLs that should receive distributed tracing headers. Defaults to all non-AllStak HTTP calls. */
  tracePropagationTargets?: (string | RegExp)[];
  /** Mobile app-start, navigation, and JS frame-health spans. Default: true. */
  enableMobileVitals?: boolean;
  /** JS profile/frame-health sampling rate. Default follows tracesSampleRate. */
  profilesSampleRate?: number;
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
   * (when present) `axios`. Default: true. Combine with `httpTracking`
   * to control body/header capture and redaction. Idempotent.
   */
  enableHttpTracking?: boolean;
  /**
   * Privacy + capture controls for HTTP instrumentation. Request/response
   * bodies and headers are captured by default with sensitive data redacted.
   * Auth headers and sensitive query params are ALWAYS redacted.
   */
  httpTracking?: HttpTrackingOptions;
  /**
   * Per-console-method capture flags. Defaults: warn + error captured,
   * log + info NOT captured (to avoid breadcrumb spam from typical app
   * logging). Set `{ log: true, info: true }` to opt-in.
   */
  captureConsole?: ConsoleCaptureOptions;
  /**
   * Enable structured log delivery through `AllStak.logger.*` /
   * `AllStak.log(...)`. Default: false.
   */
  enableLogs?: boolean;
  /**
   * Mutate or drop a structured log before it is sent. Return `null` to drop.
   * Sync or async. Throwing from the hook sends the original log.
   */
  beforeSendLog?: (log: LogEnvelope) =>
    | LogEnvelope | null | undefined
    | Promise<LogEnvelope | null | undefined>;
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
  /** namespace-compatible event processors. Return null/undefined to drop. */
  eventProcessors?: ErrorEventProcessor[];
  /** Drop errors whose message/class matches any pattern. */
  ignoreErrors?: EventFilterPattern[];
  /** Disable built-in browser-noise ignores. Default: false. */
  disableDefaultIgnoreErrors?: boolean;
  /** Drop consecutive duplicate errors/messages. Default: true. */
  dedupe?: boolean;
  /**
   * Optional legacy provider-based screenshot capture. Prefer the flat
   * screenshot options below; the SDK-owned native capture path is enabled
   * by default.
   */
  screenshot?: ScreenshotCaptureOptions;

  // ── Flat screenshot API (preferred; wizard 0.1.16+ writes these) ────
  /** Enable on-error screenshot capture. Default: true. */
  captureScreenshotOnError?: boolean;
  screenshotRedaction?: ScreenshotRedactionMode;
  screenshotMaskStyle?: ScreenshotMaskStyle;
  screenshotMaxBytes?: number;
  screenshotQuality?: number;
  screenshotFormat?: ScreenshotFormat;
  screenshotSampleRate?: number;
  screenshotOnUnhandledOnly?: boolean;
  screenshotUploadTimeoutMs?: number;
  screenshotCaptureTimeoutMs?: number;
  screenshotNativeMode?: ScreenshotNativeMode;
  screenshotFailPolicy?: ScreenshotFailPolicy;
  beforeScreenshotCapture?: ScreenshotConfig['beforeScreenshotCapture'];
  beforeScreenshotUpload?: ScreenshotConfig['beforeScreenshotUpload'];
  isScreenshotAllowed?: ScreenshotConfig['isScreenshotAllowed'];

  /** SDK identity overrides (set automatically by installReactNative). */
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
  dist?: string;
  commitSha?: string;
  branch?: string;

  // ── Rich event context (0.5.0+) ───────────────────────────────
  /**
   * Auto-collect device/os/app/react_native/runtime contexts on init.
   * Default: true. Optional metadata packages (expo-application,
   * expo-device, expo-constants, react-native-device-info) are
   * lazy-required and missing deps simply produce shallower contexts.
   */
  captureDeviceContext?: boolean;
  /** Include battery info (requires `expo-battery`). Default false. */
  captureBattery?: boolean;
  /** Include screen dimensions + orientation. Default true. */
  captureScreenContext?: boolean;
  /**
   * Opt into sending personally-identifiable information. Default FALSE
   * (the privacy-safe default). Two effects:
   *   - The explicit user object's `email` / `ip_address` are attached to
   *     events (see {@link buildUserContext}).
   *   - The value-pattern scrubbers for email + IPv4 in free-text values
   *     (messages, metadata, breadcrumbs, logs) are DISABLED — the host has
   *     opted in. Credit-card (Luhn) + US-SSN scrubbing is ALWAYS on
   *     regardless of this flag, and `setUser` data is never value-scrubbed.
   */
  sendDefaultPii?: boolean;
  /** Stamp client.ip on outgoing events. Default false. */
  collectIpAddress?: boolean;
  /**
   * Mutate or drop a breadcrumb before it is appended to the buffer.
   * Return `null` to drop. Errors thrown are swallowed; the original
   * breadcrumb is appended so a buggy hook can't black-hole telemetry.
   */
  beforeBreadcrumb?: (crumb: Breadcrumb) => Breadcrumb | null | undefined;
  /** Drop HTTP breadcrumbs/events whose URL matches any of these. */
  denyUrls?: (string | RegExp)[];
  /** When set, ONLY emit HTTP breadcrumbs/events for matching URLs. */
  allowUrls?: (string | RegExp)[];
  /** Extra keys to scrub from breadcrumb data + event metadata. */
  scrubKeys?: string[];
  /** Additional regexes to scrub from string values in event data. */
  scrubPatterns?: RegExp[];
  /** Maximum size of the breadcrumb ring buffer. Default 100. */
  /** (`maxBreadcrumbs` already declared above) */
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

interface NativePerformanceSnapshot {
  native_app_start_ms?: number;
  total_frames?: number;
  slow_frames?: number;
  frozen_frames?: number;
  max_frame_delay_ms?: number;
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

  // ── Rich event enrichments (0.5.0+) ───────────────────────────
  /** UUID v4 generated for this event. */
  eventId?: string;
  /** ISO-8601 timestamp when the event was captured (client-side). */
  timestamp?: string;
  /** Was this error handled by the host? false for unhandled JS / promise / native crashes. */
  handled?: boolean;
  /** Entry point that captured the error. */
  mechanism?: MechanismType;
  /** Current screen / route at the time of capture. */
  transaction?: string;
  /** Exception chain (innermost first). Includes mechanism on the outermost. */
  exception?: { values: ExceptionValue[] };
  /** Context bags: device, os, app, react_native, runtime, user, trace. */
  contexts?: AllStakContexts & {
    trace?: { trace_id?: string; span_id?: string; parent_span_id?: string; op?: string; status?: string };
  };
  /** Product-owned tags dictionary (flat key/value). */
  tags?: Record<string, string>;
  /** HTTP request panel for AxiosError-shaped errors. */
  request?: SanitizedHttpRequest;
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

function createAsyncScopeStorage(): AsyncScopeStorage | null {
  const proc = (globalThis as any).process;
  if (!proc?.versions?.node) return null;
  try {
    const fromProcess = proc.getBuiltinModule?.('node:async_hooks')?.AsyncLocalStorage;
    if (fromProcess) return new fromProcess();
    const req = typeof require === 'function' ? require : undefined;
    const AsyncLocalStorage = req?.('node:async_hooks').AsyncLocalStorage;
    return AsyncLocalStorage ? new AsyncLocalStorage() : null;
  } catch {
    return null;
  }
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

function hasFlatScreenshotConfig(config: Record<string, unknown>): boolean {
  return [
    'captureScreenshotOnError',
    'screenshotRedaction',
    'screenshotMaskStyle',
    'screenshotMaxBytes',
    'screenshotQuality',
    'screenshotFormat',
    'screenshotSampleRate',
    'screenshotOnUnhandledOnly',
    'screenshotUploadTimeoutMs',
    'screenshotCaptureTimeoutMs',
    'screenshotNativeMode',
    'screenshotFailPolicy',
    'beforeScreenshotCapture',
    'beforeScreenshotUpload',
    'isScreenshotAllowed',
  ].some((key) => Object.prototype.hasOwnProperty.call(config, key));
}

function normalizeLogLevel(level: LogLevel): 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' {
  return level === 'warning' ? 'warn' : level;
}

function matchesPattern(value: string | undefined, pattern: EventFilterPattern): boolean {
  if (!value) return false;
  return typeof pattern === 'string' ? value.includes(pattern) : pattern.test(value);
}

function eventUrls(event: ErrorIngestPayload): string[] {
  const urls = new Set<string>();
  for (const frame of event.frames ?? []) {
    if (frame.filename && /^https?:\/\//i.test(frame.filename)) urls.add(frame.filename);
    if (frame.absPath && /^https?:\/\//i.test(frame.absPath)) urls.add(frame.absPath);
  }
  for (const line of event.stackTrace ?? []) {
    const match = line.match(/https?:\/\/[^\s)]+/i);
    if (match) urls.add(match[0]);
  }
  if (event.request?.url_sanitized && /^https?:\/\//i.test(event.request.url_sanitized)) urls.add(event.request.url_sanitized);
  return [...urls];
}

function eventDedupeKey(event: ErrorIngestPayload): string {
  const fingerprint = event.fingerprint?.join('|') ?? '';
  const firstFrame = event.frames?.[0]
    ? `${event.frames[0].filename ?? event.frames[0].absPath ?? ''}:${event.frames[0].lineno ?? ''}:${event.frames[0].colno ?? ''}:${event.frames[0].function ?? ''}`
    : event.stackTrace?.[0] ?? '';
  return [event.exceptionClass, event.message, fingerprint, firstFrame].join('|');
}

function isLikelyTestRuntime(): boolean {
  const proc = (globalThis as any).process;
  const env = proc?.env ?? {};
  const lifecycle = String(env.npm_lifecycle_event ?? '');
  return env.NODE_ENV === 'test' || lifecycle.includes('test') || Boolean(env.VITEST);
}

function registerRuntimeRelease(config: AllStakConfig, transport: HttpTransport): void {
  if (config.autoRegisterRelease === false || !config.apiKey || !config.release) return;
  if (isLikelyTestRuntime()) return;
  void transport.send('/ingest/v1/releases', {
    version: config.release,
    environment: config.environment,
    commitSha: config.commitSha,
    branch: config.branch,
    author: null,
    message: null,
  });
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export class AllStakClient {
  private transport: HttpTransport;
  private config: AllStakConfig;
  private sessionId: string;
  private breadcrumbs: Breadcrumb[] = [];
  private maxBreadcrumbs: number;
  private globalScopeStack: Scope[] = [];
  private asyncScopeStorage: AsyncScopeStorage | null = createAsyncScopeStorage();
  private tracing: TracingModule;
  private replay: ReplaySurrogate | null = null;
  private httpRequests: HttpRequestModule | null = null;
  private _instrumentAxios: ((axios: any) => any) | null = null;
  private mobileFrameTimer: ReturnType<typeof setInterval> | null = null;
  private profileTimer: ReturnType<typeof setInterval> | null = null;
  /** Auto-collected contexts (device/os/app/react_native/runtime). */
  private autoContexts: AllStakContexts = {};
  /** Auto-collected tags (device_model, os, js_engine, ...). */
  private autoTags: Record<string, string> = {};
  /** Current screen / transaction name — set via setCurrentScreen() or nav auto-instrument. */
  private currentTransaction: string | null = null;
  private eventProcessors: ErrorEventProcessor[] = [];
  private lastEventKey: string | null = null;
  /** Release-health session tracker (one session per launch). Null when off. */
  private sessionTracker: SessionTracker | null = null;

  constructor(config: AllStakConfig) {
    this.config = { ...config };
    if (!this.config.environment) this.config.environment = 'production';
    if (!this.config.sdkName) this.config.sdkName = SDK_NAME;
    if (!this.config.sdkVersion) this.config.sdkVersion = SDK_VERSION;
    if (!this.config.platform) this.config.platform = 'react-native';
    // ── Auto-collect contexts (best-effort, lazy-required deps) ───────────────
    try {
      const opts: CollectContextOptions = {
        captureDeviceContext: this.config.captureDeviceContext !== false,
        captureBattery: this.config.captureBattery === true,
        captureScreenContext: this.config.captureScreenContext !== false,
        sendDefaultPii: this.config.sendDefaultPii === true,
      };
      const { contexts, tags } = collectAutoContexts(opts);
      this.autoContexts = contexts;
      this.autoTags = tags;
      // Resolve release: explicit → RN native app-config (buildAutoRelease) →
      // env (bundle-time) → local git (RN no-op) → SDK-version fallback.
      // App-config stays authoritative (pre-existing behavior); git + version
      // fallback gated by autoDetectRelease (default true).
      this.config.release = resolveRelease(
        this.config.release,
        buildAutoRelease(contexts.app),
        this.config.sdkVersion ?? SDK_VERSION,
        this.config.autoDetectRelease !== false,
      );
    } catch { /* never break init */ }
    // Safety net: if context collection threw before release was resolved,
    // still apply env → SDK-version fallback (no app-config available here).
    if (!this.config.release) {
      this.config.release = resolveRelease(
        undefined,
        undefined,
        this.config.sdkVersion ?? SDK_VERSION,
        this.config.autoDetectRelease !== false,
      );
    }

    this.sessionId = generateId();
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    const baseUrl = (config.host ?? INGEST_HOST).replace(/\/$/, '');
    this.transport = new HttpTransport(
      baseUrl,
      config.apiKey ?? '',
      Boolean(config.apiKey),
      this.resolvePersistenceOptions(),
    );
    registerRuntimeRelease(this.config, this.transport);
    this.tracing = new TracingModule(this.transport, {
      service: this.config.service ?? this.config.release ?? '',
      environment: this.config.environment ?? 'production',
      release: this.config.release,
      sessionId: this.sessionId,
      platform: this.config.platform,
      tracesSampleRate: this.config.tracesSampleRate,
      beforeSendSpan: this.config.beforeSendSpan,
    });
    const autoPerformanceEnabled = this.config.enablePerformance === true ||
      (this.config.enablePerformance !== false && typeof this.config.tracesSampleRate === 'number');
    if (autoPerformanceEnabled && this.config.enableMobileVitals !== false) {
      this.captureAppStartSpan();
      this.installMobileFrameHealth();
      this.installSampledStackProfiler();
    }
    if (this.config.replay && (this.config.replay.enabled ?? true)) {
      try {
        this.replay = new ReplaySurrogate(this.transport, this.sessionId, this.config.replay);
        this.replay.start();
      } catch { /* never break init */ }
    }

    if (config.enableHttpTracking !== false) {
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
        // Thread top-level PII settings into body capture so the value
        // scrubbers (CC/SSN always; email/IPv4 gated) run on captured HTTP
        // bodies. An explicit httpTracking value still wins.
        const httpTrackingOpts: HttpTrackingOptions = {
          sendDefaultPii: this.config.sendDefaultPii === true,
          ...(this.config.scrubPatterns ? { scrubPatterns: this.config.scrubPatterns } : {}),
          ...(config.httpTracking ?? {}),
        };
        const { instrumentAxios } = installHttpInstrumentation(
          this.httpRequests, httpTrackingOpts, baseUrl,
          {
            tracing: this.tracing,
            replay: this.replay,
            release: this.config.release,
            dist: this.config.dist,
            platform: this.config.platform,
            environment: this.config.environment,
            sessionId: this.sessionId,
            tracePropagationTargets: config.tracePropagationTargets,
          },
        );
        this._instrumentAxios = instrumentAxios;
      } catch { /* never break init */ }
    }

    // ── Release-health session: one session per launch (fail-open) ─────────
    try {
      this.startSessionTracking();
    } catch { /* never break init */ }

    // ── Offline queue: replay events persisted on a previous launch/outage ──
    // Asynchronous + fail-open: never blocks init or capture. Re-sends through
    // the existing transport so retry/backoff/circuit-breaker apply.
    try {
      void this.transport.drainPersisted().catch(() => undefined);
    } catch { /* never break init */ }
  }

  /**
   * Resolve the persistence options passed to the transport. The offline queue
   * is ON by default, OFF when `enableOfflineQueue === false`, and skipped under
   * a unit-test runtime UNLESS the host explicitly configured `offlineQueue`
   * (so tests can opt in with a fake adapter). Returns `undefined` to disable.
   */
  private resolvePersistenceOptions(): PersistenceOptions | undefined {
    if (this.config.enableOfflineQueue === false) return undefined;
    const explicit = this.config.offlineQueue;
    if (explicit?.enabled === false) return undefined;
    // Under a unit-test runtime, only enable when the host opted in explicitly.
    if (isLikelyTestRuntime() && !explicit) return undefined;
    return { enabled: true, ...(explicit ?? {}) };
  }

  /**
   * Start the release-health session for this launch. Reuses the SDK's
   * correlation `sessionId`, records the start timestamp, and POSTs
   * `/ingest/v1/sessions/start` through the existing transport. Registers an
   * AppState listener that ends the session when the app is backgrounded /
   * terminated. Skipped when `enableAutoSessionTracking` is false or under a
   * unit-test runtime. Fully fail-open.
   */
  private startSessionTracking(): void {
    if (this.config.enableAutoSessionTracking === false) return;
    const release = this.config.release ?? this.config.sdkVersion ?? SDK_VERSION;
    this.sessionTracker = new SessionTracker(
      this.transport,
      {
        // Fall back to sdkVersion when no release is resolved (per contract).
        release,
        environment: this.config.environment,
        userId: this.config.user?.id,
        sdkName: this.config.sdkName,
        sdkVersion: this.config.sdkVersion,
        platform: this.config.platform,
      },
      { sessionId: this.sessionId, skipNetwork: isLikelyTestRuntime() },
    );
    this.sessionTracker.start();
  }

  /**
   * Gracefully end the release-health session: computes durationMs and POSTs
   * `/ingest/v1/sessions/end` with the accumulated status. Idempotent,
   * best-effort, never throws.
   */
  endSession(status?: 'ok' | 'errored' | 'crashed' | 'abnormal'): void {
    try { this.sessionTracker?.end(status); } catch { /* fail-open */ }
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

  captureException(
    error: Error,
    context?: Record<string, unknown>,
    opts?: { mechanism?: MechanismType; handled?: boolean },
  ): EventId | undefined {
    if (!this.passesSampleRate()) return undefined;
    const eventId = generateEventId();
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

    // ── Rich event enrichments ─────────────────────────────────
    const mechanism: MechanismType = opts?.mechanism ?? 'captureException';
    const handled = opts?.handled ?? (mechanism === 'captureException' || mechanism === 'errorboundary');
    // Release-health: a HANDLED error → errored; an UNHANDLED/fatal/crash →
    // crashed. In-memory only; the /sessions/end POST carries the final status.
    try {
      if (handled) this.sessionTracker?.recordError();
      else this.sessionTracker?.recordCrash();
    } catch { /* fail-open */ }
    payload.eventId = eventId;
    payload.timestamp = new Date().toISOString();
    payload.handled = handled;
    payload.mechanism = mechanism;
    if (this.currentTransaction) payload.transaction = this.currentTransaction;
    payload.exception = { values: buildExceptionChain(error, mechanism, handled) };
    const req = maybeExtractHttpRequest(error);
    if (req) payload.request = req;
    // contexts: merge auto + scope + base config.user
    const userCtx = buildUserContext(eff.user, { sendDefaultPii: this.config.sendDefaultPii });
    const traceCtx: Record<string, unknown> = {};
    if (payload.traceId) traceCtx.trace_id = payload.traceId;
    if (payload.spanId) traceCtx.span_id = payload.spanId;
    if (payload.parentSpanId) traceCtx.parent_span_id = payload.parentSpanId;
    payload.contexts = {
      ...this.autoContexts,
      ...(eff.contexts ?? {}),
      ...(userCtx ? { user: userCtx } : {}),
      ...(Object.keys(traceCtx).length > 0 ? { trace: traceCtx } : {}),
    };
    // tags: auto + scope + base
    payload.tags = {
      ...this.autoTags,
      ...(this.config.tags ?? {}),
      ...((eff.tags ?? {}) as Record<string, string>),
      environment: this.config.environment ?? 'production',
      ...(this.config.release ? { release: this.config.release } : {}),
      ...(this.config.dist ? { dist: this.config.dist } : {}),
    };

    // Flat screenshot API path. Enabled by default through
    // resolveScreenshotConfig(); callers can disable with
    // captureScreenshotOnError:false. Warn once if both APIs are configured;
    // flat wins.
    const rawScreenshotConfig = this.config as unknown as Record<string, unknown>;
    const sc = resolveScreenshotConfig(pickScreenshotConfig(rawScreenshotConfig));
    const callbackPresent = Boolean(this.config.screenshot?.provider);
    const flatConfigured = hasFlatScreenshotConfig(rawScreenshotConfig);
    const flatPresent = sc.captureScreenshotOnError === true && (!callbackPresent || flatConfigured);
    warnIfBothApisPresent(callbackPresent, flatPresent);

    if (flatPresent) {
      void this.runFlatScreenshotPipeline(error, payload, sc).catch(() => {
        // Pipeline is fail-open, but belt-and-braces: ensure the event
        // ships even if something inside throws synchronously.
        void this.sendThroughBeforeSend({
          ...payload,
          metadata: { ...(payload.metadata ?? {}), 'screenshot.status': 'failed' },
        });
      });
      return eventId;
    }

    if (this.shouldCaptureScreenshot()) {
      void this.withScreenshotMetadata(error, payload)
        .then((enriched) => this.sendThroughBeforeSend(enriched))
        .catch(() => this.sendThroughBeforeSend({
          ...payload,
          metadata: { ...(payload.metadata ?? {}), 'screenshot.status': 'failed' },
        }));
      return eventId;
    }
    this.sendThroughBeforeSend({
      ...payload,
      metadata: {
        ...(payload.metadata ?? {}),
        'screenshot.status': this.config.screenshot?.enabled ? 'unsupported' : 'disabled',
      },
    });
    return eventId;
  }

  /**
   * Flat screenshot API path. Capture first (so masking primitives can
   * swap), send the event with a `screenshot.status` metadata tag, read
   * back the server-assigned errorId, then upload the attachment.
   *
   * Fail-open at every step.
   */
  private async runFlatScreenshotPipeline(
    error: Error,
    payload: ErrorIngestPayload,
    sc?: ScreenshotConfig,
  ): Promise<void> {
    sc = sc ?? resolveScreenshotConfig(pickScreenshotConfig(this.config as unknown as Record<string, unknown>));
    const runtimeMode = detectRuntimeMode();
    const ctx: ScreenshotContext = { error, unhandled: true, runtimeMode };

    let captured: Awaited<ReturnType<typeof maybeCaptureScreenshot>> = null;
    try {
      captured = await maybeCaptureScreenshot(sc, ctx);
    } catch { captured = null; }

    const status: string = !sc.captureScreenshotOnError
      ? 'disabled'
      : captured
        ? 'captured'
        : runtimeMode === 'expo-go'
          ? 'unsupported_runtime'
          : 'unavailable';

    const eventPayload: ErrorIngestPayload = {
      ...payload,
      metadata: {
        ...(payload.metadata ?? {}),
        'screenshot.status': status,
        'screenshot.runtimeMode': runtimeMode,
        ...(captured ? {
          'screenshot.contentType': captured.upload.contentType,
          'screenshot.width': captured.upload.width,
          'screenshot.height': captured.upload.height,
          'screenshot.sizeBytes': captured.upload.sizeBytes,
          'screenshot.redactionMode': captured.metadata.redactionMode,
          'screenshot.maskStyle': captured.metadata.maskStyle,
          'screenshot.captureMethod': captured.metadata.captureMethod,
        } : {}),
      },
    };

    // Send the event once. If no screenshot was captured there is no
    // attachment to link, so keep the normal transport path for buffering,
    // circuit-breaker accounting, and fail-open behavior.
    let finalPayload: ErrorIngestPayload | null | undefined = await this.applyEventPipeline(eventPayload);
    if (!finalPayload) return;

    if (!captured || !this.transport.isEnabled()) {
      void this.transport.send(ERRORS_PATH, finalPayload);
      return;
    }

    // Screenshot exists: send and read the server-assigned id so the
    // attachment can be associated with the error event.
    let eventId: string | null = null;
    try {
      const resp = await this.transport.sendAndRead<{ data?: { id?: string }; id?: string }>(
        ERRORS_PATH, finalPayload, { timeoutMs: 5000, retries: 1 },
      );
      eventId = resp?.data?.id ?? resp?.id ?? null;
    } catch { /* fail-open */ }

    if (!eventId) {
      void this.transport.send(ERRORS_PATH, finalPayload);
      return;
    }

    if (!captured) return;

    // Upload attachment with separate timeout / bounded retries.
    try {
      await this.transport.sendAndRead(
        `/ingest/v1/errors/${encodeURIComponent(eventId)}/attachments`,
        {
          kind: 'screenshot',
          contentType: captured.upload.contentType,
          dataBase64: captured.upload.dataBase64,
          width: captured.upload.width,
          height: captured.upload.height,
          redactionMode: captured.metadata.redactionMode,
          captureMethod: captured.metadata.captureMethod,
          sizeBytes: captured.upload.sizeBytes,
          metadata: {
            maskStyle: captured.metadata.maskStyle,
            format: captured.metadata.format,
            runtimeMode: captured.metadata.runtimeMode,
            privacyComponentsDetected: captured.metadata.privacyComponentsDetected ?? 0,
            sdkVersion: SDK_VERSION,
          },
        },
        { timeoutMs: sc.screenshotUploadTimeoutMs, retries: 2 },
      );
    } catch {
      // Fail-open — event already sent.
    }
  }

  /** Start a new span. Auto-parented to any currently-active span. */
  startSpan(operation: string, options?: SpanOptions): Span {
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
    level: SeverityLevel = 'info',
    options: { as?: 'log' | 'error' | 'both' } = {},
  ): EventId | undefined {
    const as = options.as ?? 'error';
    if (as === 'log' || as === 'both') {
      this.log(level === 'warning' ? 'warn' : level === 'log' ? 'info' : level, message);
    }
    if (as === 'error' || as === 'both') {
      if (!this.passesSampleRate()) return undefined;
      const eventId = generateEventId();
      const eff = this.effective();
      const currentBreadcrumbs = this.breadcrumbs.length > 0 ? [...this.breadcrumbs] : undefined;
      this.breadcrumbs = [];
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
        breadcrumbs: currentBreadcrumbs,
        fingerprint: eff.fingerprint,
      };
      payload.eventId = eventId;
      payload.timestamp = new Date().toISOString();
      payload.handled = true;
      payload.mechanism = 'captureMessage';
      if (this.currentTransaction) payload.transaction = this.currentTransaction;
      const userCtx = buildUserContext(eff.user, { sendDefaultPii: this.config.sendDefaultPii });
      const traceCtx: Record<string, unknown> = {};
      if (payload.traceId) traceCtx.trace_id = payload.traceId;
      if (payload.spanId) traceCtx.span_id = payload.spanId;
      payload.contexts = {
        ...this.autoContexts,
        ...(eff.contexts ?? {}),
        ...(userCtx ? { user: userCtx } : {}),
        ...(Object.keys(traceCtx).length > 0 ? { trace: traceCtx } : {}),
      };
      payload.tags = {
        ...this.autoTags,
        ...(this.config.tags ?? {}),
        ...((eff.tags ?? {}) as Record<string, string>),
        environment: this.config.environment ?? 'production',
        ...(this.config.release ? { release: this.config.release } : {}),
        ...(this.config.dist ? { dist: this.config.dist } : {}),
      };
      this.sendThroughBeforeSend(payload);
      return eventId;
    }
    return undefined;
  }

  log(level: LogLevel, message: string, attributes?: Record<string, unknown>): void {
    this.sendLog(normalizeLogLevel(level), message, attributes);
  }

  addBreadcrumb(
    type: string,
    message: string,
    level?: string,
    data?: Record<string, unknown>,
  ): void {
    let crumb: Breadcrumb = {
      timestamp: new Date().toISOString(),
      type: VALID_BREADCRUMB_TYPES.has(type) ? type : 'default',
      message,
      level: level && VALID_BREADCRUMB_LEVELS.has(level) ? level : 'info',
      ...(data ? { data } : {}),
    };

    // URL filtering for http breadcrumbs (denyUrls/allowUrls).
    if (crumb.type === 'http' && (this.config.denyUrls || this.config.allowUrls)) {
      const url = typeof crumb.data?.url === 'string' ? crumb.data.url as string : '';
      if (url) {
        if (this.config.denyUrls && this.config.denyUrls.some((p) => matchUrlPattern(url, p))) return;
        if (this.config.allowUrls && this.config.allowUrls.length > 0 &&
            !this.config.allowUrls.some((p) => matchUrlPattern(url, p))) return;
      }
    }

    // Scrub configured keys from the breadcrumb data.
    if (crumb.data && this.config.scrubKeys && this.config.scrubKeys.length > 0) {
      crumb = { ...crumb, data: scrubObject(crumb.data, this.config.scrubKeys) };
    }

    // beforeBreadcrumb hook — fail-open.
    if (this.config.beforeBreadcrumb) {
      try {
        const out = this.config.beforeBreadcrumb(crumb);
        if (out === null) return; // explicit drop
        if (out) crumb = out;
      } catch { /* swallow — keep original */ }
    }

    if (this.breadcrumbs.length >= this.maxBreadcrumbs) this.breadcrumbs.shift();
    this.breadcrumbs.push(crumb);
  }

  /**
   * Set the current screen / route name. Stamps `transaction` on every
   * subsequent event and emits a `navigation` breadcrumb. Use this when
   * not on `@react-navigation/native` (the nav auto-instrument calls
   * this for you).
   */
  setCurrentScreen(name: string): void {
    if (!name) return;
    const prev = this.currentTransaction;
    this.currentTransaction = name;
    if (prev !== name) {
      this.addBreadcrumb('navigation', `${prev ?? '<start>'} -> ${name}`, 'info', {
        from: prev, to: name,
      });
    }
  }

  /** @internal — current transaction (or undefined). */
  getCurrentTransaction(): string | undefined {
    return this.currentTransaction ?? undefined;
  }

  /** @internal — set transaction without emitting a breadcrumb. */
  __setTransactionSilent(name: string | null): void {
    this.currentTransaction = name && name.length > 0 ? name : null;
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

  /** Register a namespace-compatible event processor. */
  addEventProcessor(processor: ErrorEventProcessor): void {
    this.eventProcessors.push(processor);
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
   * Flush queued span batches and wait for in-flight transport work to drain.
   * Resolves `true` if telemetry drains within `timeoutMs` (default 2000ms),
   * `false` otherwise.
   */
  flush(timeoutMs?: number): Promise<boolean> {
    this.tracing.flush();
    return this.transport.flush(timeoutMs);
  }

  /** Set the default severity level applied to subsequent captures. */
  setLevel(level: SeverityLevel): void {
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

  /** @internal — release-health session tracker (exposed for testing). */
  __getSessionTracker(): SessionTracker | null { return this.sessionTracker; }

  getConfig(): AllStakConfig { return this.config; }

  getTransportStats(): TransportStats { return this.transport.getStats(); }

  /**
   * Gracefully close the SDK: end the release-health session, then tear down.
   * Mirrors the Java SDK `close()`. Best-effort and fail-open.
   */
  close(): void {
    this.endSession();
    this.destroy();
  }

  destroy(): void {
    // End the session before teardown so /sessions/end still fires (idempotent
    // if it already ended on AppState background).
    this.endSession();
    if (this.mobileFrameTimer) { clearInterval(this.mobileFrameTimer); this.mobileFrameTimer = null; }
    if (this.profileTimer) { clearInterval(this.profileTimer); this.profileTimer = null; }
    this.tracing.destroy();
    if (this.replay) { this.replay.destroy(); this.replay = null; }
    if (this.httpRequests) { this.httpRequests.destroy(); this.httpRequests = null; }
    unbindHttpInstrumentation();
    this._instrumentAxios = null;
    this.breadcrumbs = [];
    this.eventProcessors = [];
    this.lastEventKey = null;
  }

  private captureAppStartSpan(): void {
    void this.getNativePerformanceSnapshot()
      .then((snapshot) => this.captureAppStartSpanFromSnapshot(snapshot))
      .catch(() => this.captureAppStartSpanFromSnapshot(null));
  }

  private captureAppStartSpanFromSnapshot(snapshot: NativePerformanceSnapshot | null): void {
    const now = Date.now();
    const nativeDuration = numberOrUndefined(snapshot?.native_app_start_ms);
    const duration = nativeDuration ?? Math.max(0, now - SDK_LOAD_TIME);
    const source = nativeDuration != null ? 'native' : 'js';
    const span = this.tracing.startSpan('app.start', {
      op: 'app.start',
      platform: this.config.platform ?? 'react-native',
      description: source === 'native' ? 'Native app start' : 'JS app start',
      startTimeMillis: source === 'native' ? now - duration : SDK_LOAD_TIME,
      measurements: source === 'native'
        ? { native_app_start_ms: duration }
        : { js_app_start_ms: duration },
      attributes: {
        session_id: this.sessionId,
        release: this.config.release,
        dist: this.config.dist,
      },
      tags: { type: source },
    });
    span.finish('ok', now);
  }

  private installMobileFrameHealth(): void {
    const rate = this.config.profilesSampleRate ?? this.config.tracesSampleRate ?? 0;
    if (rate <= 0 || Math.random() >= rate) return;
    let last = Date.now();
    let slowFrames = 0;
    let frozenFrames = 0;
    let maxDelay = 0;
    let ticks = 0;
    const intervalMs = 500;
    const flushEveryTicks = 20;
    this.mobileFrameTimer = setInterval(() => {
      void this.getNativePerformanceSnapshot()
        .then((snapshot) => {
          if (!snapshot) return false;
          const total = numberOrUndefined(snapshot.total_frames) ?? 0;
          const nativeSlow = numberOrUndefined(snapshot.slow_frames) ?? 0;
          const nativeFrozen = numberOrUndefined(snapshot.frozen_frames) ?? 0;
          const nativeMax = numberOrUndefined(snapshot.max_frame_delay_ms) ?? 0;
          if (total <= 0 && nativeSlow <= 0 && nativeFrozen <= 0 && nativeMax <= 0) return true;
          this.captureFrameHealthSpan('native', {
            total_frames: total,
            slow_frames: nativeSlow,
            frozen_frames: nativeFrozen,
            max_frame_delay_ms: nativeMax,
          });
          return true;
        })
        .then((nativeHandled) => {
          if (nativeHandled) return;
          const now = Date.now();
          const delay = Math.max(0, now - last - intervalMs);
          last = now;
          ticks += 1;
          if (delay > 50) slowFrames += 1;
          if (delay > 700) frozenFrames += 1;
          if (delay > maxDelay) maxDelay = delay;
          if (ticks < flushEveryTicks) return;

          this.captureFrameHealthSpan('js', {
            slow_frames: slowFrames,
            frozen_frames: frozenFrames,
            max_frame_delay_ms: maxDelay,
          });
          slowFrames = 0;
          frozenFrames = 0;
          maxDelay = 0;
          ticks = 0;
        })
        .catch(() => undefined);
    }, intervalMs);
    (this.mobileFrameTimer as any)?.unref?.();
  }

  private installSampledStackProfiler(): void {
    const rate = this.config.profilesSampleRate ?? 0;
    if (rate <= 0 || Math.random() >= rate) return;

    const startedAt = Date.now();
    const profileId = generateId();
    const intervalMs = 100;
    const flushEveryMs = 10_000;
    const samples: Array<{
      elapsedMs: number;
      thread: string;
      stack: Array<{ function?: string; file?: string; line?: number; column?: number }>;
    }> = [];

    const flush = () => {
      if (samples.length === 0) return;
      const chunk = samples.splice(0, samples.length);
      this.transport.send(PROFILES_PATH, {
        profiles: [{
          profileId,
          traceId: this.tracing.getTraceId(),
          spanId: this.tracing.getCurrentSpanId() ?? undefined,
          sessionId: this.sessionId,
          release: this.config.release,
          environment: this.config.environment,
          platform: this.config.platform ?? 'react-native',
          runtime: 'react-native-js',
          profileType: 'sampled_stack',
          durationMs: Date.now() - startedAt,
          sampleCount: chunk.length,
          samples: chunk,
          measurements: { sample_interval_ms: intervalMs },
          attributes: {
            screen: this.currentTransaction ?? '',
            sdk_name: this.config.sdkName ?? SDK_NAME,
            sdk_version: this.config.sdkVersion ?? SDK_VERSION,
          },
          timestampMillis: Date.now(),
        }],
      });
    };

    this.profileTimer = setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const stack = parseStack(new Error('AllStak profile sample').stack)
        .slice(1, 65)
        .map((f) => ({
          function: f.function,
          file: f.filename || f.absPath,
          line: f.lineno,
          column: f.colno,
        }));
      samples.push({ elapsedMs, thread: 'js', stack });
      if (elapsedMs > 0 && elapsedMs % flushEveryMs < intervalMs) flush();
    }, intervalMs);
    (this.profileTimer as any)?.unref?.();
  }

  private captureFrameHealthSpan(source: 'native' | 'js', measurements: Record<string, number>): void {
    const span = this.tracing.startSpan('mobile.frame', {
      op: 'mobile.frame',
      platform: this.config.platform ?? 'react-native',
      description: source === 'native' ? 'Native frame health' : 'JS frame health',
      measurements,
      attributes: {
        session_id: this.sessionId,
        release: this.config.release,
        dist: this.config.dist,
      },
      tags: { source },
    });
    span.finish('ok');
  }

  private async getNativePerformanceSnapshot(): Promise<NativePerformanceSnapshot | null> {
    try {
      const rn = tryRequire<any>('react-native');
      const native = rn?.NativeModules?.AllStakNative;
      if (!native || typeof native.getPerformanceSnapshot !== 'function') return null;
      const snapshot = await Promise.resolve(native.getPerformanceSnapshot());
      return snapshot && typeof snapshot === 'object' ? snapshot as NativePerformanceSnapshot : null;
    } catch {
      return null;
    }
  }

  // ── Internal ──────────────────────────────────────────────────────

  private sendLog(
    level: 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal',
    message: string,
    attributes?: Record<string, unknown>,
  ): void {
    if (this.config.enableLogs !== true) return;
    const log: LogEnvelope = {
      timestamp: Date.now(),
      level,
      message,
      ...(attributes ? { attributes } : {}),
    };

    const send = (next: LogEnvelope | null | undefined) => {
      if (!next) return;
      // Value-pattern PII scrubbing on the log free-text + attributes.
      // Runs after beforeSendLog so a hook cannot reintroduce PII.
      // Fail-open: scrubString / scrubValueTree never throw.
      const opts = this.valueScrubOptions();
      const message = typeof next.message === 'string' ? scrubString(next.message, opts) : next.message;
      const metadata = scrubValueTree(
        { ...this.buildMetadata(), ...(next.attributes ?? {}) },
        opts,
      );
      this.transport.send(LOGS_PATH, {
        timestamp: new Date(next.timestamp).toISOString(),
        level: next.level,
        message,
        sessionId: this.sessionId,
        environment: this.config.environment,
        release: this.config.release,
        platform: this.config.platform,
        sdkName: this.config.sdkName,
        sdkVersion: this.config.sdkVersion,
        metadata,
      });
    };

    if (!this.config.beforeSendLog) {
      send(log);
      return;
    }
    try {
      const result = this.config.beforeSendLog(log);
      if (result && typeof (result as Promise<LogEnvelope | null | undefined>).then === 'function') {
        void (result as Promise<LogEnvelope | null | undefined>).then(send).catch(() => send(log));
      } else {
        send(result as LogEnvelope | null | undefined);
      }
    } catch {
      send(log);
    }
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
    return mergeScopes(this.config, this.scopeStack());
  }

  private scopeStack(): Scope[] {
    return this.asyncScopeStorage?.getStore() ?? this.globalScopeStack;
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
    if (this.asyncScopeStorage) {
      const parent = this.scopeStack();
      return this.asyncScopeStorage.run([...parent, scope], () => callback(scope));
    }

    this.globalScopeStack.push(scope);
    let popped = false;
    const pop = () => { if (!popped) { popped = true; this.globalScopeStack.pop(); } };
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
    const stack = this.scopeStack();
    return stack[stack.length - 1] ?? null;
  }

  configureScope(callback: (scope: Scope) => void): void {
    const current = this.getCurrentScope();
    if (current) {
      callback(current);
      return;
    }
    const scope = new Scope();
    callback(scope);
    const eff = mergeScopes(this.config, [scope]);
    this.config.user = eff.user;
    this.config.tags = eff.tags;
    this.config.extras = eff.extras;
    this.config.contexts = eff.contexts;
    this.config.fingerprint = eff.fingerprint;
    this.config.level = eff.level;
  }

  private async sendThroughBeforeSend(payload: ErrorIngestPayload): Promise<void> {
    const final = await this.applyEventPipeline(payload);
    if (!final) return;
    this.transport.send(ERRORS_PATH, final);
  }

  private async applyEventPipeline(payload: ErrorIngestPayload): Promise<ErrorIngestPayload | null | undefined> {
    let final: ErrorIngestPayload | null | undefined = payload;
    for (const processor of [...(this.config.eventProcessors ?? []), ...this.eventProcessors]) {
      if (!final) return null;
      try { final = await processor(final); }
      catch { /* never let a buggy processor break capture */ }
    }
    if (!final || this.shouldDropByFilters(final)) return;
    if (this.config.beforeSend) {
      try { final = await this.config.beforeSend(final); }
      catch { final = payload; /* never let a buggy hook drop telemetry */ }
    }
    if (!final || this.shouldDropDuplicate(final)) return;
    // Value-pattern PII scrubbing runs LAST so a beforeSend hook cannot
    // reintroduce unscrubbed PII. Fail-open: on any error keep `final`.
    return this.scrubEventValues(final);
  }

  /** Options bag for the value-pattern scrubbers, read from config. */
  private valueScrubOptions(): ValueScrubOptions {
    return {
      sendDefaultPii: this.config.sendDefaultPii === true,
      scrubPatterns: this.config.scrubPatterns,
    };
  }

  /**
   * Apply value-pattern PII scrubbing (CC/SSN always; email/IPv4 unless
   * `sendDefaultPii`) to the free-text fields of an outgoing error/message
   * event. Returns a shallow-copied payload with scrubbed fields.
   *
   * Deliberately does NOT touch: the explicit `user` object (intentional
   * identification), stack frames (filename/function/absPath),
   * release / sdk / environment / platform / service fields, span/operation
   * names, URLs/paths (own redactor), tags (filter/index keys), and the
   * SDK's own `sessionId` / trace ids.
   *
   * Fail-open: any error returns the unscrubbed-but-key-redacted payload.
   */
  private scrubEventValues(event: ErrorIngestPayload): ErrorIngestPayload {
    const opts = this.valueScrubOptions();
    try {
      const out: ErrorIngestPayload = { ...event };

      if (typeof out.message === 'string') out.message = scrubString(out.message, opts);

      // Exception chain: scrub the human-readable `value` (message) only;
      // never the stacktrace frames.
      if (out.exception?.values) {
        out.exception = {
          values: out.exception.values.map((ev) =>
            typeof ev.value === 'string' ? { ...ev, value: scrubString(ev.value, opts) } : ev,
          ),
        };
      }

      // Free-text stack-trace strings array (filenames/functions live here,
      // but it is presented as message-like text — leave as-is to avoid
      // corrupting paths). Intentionally NOT scrubbed.

      if (out.metadata) out.metadata = scrubValueTree(out.metadata, opts);

      // Contexts: scrub every bag EXCEPT the explicit `user` bag and the
      // `trace` ids (structured identifiers, not free text).
      if (out.contexts) {
        const ctx = out.contexts as Record<string, unknown>;
        const scrubbed: Record<string, unknown> = {};
        for (const [name, bag] of Object.entries(ctx)) {
          scrubbed[name] = name === 'user' || name === 'trace' ? bag : scrubValueTree(bag, opts);
        }
        out.contexts = scrubbed as ErrorIngestPayload['contexts'];
      }

      // Breadcrumbs: scrub message + data, preserve timestamp/type/level.
      if (out.breadcrumbs && out.breadcrumbs.length > 0) {
        out.breadcrumbs = out.breadcrumbs.map((c) => {
          const next: Breadcrumb = { ...c };
          if (typeof next.message === 'string') next.message = scrubString(next.message, opts);
          if (next.data) next.data = scrubValueTree(next.data, opts);
          return next;
        });
      }

      return out;
    } catch {
      return event; // fail-open
    }
  }

  private shouldDropByFilters(event: ErrorIngestPayload): boolean {
    const ignorePatterns = this.config.disableDefaultIgnoreErrors
      ? (this.config.ignoreErrors ?? [])
      : [...DEFAULT_IGNORE_ERRORS, ...(this.config.ignoreErrors ?? [])];
    const message = `${event.exceptionClass || ''}: ${event.message || ''}`;
    if (ignorePatterns.some((pattern) => matchesPattern(message, pattern) || matchesPattern(event.message, pattern))) {
      return true;
    }

    const urls = eventUrls(event);
    if (this.config.allowUrls?.length && urls.length > 0 &&
        !urls.some((url) => this.config.allowUrls!.some((pattern) => matchesPattern(url, pattern)))) {
      return true;
    }
    if (this.config.denyUrls?.length && urls.some((url) => this.config.denyUrls!.some((pattern) => matchesPattern(url, pattern)))) {
      return true;
    }
    return false;
  }

  private shouldDropDuplicate(event: ErrorIngestPayload): boolean {
    if (this.config.dedupe === false) return false;
    const key = eventDedupeKey(event);
    if (key && key === this.lastEventKey) return true;
    this.lastEventKey = key;
    return false;
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
  return new Span('', '', '', operation, operation, 'react-native', '', '', '', undefined, undefined, 0, 0, {}, {}, {}, () => undefined);
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

export const AllStak: any = {
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
  captureException(
    error: Error,
    context?: Record<string, unknown>,
    opts?: { mechanism?: MechanismType; handled?: boolean },
  ): EventId | undefined {
    try { return maybeInit()?.captureException(error, context, opts); } catch { return undefined; }
  },
  captureMessage(
    message: string,
    level: SeverityLevel = 'info',
    options?: { as?: 'log' | 'error' | 'both' },
  ): EventId | undefined {
    try { return maybeInit()?.captureMessage(message, level, options); } catch { return undefined; }
  },
  log(level: LogLevel, message: string, attributes?: Record<string, unknown>): void {
    try { maybeInit()?.log(level, message, attributes); } catch { /* fail-open */ }
  },
  logger: {
    trace(message: string, attributes?: Record<string, unknown>): void { try { maybeInit()?.log('trace', message, attributes); } catch { /* fail-open */ } },
    debug(message: string, attributes?: Record<string, unknown>): void { try { maybeInit()?.log('debug', message, attributes); } catch { /* fail-open */ } },
    info(message: string, attributes?: Record<string, unknown>): void { try { maybeInit()?.log('info', message, attributes); } catch { /* fail-open */ } },
    warn(message: string, attributes?: Record<string, unknown>): void { try { maybeInit()?.log('warn', message, attributes); } catch { /* fail-open */ } },
    error(message: string, attributes?: Record<string, unknown>): void { try { maybeInit()?.log('error', message, attributes); } catch { /* fail-open */ } },
    fatal(message: string, attributes?: Record<string, unknown>): void { try { maybeInit()?.log('fatal', message, attributes); } catch { /* fail-open */ } },
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
  addEventProcessor(processor: ErrorEventProcessor): void { try { maybeInit()?.addEventProcessor(processor); } catch { /* fail-open */ } },
  setContext(name: string, ctx: Record<string, unknown> | null): void { try { maybeInit()?.setContext(name, ctx); } catch { /* fail-open */ } },
  setLevel(level: SeverityLevel): void { try { maybeInit()?.setLevel(level); } catch { /* fail-open */ } },
  setFingerprint(fingerprint: string[] | null): void { try { maybeInit()?.setFingerprint(fingerprint); } catch { /* fail-open */ } },
  flush(timeoutMs?: number): Promise<boolean> {
    try { return maybeInit()?.flush(timeoutMs) ?? Promise.resolve(true); }
    catch { return Promise.resolve(false); }
  },
  setIdentity(identity: { sdkName?: string; sdkVersion?: string; platform?: string; dist?: string }): void {
    try { maybeInit()?.setIdentity(identity); } catch { /* fail-open */ }
  },
  /** Set the current screen / transaction name. Stamps event.transaction + emits nav breadcrumb. */
  setCurrentScreen(name: string): void {
    try { maybeInit()?.setCurrentScreen(name); } catch { /* fail-open */ }
  },
  getCurrentTransaction(): string | undefined {
    try { return maybeInit()?.getCurrentTransaction(); } catch { return undefined; }
  },
  /** @internal — set transaction without emitting a breadcrumb (nav auto-instrument uses this). */
  __setTransactionSilent(name: string | null): void {
    try { maybeInit()?.__setTransactionSilent(name); } catch { /* fail-open */ }
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
  getCurrentScope(): Scope | null {
    try { return maybeInit()?.getCurrentScope() ?? null; } catch { return null; }
  },
  configureScope(callback: (scope: Scope) => void): void {
    try {
      const client = maybeInit();
      if (client) client.configureScope(callback);
      else callback(new Scope());
    } catch { /* fail-open */ }
  },
  startSpan(operation: string, options?: SpanOptions): Span {
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
  /**
   * Gracefully close the SDK: ends the release-health session (POSTs
   * `/sessions/end`) and tears down instrumentation. Call on app shutdown.
   */
  close(): void { try { instance?.close(); } catch { /* fail-open */ } instance = null; },
  /** Manually end the release-health session early (best-effort, fail-open). */
  endSession(status?: 'ok' | 'errored' | 'crashed' | 'abnormal'): void {
    try { maybeInit()?.endSession(status); } catch { /* fail-open */ }
  },
  /** @internal — exposed for testing */
  _getInstance(): AllStakClient | null { return instance; },
};

function matchUrlPattern(url: string, p: string | RegExp): boolean {
  if (!url || !p) return false;
  if (typeof p === 'string') return url.includes(p);
  try { return p.test(url); } catch { return false; }
}

function scrubObject(
  obj: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  if (!obj || keys.length === 0) return obj;
  const out: Record<string, unknown> = {};
  const lower = new Set(keys.map((k) => k.toLowerCase()));
  for (const [k, v] of Object.entries(obj)) {
    out[k] = lower.has(k.toLowerCase()) ? '[Filtered]' : v;
  }
  return out;
}

function generateEventId(): string {
  // RFC4122-ish v4. Same approach as the session ID.
  const hex = (n: number) => Math.floor(Math.random() * n).toString(16).padStart(1, '0');
  const seg = (len: number) => Array.from({ length: len }, () => hex(16)).join('');
  return `${seg(8)}-${seg(4)}-4${seg(3)}-${(8 + Math.floor(Math.random() * 4)).toString(16)}${seg(3)}-${seg(12)}`;
}

function byteSize(value?: string): number {
  if (!value) return 0;
  try {
    if (typeof TextEncoder !== 'undefined') return new TextEncoder().encode(value).length;
  } catch {
    /* ignore */
  }
  return value.length;
}
