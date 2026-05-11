/**
 * Idempotent instrumentation of `globalThis.fetch` and `console.warn/error`
 * to feed breadcrumbs into the AllStak client. Safe to call once at init.
 *
 * - `instrumentFetch`: wraps fetch and records a breadcrumb per request
 *   (success and failure). Skips requests targeting the SDK's own ingest
 *   host so the wrap never recurses. Preserves the original return type
 *   and rethrows fetch errors after the breadcrumb is recorded.
 * - `instrumentConsole`: wraps `console.warn` and `console.error` to
 *   record `log`-type breadcrumbs at the corresponding level.
 *
 * Both patches use a flag on the wrapper function so a second call is a
 * no-op — important because hot-module-reload in dev would otherwise
 * stack patches and double-fire breadcrumbs.
 */

type AddBreadcrumbFn = (
  type: string,
  msg: string,
  level?: string,
  data?: Record<string, unknown>,
) => void;

const FETCH_FLAG = '__allstak_fetch_patched__';
const CONSOLE_FLAG = '__allstak_console_patched__';

export function instrumentFetch(
  addBreadcrumb: AddBreadcrumbFn,
  ownBaseUrl?: string,
): void {
  const g: any = globalThis as any;
  if (typeof g.fetch !== 'function') return;
  if (g.fetch[FETCH_FLAG]) return;

  const originalFetch = g.fetch;

  const wrapped = async function (this: any, input: any, init?: any) {
    const method = (init?.method || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
    let url: string;
    if (typeof input === 'string') url = input;
    else if (input && typeof input.href === 'string') url = input.href;
    else if (input && typeof input.url === 'string') url = input.url;
    else url = String(input);

    // Strip query string from the breadcrumb to avoid leaking secrets.
    const safePath = url.split('?')[0];
    const isOwnIngest = !!(ownBaseUrl && url.startsWith(ownBaseUrl));

    const start = Date.now();
    try {
      const response = await originalFetch.call(this, input, init);
      const durationMs = Date.now() - start;
      if (!isOwnIngest) {
        addBreadcrumb(
          'http',
          `${method} ${safePath} -> ${response.status}`,
          response.status >= 400 ? 'error' : 'info',
          { method, url: safePath, statusCode: response.status, durationMs },
        );
      }
      return response;
    } catch (err) {
      const durationMs = Date.now() - start;
      if (!isOwnIngest) {
        addBreadcrumb('http', `${method} ${safePath} -> failed`, 'error', {
          method, url: safePath, error: String(err), durationMs,
        });
      }
      throw err;
    }
  };
  (wrapped as any)[FETCH_FLAG] = true;
  g.fetch = wrapped;
}

/**
 * Per-console-method capture flags. Defaults are set to keep the
 * dashboard signal-to-noise high: `warn` and `error` capture by default
 * (most apps fire those at human-meaningful moments), `log` and `info`
 * are OFF by default since typical apps log thousands of debug lines
 * per session.
 *
 * Override per-method:
 *
 *   <AllStakProvider captureConsole={{ log: true, info: true }} />
 *
 * Or to fully suppress:
 *
 *   <AllStakProvider captureConsole={{ warn: false, error: false }} />
 *
 * Setting `autoConsoleBreadcrumbs={false}` on the provider/install is a
 * higher-level kill switch — it skips wrapping any console method.
 */
export interface ConsoleCaptureOptions {
  log?: boolean;
  info?: boolean;
  warn?: boolean;
  error?: boolean;
}

const CONSOLE_DEFAULTS: Required<ConsoleCaptureOptions> = {
  log: false,
  info: false,
  warn: true,
  error: true,
};

const CONSOLE_METHOD_TO_LEVEL: Record<keyof ConsoleCaptureOptions, string> = {
  log: 'info',
  info: 'info',
  warn: 'warn',
  error: 'error',
};

/** Max bytes per stringified arg. Anything longer is suffixed with `…[truncated]`. */
const MAX_ARG_BYTES = 5000;

export function instrumentConsole(
  addBreadcrumb: AddBreadcrumbFn,
  options: ConsoleCaptureOptions = {},
): void {
  if (typeof console === 'undefined') return;
  if ((console as any)[CONSOLE_FLAG]) return;

  const opts: Required<ConsoleCaptureOptions> = {
    log: options.log ?? CONSOLE_DEFAULTS.log,
    info: options.info ?? CONSOLE_DEFAULTS.info,
    warn: options.warn ?? CONSOLE_DEFAULTS.warn,
    error: options.error ?? CONSOLE_DEFAULTS.error,
  };

  const wrap = (method: keyof ConsoleCaptureOptions): void => {
    const orig = (console as any)[method];
    if (typeof orig !== 'function') return;
    const level = CONSOLE_METHOD_TO_LEVEL[method];
    (console as any)[method] = function (...args: unknown[]) {
      if (opts[method]) {
        try {
          const serialized = args.map(safeStringifyArg);
          const message = truncate(serialized.join(' '));
          addBreadcrumb('log', message, level, {
            category: 'console',
            method,
            args: serialized,
          });
        } catch { /* never break host */ }
      }
      return orig.apply(console, args);
    };
  };

  // Wrap every method whose flag is true. We always wrap if the flag is on
  // and never wrap if off — so toggling at runtime requires re-init (kept
  // simple to avoid stacking wrappers on hot reload).
  if (opts.log) wrap('log');
  if (opts.info) wrap('info');
  if (opts.warn) wrap('warn');
  if (opts.error) wrap('error');

  (console as any)[CONSOLE_FLAG] = true;
}

/** @internal — for tests. Resets the wrap-once flag. */
export function __resetConsoleInstrumentationFlagForTest(): void {
  if (typeof console !== 'undefined') {
    delete (console as any)[CONSOLE_FLAG];
  }
}

/**
 * Safely stringify a single console arg. Handles primitives, Errors,
 * arrays, plain objects, and circular references. Falls back to
 * Object.prototype.toString.call(v) on any failure.
 */
function safeStringifyArg(v: unknown): string {
  if (v === null || v === undefined) return String(v);
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') return String(v);
  if (typeof v === 'symbol') return v.toString();
  if (typeof v === 'function') return `[Function${v.name ? ` ${v.name}` : ''}]`;
  if (v instanceof Error) {
    return `${v.name || 'Error'}: ${v.message}${v.stack ? `\n${v.stack}` : ''}`;
  }
  if (typeof v === 'object') {
    try {
      const seen = new WeakSet<object>();
      const out = JSON.stringify(v, (_key, val) => {
        if (typeof val === 'object' && val !== null) {
          if (seen.has(val as object)) return '[Circular]';
          seen.add(val as object);
        }
        if (typeof val === 'bigint') return val.toString();
        if (typeof val === 'function') return `[Function${val.name ? ` ${val.name}` : ''}]`;
        if (typeof val === 'symbol') return val.toString();
        return val;
      });
      // JSON.stringify can return undefined (e.g. for a function root that
      // we already handled above; guard regardless).
      return out ?? Object.prototype.toString.call(v);
    } catch {
      return Object.prototype.toString.call(v);
    }
  }
  return String(v);
}

function truncate(s: string): string {
  if (s.length <= MAX_ARG_BYTES) return s;
  return s.slice(0, MAX_ARG_BYTES) + '…[truncated]';
}
