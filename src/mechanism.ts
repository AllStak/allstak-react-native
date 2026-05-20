/**
 * Mechanism + exception envelope helpers.
 * extraction for AllStak React Native events.
 *
 * Exposes:
 *   - MechanismType: literal type of the entry-point classification
 *   - buildExceptionChain: walks `error.cause` and returns each linked
 *     exception in `exception.values` order (innermost first)
 *   - extractAxiosRequest: detects `error.isAxiosError === true` and
 *     returns a sanitized request panel suitable for the event payload
 *   - classifyHttpError: HTTP category one of `http_client_error` |
 *     `http_server_error` | `network` | `timeout` | `cancel`
 */

import { parseStack, type StackFrame } from './stack';

export type MechanismType =
  | 'onerror'
  | 'onunhandledrejection'
  | 'errorboundary'
  | 'captureException'
  | 'captureMessage'
  | 'native_crash';

export interface ExceptionValue {
  type: string;
  value: string;
  module?: string;
  stacktrace?: { frames: StackFrame[] };
  mechanism?: {
    type: MechanismType;
    handled: boolean;
    synthetic?: boolean;
    data?: Record<string, unknown>;
  };
}

export interface SanitizedHttpRequest {
  method?: string;
  url_sanitized: string;
  status_code?: number;
  duration_ms?: number;
  category: 'http_client_error' | 'http_server_error' | 'network' | 'timeout' | 'cancel';
}

const URL_QUERY_RE = /\?.*$/;

/**
 * Strip the query string entirely. Headers/auth/etc never leak in
 * the URL-only sanitizer; bodies are never extracted here.
 */
export function sanitizeUrl(url: string | undefined): string {
  if (!url) return '';
  const s = String(url).replace(URL_QUERY_RE, '');
  return s;
}

function exceptionClassName(err: unknown): string {
  if (err && typeof err === 'object') {
    const e = err as Error;
    const fromName = e.name && e.name !== 'Error' ? e.name : undefined;
    return fromName ?? e.constructor?.name ?? 'Error';
  }
  return 'Error';
}

function exceptionValue(err: unknown): string {
  if (err == null) return '';
  if (err instanceof Error) return err.message ?? '';
  if (typeof err === 'string') return err;
  try { return JSON.stringify(err); } catch { return String(err); }
}

/**
 * Walk `error.cause` recursively and return each linked exception as
 * an `ExceptionValue`. The outer (most-recent) exception
 * is the LAST element so the dashboard can render innermost → outer
 * so the causal chain is stable for grouping and display.
 *
 * Hard cap at 5 links to avoid pathological cycles.
 */
export function buildExceptionChain(
  err: Error,
  mechanism: MechanismType,
  handled: boolean,
): ExceptionValue[] {
  const values: ExceptionValue[] = [];
  const seen = new Set<unknown>();
  let cursor: unknown = err;
  let depth = 0;

  while (cursor && depth < 5 && !seen.has(cursor)) {
    seen.add(cursor);
    const e = cursor as Error & { cause?: unknown };
    const frames = parseStack(e?.stack);
    values.push({
      type: exceptionClassName(e),
      value: exceptionValue(e),
      stacktrace: frames.length > 0 ? { frames } : undefined,
      // Only the outermost exception carries the mechanism.
      ...(depth === 0
        ? { mechanism: { type: mechanism, handled } }
        : {}),
    });
    cursor = e?.cause;
    depth += 1;
  }

  // Reverse so innermost cause is first.
  return values.reverse();
}

/**
 * Detect an axios-style error and pull out the request metadata
 * suitable for inclusion in the event payload's `request` panel.
 * Returns null when this is not an AxiosError-shaped object.
 *
 * Privacy: URL query strings are dropped. NO headers or bodies are
 * extracted here regardless of axios config.
 */
export function extractAxiosRequest(err: unknown): SanitizedHttpRequest | null {
  if (!err || typeof err !== 'object') return null;
  const e = err as any;
  if (e.isAxiosError !== true) return null;

  const cfg = e.config ?? {};
  const resp = e.response ?? null;
  const method = strUpper(cfg.method);
  const rawUrl = composeAxiosUrl(cfg);
  const url_sanitized = sanitizeUrl(rawUrl);
  const status_code = typeof resp?.status === 'number' ? resp.status : undefined;
  const duration_ms = typeof e.duration === 'number' ? e.duration : undefined;
  const category = classifyHttpError(e, status_code);

  return {
    method,
    url_sanitized,
    status_code,
    duration_ms,
    category,
  };
}

function composeAxiosUrl(cfg: any): string {
  const base = typeof cfg?.baseURL === 'string' ? cfg.baseURL.replace(/\/$/, '') : '';
  const path = typeof cfg?.url === 'string' ? cfg.url : '';
  if (!base && !path) return '';
  if (path.startsWith('http://') || path.startsWith('https://')) return path;
  return base + path;
}

function strUpper(v: unknown): string | undefined {
  if (typeof v !== 'string' || v.length === 0) return undefined;
  return v.toUpperCase();
}

/**
 * Classify an HTTP/network error into stable AllStak category values.
 *
 * Priority:
 *   1. AxiosError.code === 'ECONNABORTED' / 'ETIMEDOUT' → 'timeout'
 *   2. AxiosError.code === 'ERR_CANCELED' → 'cancel'
 *   3. status 5xx → 'http_server_error'
 *   4. status 4xx → 'http_client_error'
 *   5. fall back to 'network'
 */
export function classifyHttpError(
  err: any,
  status?: number,
): SanitizedHttpRequest['category'] {
  const code = typeof err?.code === 'string' ? err.code.toUpperCase() : '';
  if (code === 'ECONNABORTED' || code === 'ETIMEDOUT') return 'timeout';
  if (code === 'ERR_CANCELED' || code === 'CANCELED') return 'cancel';
  if (typeof status === 'number' && status >= 500) return 'http_server_error';
  if (typeof status === 'number' && status >= 400) return 'http_client_error';
  return 'network';
}

/**
 * Look at a thrown value and decide whether it should carry an HTTP
 * `request` panel (axios is the only auto-detected source today; fetch
 * Response/TypeError still surface as plain errors).
 */
export function maybeExtractHttpRequest(err: unknown): SanitizedHttpRequest | null {
  return extractAxiosRequest(err);
}
