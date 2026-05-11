/**
 * Live DEV mobile forensic contract test.
 *
 * This test intentionally runs the real SDK runtime. It must never call
 * AllStak backend diagnostic/certification endpoints to create mobile-shaped
 * telemetry. The only app request target allowed here is a normal application
 * endpoint supplied by ALLSTAK_MOBILE_CONTRACT_TARGET_URL.
 *
 * Required env to run:
 *   ALLSTAK_TEST_API_KEY
 *   ALLSTAK_MOBILE_CONTRACT_TARGET_URL
 *
 * Optional env for API verification:
 *   ALLSTAK_CONTRACT_VERIFY_URL
 *
 * ALLSTAK_CONTRACT_VERIFY_URL should return JSON proving the emitted telemetry
 * was ingested and correlated by DEV APIs. The test sends query params:
 *   traceId, requestId, release, dist
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const apiKey = process.env.ALLSTAK_TEST_API_KEY;
const targetUrl = process.env.ALLSTAK_MOBILE_CONTRACT_TARGET_URL;
const verifyUrl = process.env.ALLSTAK_CONTRACT_VERIFY_URL;
const host = process.env.ALLSTAK_TEST_HOST ?? 'https://api.dev.allstak.sa';
const release = process.env.ALLSTAK_TEST_RELEASE ?? `rn-sdk-contract-${Date.now()}`;
const dist = process.env.ALLSTAK_TEST_DIST ?? 'android-hermes';

const shouldRun = Boolean(apiKey && targetUrl);

test('real SDK runtime emits mobile request continuity telemetry to DEV', { skip: shouldRun ? false : 'set ALLSTAK_TEST_API_KEY and ALLSTAK_MOBILE_CONTRACT_TARGET_URL' }, async () => {
  const capturedAppRequests = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url);
    if (u.includes('/api/v1/_diag/telemetry/')) {
      throw new Error(`diagnostic endpoints are forbidden in SDK runtime contract test: ${u}`);
    }
    if (!u.includes('/ingest/')) capturedAppRequests.push({ url: u, init });
    return originalFetch(url, init);
  };

  const { AllStak } = await import('../dist/index.mjs');
  AllStak.init({
    apiKey,
    host,
    release,
    dist,
    platform: 'react-native',
    environment: 'dev',
    enableHttpTracking: true,
    httpTracking: {
      captureRequestBody: true,
      captureResponseBody: true,
      captureHeaders: true,
      maxBodyBytes: 4096,
    },
    replay: { sampleRate: 1 },
    tracesSampleRate: 1,
  });

  let response;
  try {
    response = await fetch(targetUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'mobile.contract@example.com',
        password: 'must-redact',
        otp: '11111',
        token: 'must-redact',
        amount: 12900,
      }),
    });
    if (!response.ok) {
      AllStak.captureException(new Error(`Mobile-visible request failure: HTTP ${response.status}`));
    }
  } finally {
    await AllStak.flush(3000);
    AllStak.destroy();
    globalThis.fetch = originalFetch;
  }

  const appRequest = capturedAppRequests.find((r) => r.url === targetUrl);
  assert.ok(appRequest, 'the SDK must send a real application request');
  const headers = appRequest.init.headers;
  const getHeader = (name) => {
    const key = Object.keys(headers ?? {}).find((k) => k.toLowerCase() === name.toLowerCase());
    return key ? headers[key] : undefined;
  };
  const traceId = getHeader('x-allstak-trace-id');
  const requestId = getHeader('x-allstak-request-id');
  assert.ok(getHeader('traceparent'), 'SDK must propagate traceparent');
  assert.ok(traceId, 'SDK must propagate x-allstak-trace-id');
  assert.ok(requestId, 'SDK must propagate x-allstak-request-id');

  if (verifyUrl) {
    const url = new URL(verifyUrl);
    url.searchParams.set('traceId', traceId);
    url.searchParams.set('requestId', requestId);
    url.searchParams.set('release', release);
    url.searchParams.set('dist', dist);
    const verify = await originalFetch(url, { headers: { 'x-allstak-key': apiKey } });
    assert.equal(verify.ok, true, `verification endpoint failed: HTTP ${verify.status}`);
    const body = await verify.json();
    assert.equal(body.mobileRequest?.requestId, requestId);
    assert.equal(body.mobileRequest?.traceId, traceId);
    assert.equal(body.backendRequest?.traceId, traceId);
    assert.equal(body.mobileIssue?.requestId, requestId);
    assert.equal(body.timeline?.mobileSessionTimeline, true);
    assert.equal(body.bodyRedaction?.password, '[REDACTED]');
  }
});
