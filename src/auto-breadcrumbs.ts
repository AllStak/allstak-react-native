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

export function instrumentConsole(addBreadcrumb: AddBreadcrumbFn): void {
  if (typeof console === 'undefined') return;
  if ((console as any)[CONSOLE_FLAG]) return;

  const origWarn = console.warn;
  const origError = console.error;

  console.warn = function (...args: unknown[]) {
    try { addBreadcrumb('log', args.map(safeString).join(' '), 'warn'); }
    catch { /* never break host */ }
    return origWarn.apply(console, args);
  };
  console.error = function (...args: unknown[]) {
    try { addBreadcrumb('log', args.map(safeString).join(' '), 'error'); }
    catch { /* never break host */ }
    return origError.apply(console, args);
  };
  (console as any)[CONSOLE_FLAG] = true;
}

function safeString(v: unknown): string {
  if (v == null) return String(v);
  if (typeof v === 'string') return v;
  if (v instanceof Error) return `${v.name}: ${v.message}`;
  try { return typeof v === 'object' ? JSON.stringify(v) : String(v); }
  catch { return Object.prototype.toString.call(v); }
}
