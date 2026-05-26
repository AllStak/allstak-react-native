/**
 * Rich event context tests for the 0.5.0 enrichment.
 *
 * Verifies the SDK emits `eventId`, `timestamp`, `handled`,
 * `mechanism`, `transaction`, `exception.values`, `contexts.*`, and the
 * AxiosError request panel; plus beforeBreadcrumb / denyUrls / allowUrls /
 * scrubKeys / bounded breadcrumb buffer / cause chain.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const mockFetch = async (url, init) => {
  sent.push({ url, init, body: init?.body ? JSON.parse(init.body) : null });
  return new Response(JSON.stringify({ success: true, data: { id: 'srv-1' } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', {
  get() { return mockFetch; },
  configurable: false,
});

const {
  AllStak,
  buildExceptionChain,
  extractAxiosRequest,
  classifyHttpError,
  sanitizeUrl,
  collectAutoContexts,
  buildAutoRelease,
  buildUserContext,
  SDK_VERSION,
} = await import('../dist/index.mjs');

function lastBody() { return sent[sent.length - 1]?.body; }
function waitTransport() { return new Promise((r) => setTimeout(r, 60)); }
function init(extra = {}) {
  AllStak.destroy?.();
  AllStak.init({ apiKey: 'ask_test_key', environment: 'test', release: '0.5.0-test', ...extra });
}

// ── exception.values shape + mechanism ─────────────────────────

test('captureException emits eventId + timestamp + handled + mechanism', async () => {
  init();
  sent.length = 0;
  AllStak.captureException(new Error('manual'));
  await waitTransport();
  const b = lastBody();
  assert.ok(b.eventId, 'eventId stamped');
  assert.match(b.eventId, /^[0-9a-f-]{36}$/);
  assert.ok(b.timestamp, 'timestamp stamped');
  assert.equal(b.handled, true);
  assert.equal(b.mechanism, 'captureException');
});

test('exception.values is built from the error stack', async () => {
  init();
  sent.length = 0;
  AllStak.captureException(new Error('with-stack'));
  await waitTransport();
  const b = lastBody();
  assert.ok(b.exception?.values, 'exception.values present');
  assert.ok(b.exception.values.length >= 1);
  const last = b.exception.values[b.exception.values.length - 1];
  assert.equal(last.type, 'Error');
  assert.equal(last.value, 'with-stack');
  assert.ok(last.mechanism, 'outermost carries mechanism');
  assert.equal(last.mechanism.type, 'captureException');
  assert.equal(last.mechanism.handled, true);
});

test('error.cause chain produces multiple linked exceptions (innermost first)', async () => {
  init();
  sent.length = 0;
  const inner = new Error('root cause');
  inner.name = 'RootError';
  const middle = new Error('middle');
  middle.cause = inner;
  middle.name = 'MiddleError';
  const outer = new Error('top');
  outer.cause = middle;
  AllStak.captureException(outer);
  await waitTransport();
  const values = lastBody().exception.values;
  assert.equal(values.length, 3);
  assert.equal(values[0].type, 'RootError');
  assert.equal(values[1].type, 'MiddleError');
  assert.equal(values[2].type, 'Error');
  // mechanism only on outermost
  assert.ok(values[2].mechanism);
  assert.equal(values[0].mechanism, undefined);
  assert.equal(values[1].mechanism, undefined);
});

test('mechanism + handled flow through captureException opts', async () => {
  init();
  sent.length = 0;
  AllStak.captureException(new Error('unhandled'), undefined,
    { mechanism: 'onunhandledrejection', handled: false });
  await waitTransport();
  const b = lastBody();
  assert.equal(b.mechanism, 'onunhandledrejection');
  assert.equal(b.handled, false);
});

test('cause chain hard-caps at 5 to defend against cycles', async () => {
  init();
  sent.length = 0;
  const a = new Error('a');
  const b = new Error('b'); b.cause = a;
  const c = new Error('c'); c.cause = b;
  const d = new Error('d'); d.cause = c;
  const e = new Error('e'); e.cause = d;
  const f = new Error('f'); f.cause = e;
  const g = new Error('g'); g.cause = f;
  AllStak.captureException(g);
  await waitTransport();
  assert.ok(lastBody().exception.values.length <= 5);
});

// ── AxiosError extraction ──────────────────────────────────────

test('extractAxiosRequest returns null for non-axios errors', () => {
  assert.equal(extractAxiosRequest(new Error('plain')), null);
  assert.equal(extractAxiosRequest({}), null);
});

test('extractAxiosRequest pulls method/url/status from an AxiosError', () => {
  const err = {
    isAxiosError: true,
    message: 'Request failed with status code 404',
    config: { method: 'get', url: '/items/42', baseURL: 'https://api.example.com' },
    response: { status: 404 },
    code: 'ERR_BAD_REQUEST',
  };
  const r = extractAxiosRequest(err);
  assert.ok(r);
  assert.equal(r.method, 'GET');
  assert.equal(r.url_sanitized, 'https://api.example.com/items/42');
  assert.equal(r.status_code, 404);
  assert.equal(r.category, 'http_client_error');
});

test('AxiosError URL has query string stripped', () => {
  const err = {
    isAxiosError: true,
    config: { method: 'post', url: 'https://api.example.com/login?token=secret&user=jane' },
    response: { status: 401 },
  };
  assert.equal(extractAxiosRequest(err).url_sanitized, 'https://api.example.com/login');
});

test('classifyHttpError covers timeout / cancel / 4xx / 5xx / network', () => {
  assert.equal(classifyHttpError({ code: 'ECONNABORTED' }), 'timeout');
  assert.equal(classifyHttpError({ code: 'ETIMEDOUT' }), 'timeout');
  assert.equal(classifyHttpError({ code: 'ERR_CANCELED' }), 'cancel');
  assert.equal(classifyHttpError({}, 503), 'http_server_error');
  assert.equal(classifyHttpError({}, 404), 'http_client_error');
  assert.equal(classifyHttpError({}, 200), 'network');
  assert.equal(classifyHttpError({}), 'network');
});

test('captureException attaches request panel for AxiosError', async () => {
  init();
  sent.length = 0;
  const err = Object.assign(new Error('Request failed'), {
    isAxiosError: true,
    config: { method: 'GET', url: 'https://api.example.com/x?secret=1' },
    response: { status: 500 },
  });
  AllStak.captureException(err);
  await waitTransport();
  const b = lastBody();
  assert.ok(b.request, 'request panel');
  assert.equal(b.request.method, 'GET');
  assert.equal(b.request.url_sanitized, 'https://api.example.com/x');
  assert.equal(b.request.status_code, 500);
  assert.equal(b.request.category, 'http_server_error');
});

test('sanitizeUrl drops query', () => {
  assert.equal(sanitizeUrl('https://x.com/p?q=1&t=secret'), 'https://x.com/p');
  assert.equal(sanitizeUrl(''), '');
  assert.equal(sanitizeUrl(undefined), '');
});

// ── auto-contexts ──────────────────────────────────────────────

test('collectAutoContexts returns shape even without optional deps', () => {
  const { contexts, tags } = collectAutoContexts();
  // Always at least react_native + runtime
  assert.ok(contexts.react_native);
  assert.ok(contexts.runtime);
  // tags always include js_engine, fabric, turbo_modules
  assert.ok(tags.js_engine);
  assert.ok(typeof tags.fabric === 'string');
  assert.ok(typeof tags.turbo_modules === 'string');
});

test('buildAutoRelease derives release from app id/version/build', () => {
  assert.equal(
    buildAutoRelease({
      app_identifier: 'com.allstak.demo',
      app_version: '1.2.3',
      app_build: '45',
    }),
    'com.allstak.demo@1.2.3+45',
  );
  assert.equal(buildAutoRelease({ app_version: '1.2.3' }), 'mobile@1.2.3');
});

test('init auto-detects release when omitted', async () => {
  const previousRequire = globalThis.require;
  globalThis.require = (id) => {
    if (id === 'expo-application') {
      return {
        applicationId: 'com.allstak.auto',
        nativeApplicationVersion: '2.4.0',
        nativeBuildVersion: '88',
      };
    }
    throw new Error(`module not found: ${id}`);
  };
  try {
    init({ release: undefined });
    sent.length = 0;
    AllStak.captureException(new Error('auto-release'));
    await waitTransport();
    const b = lastBody();
    assert.equal(b.release, 'com.allstak.auto@2.4.0+88');
    assert.equal(b.tags.release, 'com.allstak.auto@2.4.0+88');
  } finally {
    if (previousRequire) globalThis.require = previousRequire;
    else delete globalThis.require;
  }
});

test('captureException stamps contexts.react_native + contexts.runtime', async () => {
  init();
  sent.length = 0;
  AllStak.captureException(new Error('ctx'));
  await waitTransport();
  const b = lastBody();
  assert.ok(b.contexts);
  assert.ok(b.contexts.react_native);
  assert.ok(b.contexts.runtime);
});

test('buildUserContext respects sendDefaultPii', () => {
  const u = { id: 'u1', email: 'a@b.c', username: 'jane' };
  const r1 = buildUserContext(u, { sendDefaultPii: false });
  assert.equal(r1.email, undefined);
  assert.equal(r1.id, 'u1');
  assert.equal(r1.username, 'jane');
  const r2 = buildUserContext(u, { sendDefaultPii: true });
  assert.equal(r2.email, 'a@b.c');
});

test('event includes contexts.user when configured (no PII by default)', async () => {
  init({ user: { id: 'u-42', email: 'a@b.c' } });
  sent.length = 0;
  AllStak.captureException(new Error('user'));
  await waitTransport();
  const b = lastBody();
  assert.equal(b.contexts?.user?.id, 'u-42');
  assert.equal(b.contexts?.user?.email, undefined);
});

test('event includes contexts.user.email when sendDefaultPii=true', async () => {
  init({ user: { id: 'u-42', email: 'a@b.c' }, sendDefaultPii: true });
  sent.length = 0;
  AllStak.captureException(new Error('user-pii'));
  await waitTransport();
  assert.equal(lastBody().contexts.user.email, 'a@b.c');
});

// ── transaction / setCurrentScreen ─────────────────────────────

test('setCurrentScreen stamps transaction on subsequent events', async () => {
  init();
  AllStak.setCurrentScreen('HomeScreen');
  assert.equal(AllStak.getCurrentTransaction(), 'HomeScreen');
  sent.length = 0;
  AllStak.captureException(new Error('on screen'));
  await waitTransport();
  assert.equal(lastBody().transaction, 'HomeScreen');
});

test('setCurrentScreen emits a navigation breadcrumb when changing', async () => {
  init();
  AllStak.setCurrentScreen('A');
  AllStak.setCurrentScreen('B');
  sent.length = 0;
  AllStak.captureException(new Error('crumb'));
  await waitTransport();
  const crumbs = lastBody().breadcrumbs ?? [];
  const navs = crumbs.filter((c) => c.type === 'navigation');
  assert.ok(navs.length >= 2);
  assert.equal(navs[navs.length - 1].data?.to, 'B');
});

// ── breadcrumbs: buffer / beforeBreadcrumb / denyUrls / allowUrls / scrubKeys ──

test('bounded breadcrumb buffer evicts oldest at cap (default 100)', async () => {
  init({ maxBreadcrumbs: 5 });
  for (let i = 0; i < 12; i++) AllStak.addBreadcrumb('default', `m${i}`, 'info');
  sent.length = 0;
  AllStak.captureException(new Error('cap'));
  await waitTransport();
  const crumbs = lastBody().breadcrumbs ?? [];
  assert.equal(crumbs.length, 5);
  assert.equal(crumbs[0].message, 'm7'); // 0..6 evicted
  assert.equal(crumbs[4].message, 'm11');
});

test('beforeBreadcrumb mutation propagates', async () => {
  init({
    beforeBreadcrumb: (c) => ({ ...c, message: `[hooked] ${c.message}` }),
  });
  AllStak.addBreadcrumb('default', 'orig', 'info');
  sent.length = 0;
  AllStak.captureException(new Error('hook'));
  await waitTransport();
  const crumbs = lastBody().breadcrumbs ?? [];
  assert.ok(crumbs.find((c) => c.message === '[hooked] orig'));
});

test('beforeBreadcrumb returning null drops the breadcrumb', async () => {
  init({ beforeBreadcrumb: () => null });
  AllStak.addBreadcrumb('default', 'dropped', 'info');
  sent.length = 0;
  AllStak.captureException(new Error('drop-bc'));
  await waitTransport();
  const crumbs = lastBody().breadcrumbs ?? [];
  assert.equal(crumbs.find((c) => c.message === 'dropped'), undefined);
});

test('beforeBreadcrumb throwing falls open (original breadcrumb appended)', async () => {
  init({ beforeBreadcrumb: () => { throw new Error('hook-broke'); } });
  AllStak.addBreadcrumb('default', 'still-here', 'info');
  sent.length = 0;
  AllStak.captureException(new Error('hook-throw'));
  await waitTransport();
  const crumbs = lastBody().breadcrumbs ?? [];
  assert.ok(crumbs.find((c) => c.message === 'still-here'));
});

test('denyUrls drops http breadcrumbs whose URL matches', async () => {
  init({ denyUrls: ['blocked.example.com', /\.tracker\./] });
  AllStak.addBreadcrumb('http', 'GET allowed', 'info', { url: 'https://ok.com/api' });
  AllStak.addBreadcrumb('http', 'GET deny', 'info', { url: 'https://blocked.example.com/x' });
  AllStak.addBreadcrumb('http', 'GET deny-rx', 'info', { url: 'https://foo.tracker.io/p' });
  sent.length = 0;
  AllStak.captureException(new Error('deny-bc'));
  await waitTransport();
  const urls = (lastBody().breadcrumbs ?? [])
    .filter((c) => c.type === 'http')
    .map((c) => c.data.url);
  assert.deepEqual(urls, ['https://ok.com/api']);
});

test('allowUrls restricts http breadcrumbs to matching URLs', async () => {
  init({ allowUrls: ['api.allowed.com'] });
  AllStak.addBreadcrumb('http', 'a', 'info', { url: 'https://api.allowed.com/x' });
  AllStak.addBreadcrumb('http', 'b', 'info', { url: 'https://elsewhere.com/x' });
  sent.length = 0;
  AllStak.captureException(new Error('allow-bc'));
  await waitTransport();
  const urls = (lastBody().breadcrumbs ?? [])
    .filter((c) => c.type === 'http')
    .map((c) => c.data.url);
  assert.deepEqual(urls, ['https://api.allowed.com/x']);
});

test('scrubKeys replaces matching breadcrumb data keys with [Filtered]', async () => {
  init({ scrubKeys: ['token', 'authorization'] });
  AllStak.addBreadcrumb('default', 'auth', 'info', { token: 'shhh', user: 'jane' });
  sent.length = 0;
  AllStak.captureException(new Error('scrub'));
  await waitTransport();
  const c = (lastBody().breadcrumbs ?? []).find((c) => c.message === 'auth');
  assert.equal(c.data.token, '[Filtered]');
  assert.equal(c.data.user, 'jane');
});

// ── tags + trace context ───────────────────────────────────────

test('event.tags includes auto-tags + environment + release + dist', async () => {
  init({ release: 'v1', dist: 'ios-cert-1' });
  sent.length = 0;
  AllStak.captureException(new Error('tags'));
  await waitTransport();
  const t = lastBody().tags;
  assert.equal(t.environment, 'test');
  assert.equal(t.release, 'v1');
  assert.equal(t.dist, 'ios-cert-1');
  assert.ok(t.js_engine, 'js_engine auto-tag');
});

test('contexts.trace has trace_id/span_id when an active trace exists', async () => {
  init();
  AllStak.setTraceId('aabbccdd' + '0'.repeat(24));
  sent.length = 0;
  AllStak.captureException(new Error('trace'));
  await waitTransport();
  const tc = lastBody().contexts?.trace;
  assert.ok(tc);
  assert.ok(tc.trace_id);
});

// ── exception chain unit-level ─────────────────────────────────

test('buildExceptionChain mechanism only on outermost', () => {
  const inner = new Error('root');
  const outer = new Error('top');
  outer.cause = inner;
  const values = buildExceptionChain(outer, 'onerror', false);
  assert.equal(values.length, 2);
  assert.equal(values[0].mechanism, undefined);
  assert.equal(values[1].mechanism.type, 'onerror');
  assert.equal(values[1].mechanism.handled, false);
});

test('buildExceptionChain handles single error', () => {
  const values = buildExceptionChain(new Error('solo'), 'captureException', true);
  assert.equal(values.length, 1);
  assert.equal(values[0].mechanism.handled, true);
});

// ── SDK identity / version ─────────────────────────────────────

test('SDK version on the wire matches the package SDK_VERSION', async () => {
  init();
  sent.length = 0;
  AllStak.captureException(new Error('v'));
  await waitTransport();
  assert.equal(lastBody().sdkVersion, SDK_VERSION);
});

// ── no leaks of sensitive headers ──────────────────────────────

test('AxiosError extraction never includes headers or body', () => {
  const err = {
    isAxiosError: true,
    config: {
      method: 'post',
      url: 'https://api.example.com/auth',
      headers: { Authorization: 'Bearer SECRET', Cookie: 'sid=abc' },
      data: { password: 'hunter2' },
    },
    response: { status: 401, headers: { 'set-cookie': 'evil' } },
  };
  const r = extractAxiosRequest(err);
  assert.ok(r);
  assert.equal(r.headers, undefined);
  assert.equal(r.body, undefined);
  assert.equal(JSON.stringify(r).includes('Bearer'), false);
  assert.equal(JSON.stringify(r).includes('hunter2'), false);
});

// ── handled defaults per mechanism ─────────────────────────────

test('default handled flag matches mechanism semantics', async () => {
  init();
  sent.length = 0;
  AllStak.captureException(new Error('eb'), undefined, { mechanism: 'errorboundary' });
  await waitTransport();
  assert.equal(lastBody().handled, true);

  sent.length = 0;
  AllStak.captureException(new Error('un'), undefined, { mechanism: 'onerror' });
  await waitTransport();
  assert.equal(lastBody().handled, false);
});

// ── timestamp is recent ────────────────────────────────────────

test('event.timestamp is within 1s of capture', async () => {
  init();
  sent.length = 0;
  const before = Date.now();
  AllStak.captureException(new Error('ts'));
  await waitTransport();
  const ts = new Date(lastBody().timestamp).getTime();
  assert.ok(Math.abs(ts - before) < 1500);
});
