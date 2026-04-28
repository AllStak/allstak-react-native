/**
 * URL + header + body redaction utilities for HTTP instrumentation.
 *
 * Hard rules:
 *   - Authorization, Cookie, X-API-Key, Set-Cookie are ALWAYS redacted
 *     (host app cannot opt back into capturing them).
 *   - Query params named `token`, `password`, `api_key`, `apikey`,
 *     `authorization`, `auth`, `secret`, `access_token`, `refresh_token`,
 *     `session` are ALWAYS redacted.
 *   - Host app may add additional names via `redactHeaders` /
 *     `redactQueryParams`; the always-list is the floor, not the ceiling.
 *   - Bodies are truncated to `maxBodyBytes` (default 4096) and replaced
 *     with `'<binary>'` when not safely-stringifiable.
 *
 * URL pattern matching for ignoredUrls / allowedUrls accepts strings
 * (substring match) or RegExp (test-based). String matching is
 * case-insensitive on the URL.
 */

export const ALWAYS_REDACT_HEADERS = new Set([
  'authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'x-auth-token',
  'proxy-authorization',
]);

export const ALWAYS_REDACT_QUERY = new Set([
  'token',
  'password',
  'api_key',
  'apikey',
  'authorization',
  'auth',
  'secret',
  'access_token',
  'refresh_token',
  'session',
  'sessionid',
  'jwt',
]);

export const REDACTED = '[REDACTED]';

export interface HttpTrackingOptions {
  /** Capture request body. Default false. Truncated to maxBodyBytes. */
  captureRequestBody?: boolean;
  /** Capture response body. Default false. Truncated to maxBodyBytes. */
  captureResponseBody?: boolean;
  /**
   * Capture request + response headers. Default false. Hard-redacted
   * names are always stripped regardless of this flag.
   */
  captureHeaders?: boolean;
  /** Additional header names to redact (case-insensitive). */
  redactHeaders?: string[];
  /** Additional query-param names to redact (case-insensitive). */
  redactQueryParams?: string[];
  /**
   * Skip URLs matching any of these patterns. String = case-insensitive
   * substring match; RegExp = `.test()` against the full URL.
   */
  ignoredUrls?: (string | RegExp)[];
  /**
   * If non-empty, only capture URLs matching at least one of these
   * patterns. Takes precedence over ignoredUrls.
   */
  allowedUrls?: (string | RegExp)[];
  /** Max bytes per captured body. Default 4096. */
  maxBodyBytes?: number;
}

export function shouldCaptureUrl(url: string, opts: HttpTrackingOptions): boolean {
  if (!url) return false;
  const lower = url.toLowerCase();
  if (opts.allowedUrls && opts.allowedUrls.length > 0) {
    return opts.allowedUrls.some((p) => matches(p, url, lower));
  }
  if (opts.ignoredUrls && opts.ignoredUrls.length > 0) {
    return !opts.ignoredUrls.some((p) => matches(p, url, lower));
  }
  return true;
}

function matches(pattern: string | RegExp, url: string, lower: string): boolean {
  if (pattern instanceof RegExp) return pattern.test(url);
  if (typeof pattern !== 'string') return false;
  return lower.includes(pattern.toLowerCase());
}

/**
 * Redact sensitive query-string params in a URL. Returns the sanitized
 * URL string. Falls back to the input when URL parsing fails (relative
 * URLs in test environments).
 */
export function redactUrl(url: string, opts: HttpTrackingOptions): string {
  if (!url) return url;
  const extra = (opts.redactQueryParams ?? []).map((s) => s.toLowerCase());
  const redactSet = new Set([...ALWAYS_REDACT_QUERY, ...extra]);

  // Try the URL parser first — handles full URLs cleanly.
  let parsed: URL | null = null;
  try { parsed = new URL(url); } catch { /* relative or malformed */ }

  if (parsed) {
    // Avoid `for…of` on URLSearchParams (the lib's Symbol.iterator typing
    // varies across DOM/dom-iterable lib targets). `forEach` is universal.
    const params = parsed.searchParams;
    let mutated = false;
    const keysToRedact: string[] = [];
    params.forEach((_v, k) => {
      if (redactSet.has(k.toLowerCase())) keysToRedact.push(k);
    });
    for (const k of keysToRedact) {
      params.set(k, REDACTED);
      mutated = true;
    }
    if (mutated) parsed.search = params.toString();
    return parsed.toString();
  }

  // Fallback: regex over the query portion of the URL.
  const qIdx = url.indexOf('?');
  if (qIdx < 0) return url;
  const head = url.slice(0, qIdx);
  const queryAndHash = url.slice(qIdx + 1);
  const hashIdx = queryAndHash.indexOf('#');
  const query = hashIdx < 0 ? queryAndHash : queryAndHash.slice(0, hashIdx);
  const hash = hashIdx < 0 ? '' : queryAndHash.slice(hashIdx);

  const parts = query.split('&').map((pair) => {
    const eq = pair.indexOf('=');
    if (eq < 0) return pair;
    const key = pair.slice(0, eq);
    return redactSet.has(key.toLowerCase()) ? `${key}=${REDACTED}` : pair;
  });
  return `${head}?${parts.join('&')}${hash ? '#' + hash : ''}`;
}

/**
 * Filter + redact an HTTP header dictionary. Returns a NEW object — does
 * not mutate the input. When `captureHeaders` is false returns undefined
 * (no headers in the wire payload at all).
 */
export function sanitizeHeaders(
  headers: Record<string, string | string[] | undefined> | undefined,
  opts: HttpTrackingOptions,
): Record<string, string> | undefined {
  if (!opts.captureHeaders) return undefined;
  if (!headers) return {};
  const extra = (opts.redactHeaders ?? []).map((s) => s.toLowerCase());
  const redactSet = new Set([...ALWAYS_REDACT_HEADERS, ...extra]);
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v == null) continue;
    const lower = k.toLowerCase();
    out[lower] = redactSet.has(lower)
      ? REDACTED
      : Array.isArray(v) ? v.join(', ') : String(v);
  }
  return out;
}

/**
 * Truncate + safely-stringify a body. Returns:
 *   - undefined when capture is disabled
 *   - the stringified body when it's a string / number / plain object
 *   - '<binary>' when it's a Blob / FormData / ArrayBuffer / etc
 *   - truncated string with `…[truncated]` suffix when over maxBodyBytes
 */
export function captureBody(
  body: unknown,
  enabled: boolean,
  maxBodyBytes: number,
): string | undefined {
  if (!enabled) return undefined;
  if (body == null) return undefined;
  let str: string;
  if (typeof body === 'string') str = body;
  else if (typeof body === 'number' || typeof body === 'boolean') str = String(body);
  else if (typeof body === 'object') {
    // Don't try to stringify Blob, FormData, ArrayBuffer, ReadableStream.
    const tag = Object.prototype.toString.call(body);
    if (tag !== '[object Object]' && tag !== '[object Array]') return '<binary>';
    try { str = JSON.stringify(body); } catch { return '<unserializable>'; }
  } else {
    return '<binary>';
  }
  if (str.length > maxBodyBytes) return str.slice(0, maxBodyBytes) + '…[truncated]';
  return str;
}
