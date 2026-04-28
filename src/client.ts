/**
 * Standalone AllStak client for React Native. No browser APIs, no Node APIs —
 * only what RN guarantees: global `fetch`, AbortController, Date, JSON.
 *
 * Surface mirrors the public AllStak API used by mobile apps:
 *   init / captureException / captureMessage / addBreadcrumb / clearBreadcrumbs
 *   setUser / setTag / setIdentity / getSessionId
 */

import { HttpTransport } from './transport';
import { parseStack } from './stack';

export const INGEST_HOST = 'https://api.allstak.sa';
export const SDK_NAME = 'allstak-react-native';
export const SDK_VERSION = '0.1.4';

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
   * `captureMessage`. Sentry parity with `Sentry.setLevel`.
   */
  level?: 'fatal' | 'error' | 'warning' | 'info' | 'debug';
  /**
   * Custom grouping fingerprint applied to every event. The backend uses
   * this in place of stack-based grouping. Sentry parity with
   * `Sentry.setFingerprint`. Pass an empty array or `null` to clear.
   */
  fingerprint?: string[];
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
  /** SDK identity overrides (set automatically by installReactNative). */
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
  dist?: string;
  commitSha?: string;
  branch?: string;
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
  user?: { id?: string; email?: string };
  metadata?: Record<string, unknown>;
  breadcrumbs?: Breadcrumb[];
  fingerprint?: string[];
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

export class AllStakClient {
  private transport: HttpTransport;
  private config: AllStakConfig;
  private sessionId: string;
  private breadcrumbs: Breadcrumb[] = [];
  private maxBreadcrumbs: number;

  constructor(config: AllStakConfig) {
    if (!config.apiKey) {
      throw new Error('AllStak: config.apiKey is required');
    }
    this.config = { ...config };
    if (!this.config.environment) this.config.environment = 'production';
    if (!this.config.sdkName) this.config.sdkName = SDK_NAME;
    if (!this.config.sdkVersion) this.config.sdkVersion = SDK_VERSION;
    if (!this.config.platform) this.config.platform = 'react-native';
    this.sessionId = generateId();
    this.maxBreadcrumbs = config.maxBreadcrumbs ?? DEFAULT_MAX_BREADCRUMBS;
    const baseUrl = (config.host ?? INGEST_HOST).replace(/\/$/, '');
    this.transport = new HttpTransport(baseUrl, config.apiKey);
  }

  // ── Public API ────────────────────────────────────────────────────

  captureException(error: Error, context?: Record<string, unknown>): void {
    if (!this.passesSampleRate()) return;
    const frames = parseStack(error.stack).map((f) => ({
      ...f,
      platform: this.config.platform,
    }));
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
    const payload: ErrorIngestPayload = {
      exceptionClass,
      message: error.message,
      stackTrace,
      frames: frames.length > 0 ? frames : undefined,
      platform: this.config.platform,
      sdkName: this.config.sdkName,
      sdkVersion: this.config.sdkVersion,
      dist: this.config.dist,
      level: this.config.level ?? 'error',
      environment: this.config.environment,
      release: this.config.release,
      sessionId: this.sessionId,
      user: this.config.user,
      metadata: this.buildMetadata(context),
      breadcrumbs: currentBreadcrumbs,
      fingerprint: this.config.fingerprint,
    };

    this.sendThroughBeforeSend(payload);
  }

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
        user: this.config.user,
        metadata: this.buildMetadata(),
        fingerprint: this.config.fingerprint,
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

  destroy(): void {
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

  private passesSampleRate(): boolean {
    const r = this.config.sampleRate;
    if (typeof r !== 'number' || r >= 1) return true;
    if (r <= 0) return false;
    return Math.random() < r;
  }

  private buildMetadata(perCallContext?: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {
      ...this.releaseTags(),
      ...this.config.tags,
      ...(this.config.extras ?? {}),
      ...(perCallContext ?? {}),
    };
    if (this.config.contexts) {
      for (const [name, ctx] of Object.entries(this.config.contexts)) {
        out[`context.${name}`] = ctx;
      }
    }
    return out;
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

function ensureInit(): AllStakClient {
  if (!instance) throw new Error('AllStak.init() must be called before using the SDK');
  return instance;
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
    if (instance) instance.destroy();
    instance = new AllStakClient(config);
    return instance;
  },
  captureException(error: Error, context?: Record<string, unknown>): void {
    ensureInit().captureException(error, context);
  },
  captureMessage(
    message: string,
    level: 'fatal' | 'error' | 'warning' | 'info' = 'info',
    options?: { as?: 'log' | 'error' | 'both' },
  ): void {
    ensureInit().captureMessage(message, level, options);
  },
  addBreadcrumb(type: string, message: string, level?: string, data?: Record<string, unknown>): void {
    ensureInit().addBreadcrumb(type, message, level, data);
  },
  clearBreadcrumbs(): void { ensureInit().clearBreadcrumbs(); },
  setUser(user: { id?: string; email?: string }): void { ensureInit().setUser(user); },
  setTag(key: string, value: string): void { ensureInit().setTag(key, value); },
  setTags(tags: Record<string, string>): void { ensureInit().setTags(tags); },
  setExtra(key: string, value: unknown): void { ensureInit().setExtra(key, value); },
  setExtras(extras: Record<string, unknown>): void { ensureInit().setExtras(extras); },
  setContext(name: string, ctx: Record<string, unknown> | null): void { ensureInit().setContext(name, ctx); },
  setLevel(level: 'fatal' | 'error' | 'warning' | 'info' | 'debug'): void { ensureInit().setLevel(level); },
  setFingerprint(fingerprint: string[] | null): void { ensureInit().setFingerprint(fingerprint); },
  flush(timeoutMs?: number): Promise<boolean> { return ensureInit().flush(timeoutMs); },
  setIdentity(identity: { sdkName?: string; sdkVersion?: string; platform?: string; dist?: string }): void {
    ensureInit().setIdentity(identity);
  },
  getSessionId(): string { return ensureInit().getSessionId(); },
  getConfig(): AllStakConfig | null { return instance?.getConfig() ?? null; },
  destroy(): void { instance?.destroy(); instance = null; },
  /** @internal — exposed for testing */
  _getInstance(): AllStakClient | null { return instance; },
};
