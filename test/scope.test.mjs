/**
 * Scope / withScope isolation tests for @allstak/react-native.
 *
 * Proves that:
 *   - Tags/user/extras/context/fingerprint/level set inside withScope
 *     are visible on captures made within the callback
 *   - The same context does NOT appear on captures made AFTER the callback
 *   - Nested scopes layer correctly (later scope wins on key conflict)
 *   - Concurrent async withScope calls don't corrupt each other
 *   - Scope is popped on synchronous throw
 *   - Scope is popped on async rejection
 *
 * The concurrent-async test is the production-critical one: server
 * frameworks that handle two requests in parallel must not leak user
 * context from request A into the captureException of request B.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const baseFetch = async (url, init) => {
  sent.push({ url: String(url), init });
  return new Response('{}', { status: 200 });
};
Object.defineProperty(globalThis, 'fetch', { value: baseFetch, writable: true, configurable: true });

const { AllStak } = await import('../dist/index.mjs');

test('scope user/tag/extra is applied inside withScope and removed after', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });

  AllStak.withScope((scope) => {
    scope.setUser({ id: 'u-A', email: 'a@x.com' });
    scope.setTag('feature', 'cart');
    scope.setExtra('cart_id', 'c-42');
    AllStak.captureException(new Error('inside'));
  });
  AllStak.captureException(new Error('outside'));
  await new Promise((r) => setTimeout(r, 60));

  assert.equal(sent.length, 2);
  const inside = JSON.parse(sent[0].init.body);
  const outside = JSON.parse(sent[1].init.body);

  assert.deepEqual(inside.user, { id: 'u-A', email: 'a@x.com' });
  assert.equal(inside.metadata.feature, 'cart');
  assert.equal(inside.metadata.cart_id, 'c-42');

  assert.equal(outside.user, undefined, 'scope user must NOT leak to outer capture');
  assert.equal(outside.metadata.feature, undefined, 'scope tag must NOT leak');
  assert.equal(outside.metadata.cart_id, undefined, 'scope extra must NOT leak');
});

test('scope fingerprint and level apply only within callback', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.withScope((scope) => {
    scope.setLevel('warning');
    scope.setFingerprint(['feat-a']);
    AllStak.captureException(new Error('a'));
  });
  AllStak.captureException(new Error('b'));
  await new Promise((r) => setTimeout(r, 60));

  const a = JSON.parse(sent[0].init.body);
  const b = JSON.parse(sent[1].init.body);
  assert.equal(a.level, 'warning');
  assert.deepEqual(a.fingerprint, ['feat-a']);
  assert.equal(b.level, 'error');
  assert.equal(b.fingerprint, undefined);
});

test('scope context bag lands as context.<name> only inside callback', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.withScope((scope) => {
    scope.setContext('app', { build: '42' });
    AllStak.captureException(new Error('with-ctx'));
  });
  AllStak.captureException(new Error('without-ctx'));
  await new Promise((r) => setTimeout(r, 60));

  assert.deepEqual(JSON.parse(sent[0].init.body).metadata['context.app'], { build: '42' });
  assert.equal(JSON.parse(sent[1].init.body).metadata['context.app'], undefined);
});

test('nested scopes layer (inner overrides outer on conflict)', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  AllStak.withScope((outer) => {
    outer.setTag('layer', 'outer');
    outer.setTag('only-outer', '1');
    AllStak.withScope((inner) => {
      inner.setTag('layer', 'inner');
      AllStak.captureException(new Error('nested'));
    });
    AllStak.captureException(new Error('back-to-outer'));
  });
  await new Promise((r) => setTimeout(r, 60));

  const nested = JSON.parse(sent[0].init.body).metadata;
  const backToOuter = JSON.parse(sent[1].init.body).metadata;
  assert.equal(nested.layer, 'inner', 'inner scope must win on conflict');
  assert.equal(nested['only-outer'], '1', 'outer-only tag remains visible inside inner');
  assert.equal(backToOuter.layer, 'outer', 'inner scope must be popped on return');
});

test('concurrent async withScope calls do not leak context across requests', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });

  const handle = (reqId) => AllStak.withScope(async (scope) => {
    scope.setUser({ id: `u-${reqId}` });
    scope.setTag('req', reqId);
    // Yield the event loop multiple times — simulates real I/O.
    await new Promise((r) => setTimeout(r, 5 + Math.random() * 10));
    AllStak.captureException(new Error(`err-${reqId}`));
  });

  await Promise.all([handle('A'), handle('B'), handle('C'), handle('D')]);
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(sent.length, 4);
  const bodies = sent.map((s) => JSON.parse(s.init.body));
  const messages = bodies.map((body) => body.message).sort();
  assert.deepEqual(messages, ['err-A', 'err-B', 'err-C', 'err-D']);
  const byMessage = Object.fromEntries(bodies.map((body) => [body.message, body]));
  for (const reqId of ['A', 'B', 'C', 'D']) {
    assert.equal(byMessage[`err-${reqId}`].metadata.req, reqId);
    assert.deepEqual(byMessage[`err-${reqId}`].user, { id: `u-${reqId}` });
  }
});

test('configureScope mutates active scope or global defaults', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });

  AllStak.configureScope((scope) => {
    scope.setTag('global', 'yes');
  });
  AllStak.withScope((scope) => {
    scope.setTag('local', 'yes');
    AllStak.configureScope((current) => {
      assert.equal(current, scope);
      current.setTag('configured', 'active');
    });
    AllStak.captureException(new Error('inside-configure'));
  });
  AllStak.captureException(new Error('outside-configure'));
  await new Promise((r) => setTimeout(r, 80));

  const inside = JSON.parse(sent[0].init.body).metadata;
  const outside = JSON.parse(sent[1].init.body).metadata;
  assert.equal(inside.global, 'yes');
  assert.equal(inside.local, 'yes');
  assert.equal(inside.configured, 'active');
  assert.equal(outside.global, 'yes');
  assert.equal(outside.local, undefined);
  assert.equal(outside.configured, undefined);
});

test('scope is popped after a synchronous throw inside the callback', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  assert.throws(() => AllStak.withScope((scope) => {
    scope.setTag('bad', 'yes');
    throw new Error('boom-sync');
  }), /boom-sync/);
  AllStak.captureException(new Error('after-throw'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(JSON.parse(sent[0].init.body).metadata.bad, undefined,
    'scope must be popped even on sync throw');
});

test('scope is popped after an async rejection inside the callback', async () => {
  sent.length = 0;
  AllStak.init({ apiKey: 'k' });
  await assert.rejects(
    () => AllStak.withScope(async (scope) => {
      scope.setTag('bad', 'async');
      await Promise.reject(new Error('boom-async'));
    }),
    /boom-async/,
  );
  AllStak.captureException(new Error('after-reject'));
  await new Promise((r) => setTimeout(r, 60));
  assert.equal(JSON.parse(sent[0].init.body).metadata.bad, undefined,
    'scope must be popped even on async rejection');
});
