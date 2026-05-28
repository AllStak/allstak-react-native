/**
 * Release-health "one session per app-launch" tracker for React Native.
 *
 * Mirrors the AllStak Java SDK `dev.allstak.session.SessionTracker` lifecycle
 * and status model, adapted to the RN runtime:
 *
 *   - `start()` POSTs `/ingest/v1/sessions/start` once, fail-open, on a
 *     microtask so SDK init never blocks the host app on a network round-trip.
 *   - `recordError()` / `recordCrash()` mutate the in-memory status only — no
 *     network I/O per error keeps capture latency unaffected.
 *   - `end(status?)` POSTs `/ingest/v1/sessions/end` with the final status +
 *     total duration. Idempotent: a second `end()` is a no-op.
 *
 * Sessions are NEVER sampled — they always send (release-health needs the full
 * denominator). The single network path is the SDK's existing `HttpTransport`,
 * so circuit-breaker / ring-buffer / fail-open behavior is inherited for free.
 *
 * One instance per {@link AllStakClient}. Re-entrancy safe: once started a
 * second `start()` returns the existing session id; once ended the tracker does
 * not re-arm within the same launch.
 */

import type { HttpTransport } from './transport';

const PATH_START = '/ingest/v1/sessions/start';
const PATH_END = '/ingest/v1/sessions/end';

/**
 * Lifecycle status of a release-health session. Vocabulary matches the AllStak
 * backend `/ingest/v1/sessions/end` contract and Sentry release-health:
 *   - `ok`       — ended normally with at most non-fatal logs.
 *   - `errored`  — at least one HANDLED error landed; the process kept running.
 *   - `crashed`  — an UNHANDLED / fatal exception ended the app.
 *   - `abnormal` — ended without a normal flush (reserved).
 */
export type SessionStatus = 'ok' | 'errored' | 'crashed' | 'abnormal';

export interface SessionStartFields {
  /** Resolved release; the caller falls back to sdkVersion when no release. */
  release: string;
  environment?: string;
  userId?: string;
  sdkName?: string;
  sdkVersion?: string;
  platform?: string;
}

export interface SessionTrackerOptions {
  /** Pre-existing SDK correlation id; reused as the session id. */
  sessionId: string;
  /** Skip all network I/O (still tracks status). Used under a unit-test runtime. */
  skipNetwork?: boolean;
}

/** A single release-health session — the data half of the tracker. */
export class Session {
  readonly id: string;
  readonly startedAt: number;
  private statusValue: SessionStatus = 'ok';
  private errorCount = 0;

  constructor(id: string, startedAt: number = Date.now()) {
    this.id = id;
    this.startedAt = startedAt;
  }

  get status(): SessionStatus {
    return this.statusValue;
  }

  getErrorCount(): number {
    return this.errorCount;
  }

  /** Increment the error counter and bump OK → ERRORED (terminal states win). */
  recordError(): void {
    this.errorCount += 1;
    if (this.statusValue === 'ok') this.statusValue = 'errored';
  }

  /** Mark a terminal crashed status (overrides ok/errored). */
  recordCrash(): void {
    this.statusValue = 'crashed';
    this.errorCount += 1;
  }

  /** Promote OK/ERRORED → ABNORMAL only. */
  recordAbnormalExit(): void {
    if (this.statusValue === 'ok' || this.statusValue === 'errored') {
      this.statusValue = 'abnormal';
    }
  }

  /** Duration from start to now, floored at 0. */
  durationMs(): number {
    return Math.max(0, Date.now() - this.startedAt);
  }
}

export class SessionTracker {
  private readonly transport: HttpTransport;
  private readonly fields: SessionStartFields;
  private readonly skipNetwork: boolean;
  private active: Session | null = null;
  private started = false;
  private ended = false;

  constructor(transport: HttpTransport, fields: SessionStartFields, options: SessionTrackerOptions) {
    this.transport = transport;
    this.fields = fields;
    this.skipNetwork = options.skipNetwork === true;
    this.active = new Session(options.sessionId);
  }

  /**
   * Idempotent. Returns the active session. The `/sessions/start` POST is fired
   * fail-open and never throws into the caller, so SDK init is never blocked.
   */
  start(): Session | null {
    const session = this.active;
    if (this.ended || !session) return session;
    // Idempotent: a second start() returns the existing session without
    // re-POSTing (mirrors the Java reference's compareAndSet guard).
    if (this.started) return session;
    this.started = true;

    // No release ⇒ release-health cannot attribute the session. Keep the
    // in-memory tracker so errored/crashed transitions still resolve a sensible
    // final status, but skip the network call. Mirrors the Java reference.
    if (this.skipNetwork || !this.transport.isEnabled() || !this.fields.release) {
      return session;
    }

    const payload: Record<string, unknown> = {
      sessionId: session.id,
      release: this.fields.release,
      environment: this.fields.environment,
      userId: this.fields.userId ?? null,
      sdkName: this.fields.sdkName,
      sdkVersion: this.fields.sdkVersion,
      platform: this.fields.platform,
    };

    try {
      // Sessions are never sampled — always send through the existing transport.
      void this.transport.send(PATH_START, payload);
    } catch {
      /* Network failure must never crash app boot. */
    }
    return session;
  }

  /** The active session, or null once started-and-ended. */
  current(): Session | null {
    return this.ended ? null : this.active;
  }

  /** Record a HANDLED error against the active session. No I/O. */
  recordError(): void {
    if (!this.ended) this.active?.recordError();
  }

  /** Record an UNHANDLED / fatal crash. No I/O — `end()` carries the status. */
  recordCrash(): void {
    if (!this.ended) this.active?.recordCrash();
  }

  /**
   * Terminate the session and POST `/sessions/end`. Idempotent. When
   * `finalStatus` is omitted the session's own accumulated status is used.
   * Best-effort, never throws.
   */
  end(finalStatus?: SessionStatus): void {
    if (this.ended) return;
    const session = this.active;
    this.active = null;
    this.ended = true;
    if (!session) return;

    const status = finalStatus ?? session.status;
    if (this.skipNetwork || !this.transport.isEnabled() || !this.fields.release) {
      return;
    }

    const payload: Record<string, unknown> = {
      sessionId: session.id,
      durationMs: session.durationMs(),
      status,
    };

    try {
      void this.transport.send(PATH_END, payload);
    } catch {
      /* Best-effort; must not block or throw on shutdown. */
    }
  }
}
