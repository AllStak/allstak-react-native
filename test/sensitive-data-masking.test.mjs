/**
 * Sensitive data masking tests for @allstak/react-native.
 *
 * Verifies that the SDK never leaks sensitive information in telemetry:
 *   1. Authorization headers are masked in captured HTTP telemetry
 *   2. Cookie headers are masked
 *   3. Password fields are not captured in plain text
 *   4. API keys (X-AllStak-Key, X-API-Key) are not leaked
 *   5. Token values in URLs (?token=xxx) are stripped
 *   6. Body-level sensitive fields are redacted recursively
 *   7. Custom redact lists extend (never shrink) the defaults
 *   8. Case-insensitive header matching
 *   9. X-Auth-Token and Proxy-Authorization always redacted
 *  10. URL redaction in fallback mode (relative / malformed URLs)
 *  11. JSON body string fields redacted when body is a string
 *  12. Integration: full SDK round-trip never leaks secrets
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  ALWAYS_REDACT_HEADERS,
  ALWAYS_REDACT_QUERY,
  REDACTED,
  DEFAULT_REDACT_BODY_FIELDS,
  redactUrl,
  sanitizeHeaders,
  captureBodyResult,
} from '../dist/index.mjs';

// ── Unit tests on redactUrl ─────────────────────────────────────

test('URL: token param is redacted', () => {
  const url = redactUrl('https://api.example.com/data?token=secret123&page=1', {});
  assert.match(url, /token=%5BREDACTED%5D|token=\[REDACTED\]/);
  assert.match(url, /page=1/);
  assert.ok(!url.includes('secret123'), 'raw token value must not appear');
});

test('URL: password param is redacted', () => {
  const url = redactUrl('https://api.example.com/login?password=hunter2&user=admin', {});
  assert.match(url, /password=%5BREDACTED%5D|password=\[REDACTED\]/);
  assert.match(url, /user=admin/);
  assert.ok(!url.includes('hunter2'));
});

test('URL: api_key and apikey params are redacted', () => {
  const url = redactUrl('https://api.example.com/v1?api_key=ak_live_xxx&apikey=pk_test_yyy&format=json', {});
  assert.match(url, /api_key=%5BREDACTED%5D|api_key=\[REDACTED\]/);
  assert.match(url, /apikey=%5BREDACTED%5D|apikey=\[REDACTED\]/);
  assert.ok(!url.includes('ak_live_xxx'));
  assert.ok(!url.includes('pk_test_yyy'));
  assert.match(url, /format=json/);
});

test('URL: access_token and refresh_token are redacted', () => {
  const url = redactUrl('https://api.example.com/oauth?access_token=at_abc&refresh_token=rt_xyz', {});
  assert.ok(!url.includes('at_abc'));
  assert.ok(!url.includes('rt_xyz'));
});

test('URL: auth, secret, session, sessionid, jwt params are redacted', () => {
  const url = redactUrl(
    'https://example.com/x?auth=a1&secret=s2&session=s3&sessionid=s4&jwt=j5&safe=ok',
    {},
  );
  assert.ok(!url.includes('=a1'));
  assert.ok(!url.includes('=s2'));
  assert.ok(!url.includes('=s3'));
  assert.ok(!url.includes('=s4'));
  assert.ok(!url.includes('=j5'));
  assert.match(url, /safe=ok/);
});

test('URL: authorization param is redacted', () => {
  const url = redactUrl('https://example.com/q?authorization=Bearer+xyz', {});
  assert.ok(!url.includes('Bearer'));
  assert.ok(!url.includes('xyz'));
});

test('URL: custom redactQueryParams extend defaults', () => {
  const url = redactUrl('https://example.com/x?custom_key=val&token=t', {
    redactQueryParams: ['custom_key'],
  });
  assert.ok(!url.includes('val'), 'custom param value must be redacted');
  assert.ok(!url.includes('=t'), 'default token still redacted');
});

test('URL: no query string returns URL unchanged', () => {
  const url = redactUrl('https://example.com/clean-path', {});
  assert.equal(url, 'https://example.com/clean-path');
});

test('URL: fallback mode for relative/malformed URLs', () => {
  const url = redactUrl('/api/data?token=secret&ok=1', {});
  assert.ok(!url.includes('secret'));
  assert.match(url, /ok=1/);
});

// ── Unit tests on sanitizeHeaders ───────────────────────────────

test('Headers: Authorization is always masked', () => {
  const result = sanitizeHeaders(
    { Authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.secret' },
    { captureHeaders: true },
  );
  assert.equal(result.authorization, REDACTED);
  assert.ok(!JSON.stringify(result).includes('eyJhbGciOiJIUzI1NiJ9'));
});

test('Headers: Cookie is always masked', () => {
  const result = sanitizeHeaders(
    { Cookie: 'session=abc123; auth=xyz789' },
    { captureHeaders: true },
  );
  assert.equal(result.cookie, REDACTED);
  assert.ok(!JSON.stringify(result).includes('abc123'));
});

test('Headers: Set-Cookie is always masked', () => {
  const result = sanitizeHeaders(
    { 'Set-Cookie': 'sid=secret; HttpOnly; Secure' },
    { captureHeaders: true },
  );
  assert.equal(result['set-cookie'], REDACTED);
});

test('Headers: X-API-Key is always masked', () => {
  const result = sanitizeHeaders(
    { 'X-API-Key': 'ask_live_1234567890abcdef' },
    { captureHeaders: true },
  );
  assert.equal(result['x-api-key'], REDACTED);
  assert.ok(!JSON.stringify(result).includes('ask_live'));
});

test('Headers: X-Auth-Token is always masked', () => {
  const result = sanitizeHeaders(
    { 'X-Auth-Token': 'tok_secret_value' },
    { captureHeaders: true },
  );
  assert.equal(result['x-auth-token'], REDACTED);
});

test('Headers: Proxy-Authorization is always masked', () => {
  const result = sanitizeHeaders(
    { 'Proxy-Authorization': 'Basic dXNlcjpwYXNz' },
    { captureHeaders: true },
  );
  assert.equal(result['proxy-authorization'], REDACTED);
});

test('Headers: case-insensitive matching (AUTHORIZATION, cookie, X-Api-Key)', () => {
  const result = sanitizeHeaders(
    {
      AUTHORIZATION: 'Bearer tok',
      COOKIE: 'sid=x',
      'x-api-KEY': 'key123',
    },
    { captureHeaders: true },
  );
  assert.equal(result.authorization, REDACTED);
  assert.equal(result.cookie, REDACTED);
  assert.equal(result['x-api-key'], REDACTED);
});

test('Headers: non-sensitive headers survive redaction', () => {
  const result = sanitizeHeaders(
    {
      'Content-Type': 'application/json',
      'X-Request-Id': 'req-42',
      Authorization: 'Bearer secret',
    },
    { captureHeaders: true },
  );
  assert.equal(result['content-type'], 'application/json');
  assert.equal(result['x-request-id'], 'req-42');
  assert.equal(result.authorization, REDACTED);
});

test('Headers: custom redactHeaders extend the always-list', () => {
  const result = sanitizeHeaders(
    { 'X-Custom-Secret': 'my-secret', 'X-Request-Id': 'ok' },
    { captureHeaders: true, redactHeaders: ['X-Custom-Secret'] },
  );
  assert.equal(result['x-custom-secret'], REDACTED);
  assert.equal(result['x-request-id'], 'ok');
});

test('Headers: captureHeaders=false returns undefined (no headers leak)', () => {
  const result = sanitizeHeaders(
    { Authorization: 'Bearer secret', 'Content-Type': 'text/plain' },
    { captureHeaders: false },
  );
  assert.equal(result, undefined);
});

// ── Unit tests on body redaction ────────────────────────────────

test('Body: password field is redacted in JSON body', () => {
  const result = captureBodyResult(
    { username: 'admin', password: 'hunter2' },
    true,
    4096,
    {},
  );
  assert.ok(result.body);
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.password, REDACTED);
  assert.equal(parsed.username, 'admin');
  assert.ok(!result.body.includes('hunter2'));
});

test('Body: token field is redacted', () => {
  const result = captureBodyResult(
    { token: 'eyJhbGciOiJIUzI1NiJ9.payload.sig', userId: 42 },
    true,
    4096,
    {},
  );
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.token, REDACTED);
  assert.equal(parsed.userId, 42);
});

test('Body: nested sensitive fields are redacted recursively', () => {
  const result = captureBodyResult(
    {
      user: { name: 'Alice' },
      auth: { access_token: 'at_secret', refresh_token: 'rt_secret' },
      payment: { card: '4111111111111111', amount: 100 },
    },
    true,
    4096,
    {},
  );
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.user.name, 'Alice');
  assert.equal(parsed.auth.access_token, REDACTED);
  assert.equal(parsed.auth.refresh_token, REDACTED);
  assert.equal(parsed.payment.card, REDACTED);
  assert.equal(parsed.payment.amount, 100);
  assert.ok(!result.body.includes('4111111111111111'));
  assert.ok(!result.body.includes('at_secret'));
});

test('Body: fields with "token" or "password" in name are redacted', () => {
  const result = captureBodyResult(
    { resetToken: 'rt_abc', oldPassword: 'old123', email: 'a@b.com' },
    true,
    4096,
    {},
  );
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.resetToken, REDACTED);
  assert.equal(parsed.oldPassword, REDACTED);
  assert.equal(parsed.email, 'a@b.com');
});

test('Body: api_key, secret, jwt, otp, passcode, credit_card, iban, national_id are all redacted', () => {
  const input = {
    api_key: 'ak_123',
    secret: 'shhh',
    jwt: 'eyJ...',
    otp: '123456',
    passcode: '0000',
    credit_card: '4111-1111-1111-1111',
    iban: 'SA0380000000608010167519',
    national_id: '1234567890',
    safe: 'visible',
  };
  const result = captureBodyResult(input, true, 8192, {});
  const parsed = JSON.parse(result.body);
  for (const key of Object.keys(input)) {
    if (key === 'safe') {
      assert.equal(parsed[key], 'visible');
    } else {
      assert.equal(parsed[key], REDACTED, `${key} must be redacted`);
    }
  }
});

test('Body: custom redactBodyFields extend defaults', () => {
  const result = captureBodyResult(
    { mySecret: 'hidden', name: 'visible' },
    true,
    4096,
    { redactBodyFields: ['mySecret'] },
  );
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.mySecret, REDACTED);
  assert.equal(parsed.name, 'visible');
});

test('Body: string body with JSON-like content gets sensitive fields redacted', () => {
  const jsonStr = JSON.stringify({ password: 'p@ss', user: 'admin' });
  const result = captureBodyResult(jsonStr, true, 4096, {}, 'application/json');
  assert.ok(!result.body.includes('p@ss'));
  assert.ok(result.body.includes('admin'));
});

test('Body: redactedFields metadata is reported correctly', () => {
  const result = captureBodyResult(
    { password: 'x', nested: { token: 'y' }, safe: 1 },
    true,
    4096,
    {},
  );
  assert.ok(result.redactedFields.includes('password'));
  assert.ok(result.redactedFields.includes('nested.token'));
  assert.equal(result.redactedFields.length, 2);
  assert.equal(result.status, 'redacted');
});

test('Body: capture disabled returns no body at all', () => {
  const result = captureBodyResult({ password: 'secret' }, false, 4096, {});
  assert.equal(result.body, undefined);
  assert.equal(result.status, 'disabled');
});

// ── Constant completeness checks ────────────────────────────────

test('ALWAYS_REDACT_HEADERS includes all critical header names', () => {
  for (const h of ['authorization', 'cookie', 'set-cookie', 'x-api-key', 'x-auth-token', 'proxy-authorization']) {
    assert.ok(ALWAYS_REDACT_HEADERS.has(h), `${h} must be in ALWAYS_REDACT_HEADERS`);
  }
});

test('ALWAYS_REDACT_QUERY includes all critical param names', () => {
  for (const p of ['token', 'password', 'api_key', 'apikey', 'authorization', 'auth',
    'secret', 'access_token', 'refresh_token', 'session', 'sessionid', 'jwt']) {
    assert.ok(ALWAYS_REDACT_QUERY.has(p), `${p} must be in ALWAYS_REDACT_QUERY`);
  }
});

test('DEFAULT_REDACT_BODY_FIELDS includes password, token, api_key, secret, jwt', () => {
  for (const f of ['password', 'token', 'api_key', 'secret', 'jwt', 'access_token', 'refresh_token']) {
    assert.ok(DEFAULT_REDACT_BODY_FIELDS.includes(f), `${f} must be in DEFAULT_REDACT_BODY_FIELDS`);
  }
});

// ── Integration: full SDK round-trip ────────────────────────────

test('Integration: full SDK round-trip never leaks sensitive data', async () => {
  const sent = [];
  const baseFetch = async (url, init) => {
    const u = String(url);
    if (/api\.allstak\.sa/.test(u)) {
      sent.push({ url: u, init });
      return new Response('{}', { status: 200 });
    }
    return new Response(
      JSON.stringify({ serverToken: 'srv_secret', ok: true }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  };
  const origFetch = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

  const { AllStak } = await import('../dist/index.mjs');
  AllStak.init({
    apiKey: 'test-key',
    enableHttpTracking: true,
    httpTracking: {
      captureHeaders: true,
      captureRequestBody: true,
      captureResponseBody: true,
    },
  });

  // Make a request with lots of sensitive data
  await globalThis.fetch('https://api.example.com/auth?token=secret_tok&user=alice', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer jwt_secret_value',
      Cookie: 'session=cookie_secret',
      'X-API-Key': 'ask_live_key_value',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      password: 'my_password_123',
      username: 'alice',
      otp: '999888',
    }),
  });

  AllStak.destroy();
  await new Promise((r) => setTimeout(r, 30));

  // Collect all wire data sent to the backend
  const wireData = sent
    .filter((s) => /\/ingest\//.test(s.url))
    .map((s) => JSON.stringify(s.init?.body ?? ''))
    .join(' ');

  // None of these raw secret values should appear anywhere in the wire payload
  const mustNotLeak = [
    'secret_tok',
    'jwt_secret_value',
    'cookie_secret',
    'ask_live_key_value',
    'my_password_123',
    '999888',
    'srv_secret',
  ];
  for (const secret of mustNotLeak) {
    assert.ok(
      !wireData.includes(secret),
      `Secret "${secret}" must not appear in wire payload`,
    );
  }

  // Non-sensitive data should still be present
  assert.match(wireData, /alice/, 'non-sensitive username should be captured');

  Object.defineProperty(globalThis, 'fetch', { value: origFetch, writable: true, configurable: true });
});
