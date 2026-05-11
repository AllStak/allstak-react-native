/**
 * React Native "replay surrogate" — a privacy-first view-state breadcrumb
 * recorder for environments where binary screen capture isn't available
 * (Expo Go, JS-only test runners, or apps that can't link a native module
 * for legal/compliance reasons).
 *
 * **What it captures (chronological, opt-in via sampleRate):**
 *   - the active route name on every navigation event
 *   - AppState foreground/background transitions (already covered by
 *     installReactNative's AppState breadcrumb wiring — we reuse that)
 *   - explicit `recordScreenView(name, params)` calls from the host app
 *     (used by router integrations or manual checkpoints)
 *
 * **What it intentionally does NOT capture:**
 *   - any user input values (text fields, password inputs, search queries)
 *   - any rendered text content from the visible screen
 *   - screenshots of any kind
 *   - URL path parameters by default (only the route name + opt-in `safeParams`)
 *
 * Hard rule: by default `safeParams` is `[]` and route params are dropped.
 * Callers must explicitly enumerate which param keys are safe to log.
 */

import type { HttpTransport } from './transport';

const REPLAY_INGEST_PATH = '/ingest/v1/replay';
const FLUSH_INTERVAL_MS = 10_000;

export interface ReplaySurrogateOptions {
  enabled?: boolean;
  /** Probability in [0, 1] per session that recording happens. Default 0 (opt-in). */
  sampleRate?: number;
  /**
   * Whitelist of route-param keys that are safe to record alongside the
   * route name. Anything not on this list is dropped. Default `[]`.
   */
  safeParams?: string[];
  /** Max events buffered before forced flush. Default 200. */
  maxBufferedEvents?: number;
}

interface SurrogateEvent {
  ts: number;
  k: 'screen' | 'appstate' | 'manual' | 'request' | 'exception' | 'response' | 'action' | 'retry';
  data: Record<string, unknown>;
}

export interface TimelineContext {
  traceId?: string;
  requestId?: string;
  spanId?: string;
  eventId?: string;
  release?: string;
  dist?: string;
  screen?: string;
  route?: string;
}

export class ReplaySurrogate {
  private buffer: SurrogateEvent[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private opts: Required<ReplaySurrogateOptions>;
  private sessionId: string;
  private active = false;
  private destroyed = false;

  constructor(
    private transport: HttpTransport,
    sessionId: string,
    options: ReplaySurrogateOptions = {},
  ) {
    this.sessionId = sessionId;
    this.opts = {
      enabled: options.enabled ?? true,
      sampleRate: options.sampleRate ?? 0,
      safeParams: options.safeParams ?? [],
      maxBufferedEvents: options.maxBufferedEvents ?? 200,
    };
  }

  /** Enable recording for this session if sample-rate roll passes. */
  start(): boolean {
    if (!this.opts.enabled) return false;
    if (this.active) return true;
    if (Math.random() >= this.opts.sampleRate) return false;
    this.active = true;
    this.flushTimer = setInterval(() => this.flush(), FLUSH_INTERVAL_MS);
    (this.flushTimer as any)?.unref?.();
    return true;
  }

  /** Record a screen view. Filters params through the safeParams allow-list. */
  recordScreenView(routeName: string, params?: Record<string, unknown>, context?: TimelineContext): void {
    if (!this.active) return;
    const safe: Record<string, unknown> = {};
    if (params && this.opts.safeParams.length > 0) {
      for (const key of this.opts.safeParams) {
        if (key in params) safe[key] = params[key];
      }
    }
    this.push({ ts: Date.now(), k: 'screen', data: { route: routeName, params: safe, ...compact(context) } });
  }

  /** Record an AppState transition (foreground/background/inactive). */
  recordAppState(next: string, context?: TimelineContext): void {
    if (!this.active) return;
    this.push({ ts: Date.now(), k: 'appstate', data: { state: next, ...compact(context) } });
  }

  /** Record a free-form, customer-validated checkpoint. */
  recordManual(label: string, data?: Record<string, unknown>, context?: TimelineContext): void {
    if (!this.active) return;
    this.push({ ts: Date.now(), k: 'manual', data: { label, ...(data ?? {}), ...compact(context) } });
  }

  /** Record a forensic mobile session timeline marker. This is not replay. */
  recordTimelineMarker(
    kind: SurrogateEvent['k'],
    label: string,
    data?: Record<string, unknown>,
    context?: TimelineContext,
  ): void {
    if (!this.active) return;
    this.push({ ts: Date.now(), k: kind, data: { label, ...(data ?? {}), ...compact(context) } });
  }

  destroy(): void {
    this.destroyed = true;
    this.active = false;
    if (this.flushTimer) { clearInterval(this.flushTimer); this.flushTimer = null; }
    this.flush();
  }

  /** @internal — for tests. */
  isActive(): boolean { return this.active; }
  /** @internal — for tests. */
  getBuffer(): ReadonlyArray<SurrogateEvent> { return this.buffer; }

  private push(ev: SurrogateEvent): void {
    if (this.destroyed) return;
    this.buffer.push(ev);
    if (this.buffer.length >= this.opts.maxBufferedEvents) this.flush();
  }

  private flush(): void {
    if (this.buffer.length === 0) return;
    const events = this.buffer;
    this.buffer = [];
    this.transport.send(REPLAY_INGEST_PATH, {
      sessionId: this.sessionId,
      events,
    });
  }
}

function compact(context?: TimelineContext): Record<string, unknown> {
  if (!context) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(context)) {
    if (value !== undefined && value !== null && value !== '') out[key] = value;
  }
  return out;
}
