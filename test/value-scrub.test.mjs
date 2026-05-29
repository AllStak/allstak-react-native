/**
 * Value-pattern PII scrubbing tests for @allstak/react-native.
 *
 * Companion to sensitive-data-masking.test.mjs (key-name redaction).
 * Verifies the @sentry-parity value scrubbers:
 *
 *   A) ALWAYS (regardless of sendDefaultPii):
 *       - Credit-card numbers redacted ONLY when Luhn-valid; a Luhn-invalid
 *         digit run (order id / timestamp) is preserved.
 *       - US SSN with hyphens redacted; a bare 9-digit number is preserved.
 *   B) Unless sendDefaultPii===true (default false):
 *       - Email + IPv4 redacted by default; PRESERVED when sendDefaultPii=true.
 *   - Explicit setUser email is NOT value-scrubbed.
 *   - Key-based redaction still works (regression).
 *   - Stack frame paths are NOT corrupted.
 *   - Fail-open on pathological input.
 *   - Wiring: free-text PII in message/metadata/breadcrumbs is scrubbed on
 *     the wire; logs scrubbed too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  scrubString,
  scrubValueTree,
  REDACTED,
  captureBodyResult,
} from '../dist/index.mjs';

// ── (A) Credit-card — Luhn-gated ────────────────────────────────

test('CC: Luhn-valid card (spaced) is redacted', () => {
  const out = scrubString('pay with 4111 1111 1111 1111 now');
  assert.ok(out.includes(REDACTED));
  assert.ok(!out.includes('4111 1111 1111 1111'));
});

test('CC: Luhn-valid card (hyphenated) is redacted', () => {
  const out = scrubString('card 4111-1111-1111-1111 done');
  assert.ok(out.includes(REDACTED));
  assert.ok(!out.includes('4111-1111-1111-1111'));
});

test('CC: Luhn-valid card (plain 16) is redacted', () => {
  const out = scrubString('num 4242424242424242 end');
  assert.equal(out, `num ${REDACTED} end`);
});

test('CC: Luhn-valid Amex (15 digits) is redacted', () => {
  const out = scrubString('amex 378282246310005 ok');
  assert.equal(out, `amex ${REDACTED} ok`);
});

test('CC: Luhn-INVALID 16-digit run (order id) is PRESERVED', () => {
  const input = 'order 1234567890123456 ref';
  const out = scrubString(input);
  assert.equal(out, input, 'a Luhn-invalid digit run must not be redacted');
});

test('CC: 13-digit timestamp (Luhn-invalid) is PRESERVED', () => {
  const input = 'ts 1700000000000 ms';
  assert.equal(scrubString(input), input);
});

test('CC: redacted ALWAYS, even with sendDefaultPii=true', () => {
  const out = scrubString('num 4242424242424242', { sendDefaultPii: true });
  assert.ok(out.includes(REDACTED));
  assert.ok(!out.includes('4242424242424242'));
});

// ── (A) US SSN — hyphens required ───────────────────────────────

test('SSN: hyphenated SSN is redacted', () => {
  const out = scrubString('ssn 123-45-6789 confirmed');
  assert.equal(out, `ssn ${REDACTED} confirmed`);
});

test('SSN: bare 9-digit number is NOT treated as SSN', () => {
  const input = 'id 123456789 here';
  assert.equal(scrubString(input), input, 'bare 9-digit must not be redacted as SSN');
});

test('SSN: redacted ALWAYS, even with sendDefaultPii=true', () => {
  const out = scrubString('ssn 123-45-6789', { sendDefaultPii: true });
  assert.ok(out.includes(REDACTED));
  assert.ok(!out.includes('123-45-6789'));
});

// ── (B) Email + IPv4 — gated on sendDefaultPii ──────────────────

test('Email: redacted when sendDefaultPii=false (default)', () => {
  const out = scrubString('contact alice@example.com today');
  assert.equal(out, `contact ${REDACTED} today`);
});

test('Email: PRESERVED when sendDefaultPii=true', () => {
  const out = scrubString('contact alice@example.com today', { sendDefaultPii: true });
  assert.equal(out, 'contact alice@example.com today');
});

test('IPv4: redacted when sendDefaultPii=false (default)', () => {
  const out = scrubString('from 192.168.1.10 ok');
  assert.equal(out, `from ${REDACTED} ok`);
});

test('IPv4: PRESERVED when sendDefaultPii=true', () => {
  const out = scrubString('from 192.168.1.10 ok', { sendDefaultPii: true });
  assert.equal(out, 'from 192.168.1.10 ok');
});

test('IPv4: out-of-range octets are NOT matched', () => {
  const input = 'ver 999.999.999.999 build';
  assert.equal(scrubString(input), input);
});

// ── (C) Caller scrubPatterns — always applied ───────────────────

test('scrubPatterns: caller patterns are always applied', () => {
  const out = scrubString('user SECRET-XYZ done', { scrubPatterns: [/SECRET-\w+/g] });
  assert.equal(out, `user ${REDACTED} done`);
});

test('scrubPatterns: a /g pattern does not corrupt subsequent calls', () => {
  const re = /AAA/g;
  assert.equal(scrubString('x AAA y', { scrubPatterns: [re] }), `x ${REDACTED} y`);
  // Calling again must still match (lastIndex must not leak across calls).
  assert.equal(scrubString('x AAA y', { scrubPatterns: [re] }), `x ${REDACTED} y`);
});

// ── scrubValueTree — recursion + non-string passthrough ─────────

test('scrubValueTree: scrubs nested string values, preserves non-strings', () => {
  const out = scrubValueTree({
    a: 'email me at bob@host.com',
    n: 42,
    b: { card: 'pan 4242424242424242', ok: true },
    arr: ['ssn 123-45-6789', 99],
  });
  assert.ok(out.a.includes(REDACTED) && !out.a.includes('bob@host.com'));
  assert.equal(out.n, 42);
  assert.ok(out.b.card.includes(REDACTED));
  assert.equal(out.b.ok, true);
  assert.ok(out.arr[0].includes(REDACTED));
  assert.equal(out.arr[1], 99);
});

test('scrubValueTree: does not mutate the input object', () => {
  const input = { msg: 'mail x@y.com' };
  const out = scrubValueTree(input);
  assert.equal(input.msg, 'mail x@y.com', 'input must be untouched');
  assert.notEqual(out.msg, input.msg);
});

// ── Stack-frame paths must NOT be corrupted ─────────────────────

test('stack frames: filenames with dotted segments are not corrupted', () => {
  // A frame absPath that happens to contain octet-like segments must
  // survive (frames are NOT routed through scrubValueTree by the client,
  // but verify scrubString itself does not eat real file paths that are
  // not IP/email/CC shaped).
  const frame = 'at handler (src/screens/Home.tsx:12:5)';
  assert.equal(scrubString(frame), frame);
});

// ── Fail-open on pathological input ─────────────────────────────

test('fail-open: oversized string is returned unchanged (not scanned)', () => {
  const huge = 'a@b.com '.repeat(5000); // > MAX_SCAN_LENGTH
  const out = scrubString(huge);
  assert.equal(out, huge, 'oversized input is returned as-is, never throws');
});

test('fail-open: non-string input returns input unchanged', () => {
  assert.equal(scrubString(undefined), undefined);
  assert.equal(scrubString(null), null);
  assert.equal(scrubString(12345), 12345);
});

test('fail-open: scrubValueTree tolerates circular-ish / exotic objects', () => {
  const d = new Date();
  const out = scrubValueTree({ when: d, re: /x/, msg: 'a@b.com' });
  assert.equal(out.when, d, 'Date passes through untouched');
  assert.ok(out.msg.includes(REDACTED));
});

// ── Key-based redaction still works (regression) ────────────────

test('regression: key-based body redaction still works (sendDefaultPii ignored for keys)', () => {
  const result = captureBodyResult(
    { password: 'hunter2', username: 'admin' },
    true, 4096, {},
  );
  const parsed = JSON.parse(result.body);
  assert.equal(parsed.password, REDACTED);
  assert.equal(parsed.username, 'admin');
});

test('body capture: free-text CC value inside a non-redacted field is scrubbed (always)', () => {
  const result = captureBodyResult(
    { note: 'paid with 4242424242424242' },
    true, 4096, {},
  );
  assert.ok(!result.body.includes('4242424242424242'));
  assert.ok(result.body.includes(REDACTED));
});

test('body capture: free-text email scrubbed by default, preserved with sendDefaultPii', () => {
  const def = captureBodyResult({ note: 'reach me at a@b.com' }, true, 4096, {});
  assert.ok(!def.body.includes('a@b.com'));
  const pii = captureBodyResult({ note: 'reach me at a@b.com' }, true, 4096, { sendDefaultPii: true });
  assert.ok(pii.body.includes('a@b.com'));
});

// ── Wiring: full SDK event path ─────────────────────────────────

test('Integration: free-text PII in message + breadcrumbs scrubbed on the wire (default)', async () => {
  const sent = [];
  const mockFetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const orig = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });

  const { AllStak } = await import('../dist/index.mjs');
  AllStak.init({ apiKey: 'k', user: { id: 'u-1', email: 'explicit@user.com' } });

  AllStak.addBreadcrumb('default', 'card used 4242424242424242 and mail leak@example.com', 'info', {
    note: 'ssn 123-45-6789 and ip 10.0.0.5',
    orderId: '1234567890123456', // Luhn-invalid — must survive
  });
  AllStak.captureException(new Error('failed for user alice@example.com from 192.168.0.1'));
  await new Promise((r) => setTimeout(r, 30));
  AllStak.destroy();

  const wire = sent
    .filter((s) => /\/ingest\//.test(s.url))
    .map((s) => String(s.init?.body ?? ''))
    .join(' ');

  // Free-text PII scrubbed
  assert.ok(!wire.includes('4242424242424242'), 'CC in breadcrumb must be scrubbed');
  assert.ok(!wire.includes('leak@example.com'), 'email in breadcrumb must be scrubbed');
  assert.ok(!wire.includes('123-45-6789'), 'SSN in breadcrumb data must be scrubbed');
  assert.ok(!wire.includes('10.0.0.5'), 'IPv4 in breadcrumb data must be scrubbed');
  assert.ok(!wire.includes('alice@example.com'), 'email in error message must be scrubbed');
  assert.ok(!wire.includes('192.168.0.1'), 'IPv4 in error message must be scrubbed');

  // Conservative: a Luhn-invalid order id must survive
  assert.ok(wire.includes('1234567890123456'), 'Luhn-invalid order id must NOT be redacted');

  // Explicit setUser email is NOT value-scrubbed (top-level user object)
  assert.ok(wire.includes('explicit@user.com'), 'explicit setUser email must ship intact');

  Object.defineProperty(globalThis, 'fetch', { value: orig, writable: true, configurable: true });
});

test('Integration: sendDefaultPii=true preserves email + IPv4 in free text', async () => {
  const sent = [];
  const mockFetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const orig = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });

  const { AllStak } = await import('../dist/index.mjs');
  AllStak.init({ apiKey: 'k', sendDefaultPii: true });
  AllStak.captureException(new Error('user bob@example.com from 192.168.0.9 paid 4242424242424242'));
  await new Promise((r) => setTimeout(r, 30));
  AllStak.destroy();

  const wire = sent
    .filter((s) => /\/ingest\//.test(s.url))
    .map((s) => String(s.init?.body ?? ''))
    .join(' ');

  // (B) preserved under opt-in
  assert.ok(wire.includes('bob@example.com'), 'email preserved with sendDefaultPii=true');
  assert.ok(wire.includes('192.168.0.9'), 'IPv4 preserved with sendDefaultPii=true');
  // (A) always scrubbed even under opt-in
  assert.ok(!wire.includes('4242424242424242'), 'CC always scrubbed regardless of sendDefaultPii');

  Object.defineProperty(globalThis, 'fetch', { value: orig, writable: true, configurable: true });
});

test('Integration: log message + attributes are value-scrubbed', async () => {
  const sent = [];
  const mockFetch = async (url, init) => {
    sent.push({ url: String(url), init });
    return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const orig = globalThis.fetch;
  Object.defineProperty(globalThis, 'fetch', { value: mockFetch, writable: true, configurable: true });

  const { AllStak } = await import('../dist/index.mjs');
  AllStak.init({ apiKey: 'k', enableLogs: true });
  AllStak.log('info', 'login from 8.8.8.8 by user@example.com', { card: '4242424242424242' });
  await new Promise((r) => setTimeout(r, 30));
  AllStak.destroy();

  const wire = sent
    .filter((s) => /\/ingest\//.test(s.url))
    .map((s) => String(s.init?.body ?? ''))
    .join(' ');

  assert.ok(!wire.includes('8.8.8.8'), 'IPv4 in log message scrubbed');
  assert.ok(!wire.includes('user@example.com'), 'email in log message scrubbed');
  assert.ok(!wire.includes('4242424242424242'), 'CC in log attributes scrubbed');

  Object.defineProperty(globalThis, 'fetch', { value: orig, writable: true, configurable: true });
});
