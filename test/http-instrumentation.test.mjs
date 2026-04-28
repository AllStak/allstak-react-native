/**
 * Auto HTTP instrumentation tests for @allstak/react-native.
 *
 * Covers every case from the brief:
 *   1. fetch success                                        — body+headers default OFF
 *   2. fetch failure (network throw)                        — captures error string + rethrows
 *   3. fetch POST with body capture OFF (default)           — no body in payload
 *   4. fetch POST with body capture ON                      — body present, headers redacted
 *   5. URL query-param redaction (default + custom)         — token/password/api_key always redacted
 *   6. header redaction (Authorization + Cookie always)     — even with captureHeaders ON
 *   7. XHR success                                          — wraps open/send, fires load
 *   8. XHR failure                                          — fires error, captures error='network'
 *   9. axios manual instrumentation (instrumentAxios)       — interceptors fire
 *  10. idempotent patching                                  — second init does not double-fire
 *  11. ignoredUrls / allowedUrls                            — pattern match works
 *  12. response clone safety                                — body capture skipped when unsafe
 *  13. recent failed request attached to next captureException
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
let nextFetchBehavior = 'success'; // 'success' | 'fail' | 'status:NNN'
let nextResponseBody = 'ok';
let nextResponseStatus = 200;
let returnNoCloneResponse = false; // test 12 toggles this

const baseFetch = async (url, init) => {
  const u = String(url);
  if (/api\.allstak\.sa/.test(u)) {
    sent.push({ url: u, init });
    return new Response('{}', { status: 200 });
  }
  if (nextFetchBehavior === 'fail') throw new Error('network down');
  let status = nextResponseStatus;
  if (nextFetchBehavior.startsWith('status:')) status = parseInt(nextFetchBehavior.slice(7), 10);
  if (returnNoCloneResponse) {
    // Mimic a Response without clone() — wrappers must skip body capture
    // gracefully and still record metadata.
    return {
      status,
      headers: { get: () => null, entries: () => [].entries() },
      // intentionally no clone()
    };
  }
  return new Response(nextResponseBody, {
    status,
    headers: { 'content-type': 'text/plain', 'content-length': String(nextResponseBody.length) },
  });
};
Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

const { AllStak } = await import('../dist/index.mjs');
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

const httpPath = (s) => /\/ingest\/v1\/http-requests$/.test(s.url);
const errPath = (s) => /\/ingest\/v1\/errors$/.test(s.url);
const allHttpEvents = () => sent
  .filter(httpPath)
  .flatMap((s) => JSON.parse(s.init.body).requests);

// ───────────────────────────────────────────────────────────────

test('1. fetch success — captures method/url/status/duration; body+headers OFF by default', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', release: 'r', enableHttpTracking: true });
  await fetch('https://api.example.com/users');
  AllStak.destroy();
  await wait(20);
  const events = allHttpEvents();
  assert.equal(events.length, 1);
  const e = events[0];
  assert.equal(e.method, 'GET');
  assert.equal(e.url, 'https://api.example.com/users');
  assert.equal(e.statusCode, 200);
  assert.ok(typeof e.durationMs === 'number');
  assert.equal(e.requestBody, undefined, 'body OFF by default');
  assert.equal(e.responseBody, undefined, 'body OFF by default');
  assert.equal(e.requestHeaders, undefined, 'headers OFF by default');
});

test('2. fetch failure — records error string and re-throws', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', enableHttpTracking: true });
  nextFetchBehavior = 'fail';
  await assert.rejects(() => fetch('https://api.example.com/will-fail'), /network/);
  nextFetchBehavior = 'success';
  AllStak.destroy();
  await wait(20);
  const events = allHttpEvents();
  const failed = events.find((e) => e.url.includes('will-fail'));
  assert.ok(failed, 'failed event must be recorded');
  assert.equal(failed.statusCode, 0);
  assert.match(failed.error, /network/);
});

test('3. fetch POST with body capture OFF — body not present', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', enableHttpTracking: true });
  await fetch('https://api.example.com/items', {
    method: 'POST',
    body: JSON.stringify({ price: 10 }),
  });
  AllStak.destroy();
  await wait(20);
  const e = allHttpEvents().find((x) => x.method === 'POST');
  assert.equal(e.requestBody, undefined);
});

test('4. fetch POST with body capture ON — body present + truncated to maxBodyBytes', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    enableHttpTracking: true,
    httpTracking: { captureRequestBody: true, captureResponseBody: true, maxBodyBytes: 16 },
  });
  nextResponseBody = 'a'.repeat(1000);
  await fetch('https://api.example.com/items', { method: 'POST', body: 'request payload here' });
  AllStak.destroy();
  await wait(20);
  const e = allHttpEvents().find((x) => x.method === 'POST');
  assert.ok(e.requestBody, 'request body must be captured');
  assert.ok(e.requestBody.length <= 16 + '…[truncated]'.length, 'body must be truncated');
  assert.match(e.requestBody, /…\[truncated\]$/);
  assert.match(e.responseBody, /…\[truncated\]$/);
  nextResponseBody = 'ok';
});

test('5. URL query-param redaction — default + custom redact lists', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    enableHttpTracking: true,
    httpTracking: { redactQueryParams: ['custom_secret'] },
  });
  await fetch('https://api.example.com/x?token=abc&user_id=1&password=hunter2&api_key=xyz&custom_secret=top');
  AllStak.destroy();
  await wait(20);
  const e = allHttpEvents().find((x) => x.path === '/x');
  // user_id remains; everything else is [REDACTED]
  assert.match(e.url, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
  assert.match(e.url, /password=%5BREDACTED%5D|password=\[REDACTED\]/);
  assert.match(e.url, /api_key=%5BREDACTED%5D|api_key=\[REDACTED\]/);
  assert.match(e.url, /custom_secret=%5BREDACTED%5D|custom_secret=\[REDACTED\]/);
  assert.match(e.url, /user_id=1/);
});

test('6. header redaction — Authorization + Cookie ALWAYS stripped', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    enableHttpTracking: true,
    httpTracking: { captureHeaders: true },
  });
  await fetch('https://api.example.com/secure', {
    headers: {
      authorization: 'Bearer secret-token-xyz',
      cookie: 'session=secret',
      'x-api-key': 'leaked-key',
      'x-request-id': 'req-42',
    },
  });
  AllStak.destroy();
  await wait(20);
  const e = allHttpEvents().find((x) => x.path === '/secure');
  assert.equal(e.requestHeaders.authorization, '[REDACTED]');
  assert.equal(e.requestHeaders.cookie, '[REDACTED]');
  assert.equal(e.requestHeaders['x-api-key'], '[REDACTED]');
  assert.equal(e.requestHeaders['x-request-id'], 'req-42', 'non-sensitive headers survive');
  // Final guarantee: payload contains no raw secret strings.
  const json = JSON.stringify(allHttpEvents());
  assert.ok(!json.includes('secret-token-xyz'));
  assert.ok(!json.includes('leaked-key'));
});

test('7+8. XHR success + failure — wraps open/send/setRequestHeader', async () => {
  // Build a minimal XMLHttpRequest stub that the patcher can wrap.
  const xhrEvents = new Map();
  class FakeXHR {
    open(method, url) { this._m = method; this._u = url; }
    setRequestHeader() {}
    send() {
      // After patching, send() registers listeners. Fire 'load' synchronously.
      setTimeout(() => {
        this.status = this._m === 'BAD' ? 500 : 200;
        const handlers = xhrEvents.get(this) ?? {};
        if (this._u.includes('xhr-fail')) handlers.error?.();
        else handlers.load?.();
      }, 5);
    }
    addEventListener(event, h) {
      const map = xhrEvents.get(this) ?? {};
      map[event] = h;
      xhrEvents.set(this, map);
    }
    getAllResponseHeaders() { return ''; }
  }
  globalThis.XMLHttpRequest = FakeXHR;

  sent.length = 0;
  AllStak.init({ apiKey: 'k', enableHttpTracking: true });

  const ok = new globalThis.XMLHttpRequest();
  ok.open('GET', 'https://api.example.com/xhr-ok');
  ok.send();

  const bad = new globalThis.XMLHttpRequest();
  bad.open('GET', 'https://api.example.com/xhr-fail');
  bad.send();

  await wait(50);
  AllStak.destroy();
  await wait(20);
  const events = allHttpEvents();
  const okEv = events.find((e) => e.url.includes('xhr-ok'));
  const failEv = events.find((e) => e.url.includes('xhr-fail'));
  assert.ok(okEv, 'XHR success event recorded');
  assert.equal(okEv.statusCode, 200);
  assert.ok(failEv, 'XHR failure event recorded');
  assert.equal(failEv.error, 'network');
  delete globalThis.XMLHttpRequest;
});

test('9. axios manual instrumentation — interceptors capture request', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', enableHttpTracking: true });

  // Fake axios instance — only what the instrumenter touches.
  const handlers = { req: [], resOk: [], resErr: [] };
  const fakeAxios = {
    interceptors: {
      request: { use: (fn) => handlers.req.push(fn) },
      response: { use: (ok, err) => { handlers.resOk.push(ok); handlers.resErr.push(err); } },
    },
  };
  AllStak.instrumentAxios(fakeAxios);
  // Simulate a request flowing through.
  const cfg = { method: 'POST', url: '/checkout', baseURL: 'https://api.example.com', data: { qty: 1 }, headers: { authorization: 'Bearer x' } };
  handlers.req[0](cfg);
  await wait(5);
  handlers.resOk[0]({ config: cfg, status: 200, headers: { 'content-type': 'application/json' }, data: { ok: true } });

  AllStak.destroy();
  await wait(20);
  const e = allHttpEvents().find((x) => x.path === '/checkout');
  assert.ok(e, 'axios event recorded');
  assert.equal(e.method, 'POST');
  assert.equal(e.statusCode, 200);
});

test('10. idempotent patching — second init does NOT double-fire', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', enableHttpTracking: true });
  AllStak.init({ apiKey: 'k', enableHttpTracking: true });
  AllStak.init({ apiKey: 'k', enableHttpTracking: true });
  await fetch('https://api.example.com/idem');
  AllStak.destroy();
  await wait(20);
  const events = allHttpEvents().filter((e) => e.path === '/idem');
  assert.equal(events.length, 1, 're-init must not stack fetch wrappers');
});

test('11. ignoredUrls / allowedUrls — pattern matching skips correctly', async () => {
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    enableHttpTracking: true,
    httpTracking: { ignoredUrls: [/health/i, '/metrics'] },
  });
  await fetch('https://api.example.com/health');
  await fetch('https://api.example.com/metrics?key=v');
  await fetch('https://api.example.com/users');
  AllStak.destroy();
  await wait(20);
  const events = allHttpEvents();
  assert.ok(!events.some((e) => /health|metrics/i.test(e.url)),
    'ignoredUrls patterns must drop matching requests');
  assert.ok(events.some((e) => e.path === '/users'),
    'non-matching requests are still captured');

  // allowedUrls takes precedence
  sent.length = 0;
  AllStak.init({
    apiKey: 'k',
    enableHttpTracking: true,
    httpTracking: { allowedUrls: ['/users'] },
  });
  await fetch('https://api.example.com/orders');
  await fetch('https://api.example.com/users/42');
  AllStak.destroy();
  await wait(20);
  const after = allHttpEvents();
  assert.ok(after.some((e) => e.path === '/users/42'));
  assert.ok(!after.some((e) => e.path === '/orders'));
});

test('12. response clone safety — body capture skipped when clone unavailable', async () => {
  sent.length = 0;
  returnNoCloneResponse = true;
  AllStak.init({
    apiKey: 'k',
    enableHttpTracking: true,
    httpTracking: { captureResponseBody: true },
  });
  await fetch('https://api.example.com/no-clone');
  AllStak.destroy();
  await wait(20);
  returnNoCloneResponse = false;
  const e = allHttpEvents().find((x) => x.path === '/no-clone');
  assert.ok(e, 'event still recorded even when body cannot be cloned');
  assert.equal(e.responseBody, undefined, 'body skipped silently when clone is unsafe');
});

test('13. recent failed request attached to next captureException', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k', enableHttpTracking: true });
  // Make a couple of failed requests
  nextFetchBehavior = 'status:500';
  await fetch('https://api.example.com/checkout-fail');
  nextFetchBehavior = 'fail';
  await assert.rejects(() => fetch('https://api.example.com/network-down'), /network/);
  nextFetchBehavior = 'success';

  // Now fire an exception
  AllStak.captureException(new Error('something broke after a failed request'));
  AllStak.destroy();
  await wait(30);

  const errPayload = sent.find(errPath);
  assert.ok(errPayload, 'exception was captured');
  const body = JSON.parse(errPayload.init.body);
  const recent = body.metadata?.['http.recentFailed'];
  assert.ok(Array.isArray(recent) && recent.length >= 2,
    'recent failed http requests must be attached to the error metadata');
  const urls = recent.map((r) => r.url);
  assert.ok(urls.some((u) => u.includes('checkout-fail')));
  assert.ok(urls.some((u) => u.includes('network-down')));
  // Bodies must NOT leak when capture is off
  for (const r of recent) {
    assert.ok(!('requestBody' in r), 'no body in recent-failed snapshot when body capture is OFF');
  }
});
