/**
 * Automatic HTTP instrumentation for React Native — patches `fetch`,
 * `XMLHttpRequest`, and (when found) `axios`.
 *
 * Idempotent: each patch tags itself with a flag so a second `init()` is
 * a no-op rather than stacking wrappers (which would otherwise double-fire
 * events and corrupt response handling on hot reload).
 *
 * Privacy + safety contract:
 *   - URL query params are sanitized via `redactUrl` BEFORE being recorded
 *   - Headers are not recorded unless `captureHeaders: true`
 *   - Bodies are not recorded unless `captureRequestBody`/`captureResponseBody`
 *   - Response body capture clones the Response (or skips when cloning is
 *     unsafe — large/streaming responses) so the consumer's downstream
 *     `.json()` / `.text()` still works without "body already used" errors
 *   - Skips own ingest URLs (`api.allstak.sa/ingest/...`) so wrappers
 *     never recurse on telemetry traffic
 *   - On any internal failure, the original network call is allowed to
 *     proceed — never break consumer networking
 */

import { HttpRequestModule, HttpRequestEvent } from './http-requests';
import {
  HttpTrackingOptions,
  redactUrl,
  sanitizeHeaders,
  shouldCaptureUrl,
  captureBody,
} from './http-redact';

const FETCH_FLAG = '__allstak_http_fetch_patched__';
const XHR_FLAG = '__allstak_http_xhr_patched__';
const AXIOS_FLAG = Symbol.for('allstak.http.axios.instrumented');

const DEFAULT_MAX_BODY = 4096;

// Module-level "current binding" — wrappers route capture calls through
// this so re-init swaps the underlying module without re-wrapping the
// global, and a destroyed module silently no-ops instead of throwing.
let _currentModule: HttpRequestModule | null = null;
let _currentOpts: BoundOptions | null = null;
function currentModule(): HttpRequestModule | null { return _currentModule; }
function currentOpts(): BoundOptions | null { return _currentOpts; }
function safeCapture(ev: HttpRequestEvent): void {
  try { currentModule()?.capture(ev); } catch { /* never break host */ }
}

interface BoundOptions extends Required<Omit<HttpTrackingOptions, 'redactHeaders' | 'redactQueryParams' | 'ignoredUrls' | 'allowedUrls'>> {
  redactHeaders: string[];
  redactQueryParams: string[];
  ignoredUrls: (string | RegExp)[];
  allowedUrls: (string | RegExp)[];
  ownIngestPrefix: string;
}

function bind(opts: HttpTrackingOptions, ownIngestHost: string): BoundOptions {
  return {
    captureRequestBody: opts.captureRequestBody ?? false,
    captureResponseBody: opts.captureResponseBody ?? false,
    captureHeaders: opts.captureHeaders ?? false,
    redactHeaders: opts.redactHeaders ?? [],
    redactQueryParams: opts.redactQueryParams ?? [],
    ignoredUrls: opts.ignoredUrls ?? [],
    allowedUrls: opts.allowedUrls ?? [],
    maxBodyBytes: opts.maxBodyBytes ?? DEFAULT_MAX_BODY,
    ownIngestPrefix: ownIngestHost.replace(/\/$/, ''),
  };
}

function isOwnIngest(url: string, prefix: string): boolean {
  return !!prefix && url.startsWith(prefix);
}

function urlString(input: any): string {
  if (typeof input === 'string') return input;
  if (input && typeof input.href === 'string') return input.href;
  if (input && typeof input.url === 'string') return input.url;
  return String(input);
}

function safeByteLength(s: string | undefined | null): number | undefined {
  if (s == null) return undefined;
  if (typeof s === 'string') {
    // Approximate — UTF-8 byte length without TextEncoder dep.
    let n = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      if (c < 0x80) n += 1;
      else if (c < 0x800) n += 2;
      else if (c >= 0xd800 && c <= 0xdbff) { n += 4; i += 1; }
      else n += 3;
    }
    return n;
  }
  return undefined;
}

function headersToObject(h: any): Record<string, string> {
  if (!h) return {};
  // Headers / Map style (entries())
  if (typeof h.entries === 'function') {
    const out: Record<string, string> = {};
    for (const [k, v] of h.entries()) out[String(k).toLowerCase()] = String(v);
    return out;
  }
  // Plain dict
  if (typeof h === 'object') {
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(h)) {
      if (v == null) continue;
      out[String(k).toLowerCase()] = Array.isArray(v) ? v.join(', ') : String(v);
    }
    return out;
  }
  return {};
}

// ───────────────────────────────────────────────────────────────
// fetch
// ───────────────────────────────────────────────────────────────

export function patchFetch(): void {
  const g: any = globalThis as any;
  if (typeof g.fetch !== 'function') return;
  if (g.fetch[FETCH_FLAG]) return;

  const original = g.fetch;

  const wrapped = async function (this: any, input: any, init?: any): Promise<Response> {
    const opts = currentOpts();
    if (!opts || !currentModule()) {
      // Instrumentation not bound (yet, or re-init mid-flight) — pass through.
      return original.call(this, input, init);
    }
    const rawUrl = urlString(input);
    const sanitizedUrl = redactUrl(rawUrl, opts);
    const method = ((init?.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();

    if (isOwnIngest(rawUrl, opts.ownIngestPrefix) || !shouldCaptureUrl(rawUrl, opts)) {
      return original.call(this, input, init);
    }

    const start = Date.now();
    const reqHeaders = sanitizeHeaders(headersToObject(init?.headers ?? (input && input.headers)), opts);
    const reqBody = captureBody(init?.body, opts.captureRequestBody, opts.maxBodyBytes);
    const reqSize = safeByteLength(typeof init?.body === 'string' ? init.body : undefined);

    let response: any;
    try {
      response = await original.call(this, input, init);
    } catch (err) {
      safeCapture({
        type: 'http_request',
        method, url: sanitizedUrl, statusCode: 0,
        durationMs: Date.now() - start,
        requestBody: reqBody, requestHeaders: reqHeaders, requestSize: reqSize,
        error: String((err as any)?.message ?? err),
      });
      throw err;
    }

    const durationMs = Date.now() - start;
    let respBody: string | undefined;
    let respSize: number | undefined;
    let respHeaders: Record<string, string> | undefined;
    try {
      respHeaders = sanitizeHeaders(headersToObject(response.headers), opts);
      const lenHeader = typeof response.headers?.get === 'function' ? response.headers.get('content-length') : null;
      if (lenHeader) respSize = parseInt(lenHeader, 10) || undefined;

      if (opts.captureResponseBody && typeof response.clone === 'function') {
        try {
          const cloned = response.clone();
          const text = await cloned.text();
          respBody = captureBody(text, true, opts.maxBodyBytes);
          if (respSize == null) respSize = safeByteLength(text);
        } catch { /* clone unsafe — leave body undefined */ }
      }
    } catch { /* never break the response surface */ }

    safeCapture({
      type: 'http_request',
      method, url: sanitizedUrl,
      statusCode: response.status, durationMs,
      requestBody: reqBody, requestHeaders: reqHeaders, requestSize: reqSize,
      responseBody: respBody, responseHeaders: respHeaders, responseSize: respSize,
    });

    return response;
  };
  (wrapped as any)[FETCH_FLAG] = true;
  g.fetch = wrapped;
}

// ───────────────────────────────────────────────────────────────
// XMLHttpRequest
// ───────────────────────────────────────────────────────────────

export function patchXhr(): void {
  const g: any = globalThis as any;
  const X: any = g.XMLHttpRequest;
  if (!X || X.prototype[XHR_FLAG]) return;

  const origOpen = X.prototype.open;
  const origSend = X.prototype.send;
  const origSetRequestHeader = X.prototype.setRequestHeader;

  X.prototype.open = function (method: string, url: string, ...rest: unknown[]) {
    (this as any).__allstak_method__ = method;
    (this as any).__allstak_url__ = url;
    (this as any).__allstak_headers__ = {};
    return origOpen.call(this, method, url, ...rest);
  };

  X.prototype.setRequestHeader = function (name: string, value: string) {
    try { (this as any).__allstak_headers__[String(name).toLowerCase()] = String(value); }
    catch { /* ignore */ }
    return origSetRequestHeader.call(this, name, value);
  };

  X.prototype.send = function (body?: unknown) {
    const opts = currentOpts();
    if (!opts || !currentModule()) return origSend.call(this, body as any);

    const start = Date.now();
    const method = String((this as any).__allstak_method__ || 'GET').toUpperCase();
    const rawUrl = String((this as any).__allstak_url__ || '');
    const sanitizedUrl = redactUrl(rawUrl, opts);

    if (isOwnIngest(rawUrl, opts.ownIngestPrefix) || !shouldCaptureUrl(rawUrl, opts)) {
      return origSend.call(this, body as any);
    }

    const reqHeaders = sanitizeHeaders((this as any).__allstak_headers__, opts);
    const reqBody = captureBody(body, opts.captureRequestBody, opts.maxBodyBytes);
    const reqSize = safeByteLength(typeof body === 'string' ? body : undefined);

    const finish = (statusCode: number, error?: string) => {
      const durationMs = Date.now() - start;
      let respHeaders: Record<string, string> | undefined;
      let respBody: string | undefined;
      let respSize: number | undefined;
      try {
        const liveOpts = currentOpts() ?? opts;
        if (liveOpts.captureHeaders && typeof (this as any).getAllResponseHeaders === 'function') {
          const raw: string = (this as any).getAllResponseHeaders() || '';
          const dict: Record<string, string> = {};
          for (const line of raw.split(/\r?\n/)) {
            const idx = line.indexOf(':');
            if (idx > 0) dict[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
          }
          respHeaders = sanitizeHeaders(dict, liveOpts);
        }
        if (liveOpts.captureResponseBody) {
          const text = (this as any).responseText;
          if (typeof text === 'string') {
            respBody = captureBody(text, true, liveOpts.maxBodyBytes);
            respSize = safeByteLength(text);
          }
        }
      } catch { /* never break */ }

      safeCapture({
        type: 'http_request',
        method, url: sanitizedUrl,
        statusCode, durationMs,
        requestBody: reqBody, requestHeaders: reqHeaders, requestSize: reqSize,
        responseBody: respBody, responseHeaders: respHeaders, responseSize: respSize,
        error,
      });
    };

    this.addEventListener?.('load', () => finish(this.status || 0));
    this.addEventListener?.('error', () => finish(0, 'network'));
    this.addEventListener?.('abort', () => finish(0, 'abort'));
    this.addEventListener?.('timeout', () => finish(0, 'timeout'));
    return origSend.call(this, body as any);
  };

  X.prototype[XHR_FLAG] = true;
}

// ───────────────────────────────────────────────────────────────
// axios — manual instrumentation + best-effort auto-detect
// ───────────────────────────────────────────────────────────────

/**
 * Manually instrument an axios instance. Idempotent — calling twice on
 * the same instance is a no-op. Returns the same instance so it can be
 * used inline:
 *   `const api = AllStak.instrumentAxios(axios.create({...}))`
 *
 * NOTE: under React Native, axios uses XHR under the hood by default, so
 * the XHR patch above already records the same calls. This wrapper is
 * still useful when consumers configure axios with a custom `adapter`
 * that bypasses XHR (e.g. node-style http adapter on RN+Node setups).
 * Both patches are idempotent and de-dup via a per-request flag.
 */
export function instrumentAxiosInstance(
  axiosInstance: any,
  module: HttpRequestModule,
  opts: BoundOptions,
): any {
  if (!axiosInstance || typeof axiosInstance.interceptors !== 'object') return axiosInstance;
  if (axiosInstance[AXIOS_FLAG]) return axiosInstance;
  axiosInstance[AXIOS_FLAG] = true;

  const reqStarts = new WeakMap<object, { start: number; method: string; rawUrl: string }>();

  axiosInstance.interceptors.request.use((config: any) => {
    try {
      const rawUrl = (config.baseURL ? config.baseURL.replace(/\/$/, '') : '') + (config.url || '');
      reqStarts.set(config, {
        start: Date.now(),
        method: String(config.method || 'GET').toUpperCase(),
        rawUrl,
      });
    } catch { /* ignore */ }
    return config;
  });

  const finalize = (cfg: any, statusCode: number, response?: any, error?: string) => {
    const meta = reqStarts.get(cfg);
    if (!meta) return;
    reqStarts.delete(cfg);
    if (isOwnIngest(meta.rawUrl, opts.ownIngestPrefix)) return;
    if (!shouldCaptureUrl(meta.rawUrl, opts)) return;

    const sanitizedUrl = redactUrl(meta.rawUrl, opts);
    const reqHeaders = sanitizeHeaders(headersToObject(cfg.headers), opts);
    const reqBody = captureBody(cfg.data, opts.captureRequestBody, opts.maxBodyBytes);
    const respHeaders = sanitizeHeaders(headersToObject(response?.headers), opts);
    const respBody = captureBody(response?.data, opts.captureResponseBody, opts.maxBodyBytes);

    try {
      module.capture({
        type: 'http_request',
        method: meta.method,
        url: sanitizedUrl,
        statusCode,
        durationMs: Date.now() - meta.start,
        requestBody: reqBody,
        requestHeaders: reqHeaders,
        responseBody: respBody,
        responseHeaders: respHeaders,
        error,
      });
    } catch { /* ignore */ }
  };

  axiosInstance.interceptors.response.use(
    (response: any) => { finalize(response.config, response.status); return response; },
    (err: any) => {
      const cfg = err?.config;
      const status = err?.response?.status ?? 0;
      finalize(cfg, status, err?.response, String(err?.message ?? err));
      throw err;
    },
  );
  return axiosInstance;
}

/**
 * Best-effort auto-detect: attempt to require('axios') and instrument the
 * default singleton. Silently no-ops when axios isn't installed (the
 * common case — most apps either don't use axios or import it via ES
 * modules and would call instrumentAxios manually).
 */
export function tryAutoInstrumentAxios(module: HttpRequestModule, opts: BoundOptions): void {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const axios = (globalThis as any).require?.('axios') ?? null;
    if (axios) instrumentAxiosInstance(axios.default ?? axios, module, opts);
  } catch { /* axios not installed */ }
}

// ───────────────────────────────────────────────────────────────
// Top-level orchestrator
// ───────────────────────────────────────────────────────────────

export function installHttpInstrumentation(
  module: HttpRequestModule,
  options: HttpTrackingOptions,
  ownIngestHost: string,
): { instrumentAxios: (axios: any) => any } {
  const bound = bind(options, ownIngestHost);
  // Bind first so already-installed wrappers immediately route to the new
  // module/options. Subsequent patch* calls are idempotent no-ops.
  _currentModule = module;
  _currentOpts = bound;
  try { patchFetch(); } catch { /* ignore */ }
  try { patchXhr(); } catch { /* ignore */ }
  try { tryAutoInstrumentAxios(module, bound); } catch { /* ignore */ }
  return {
    instrumentAxios: (axios: any) => instrumentAxiosInstance(axios, module, bound),
  };
}

/** Called by AllStakClient.destroy() so wrappers go quiet between inits. */
export function unbindHttpInstrumentation(): void {
  _currentModule = null;
  _currentOpts = null;
}

/** @internal — for tests. */
export function __resetForTest(): void {
  const g: any = globalThis as any;
  if (g.fetch && g.fetch[FETCH_FLAG]) {
    // No way to recover original without saving — tests use freshly-set fetch.
  }
  if (g.XMLHttpRequest && g.XMLHttpRequest.prototype[XHR_FLAG]) {
    delete g.XMLHttpRequest.prototype[XHR_FLAG];
  }
}
