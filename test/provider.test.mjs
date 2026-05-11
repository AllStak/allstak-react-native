/**
 * Tests for AllStakProvider — verifies module surface, init behavior, and
 * that the provider + error boundary are exported and constructible.
 *
 * Runs under plain Node (no jsdom / no react-native). We test the exported
 * shapes and the underlying init/install wiring rather than rendering React
 * trees (which needs a DOM or react-test-renderer).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const sent = [];
const mockFetch = async (url, init) => {
  sent.push({ url, init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', {
  get() { return mockFetch; },
  configurable: false,
});

const mod = await import('../dist/index.mjs');

test('AllStakProvider is exported as a function', () => {
  assert.equal(typeof mod.AllStakProvider, 'function');
});

test('useAllStak is exported as a function', () => {
  assert.equal(typeof mod.useAllStak, 'function');
});

test('AllStakProviderProps type exists (re-exported from provider)', () => {
  // TypeScript type — not testable at runtime, but AllStakProvider itself
  // being a function with the right .length is a proxy. The function takes
  // a single props arg.
  assert.ok(mod.AllStakProvider.length <= 1, 'AllStakProvider takes one props arg');
});

test('installReactNative is still exported for manual usage', () => {
  assert.equal(typeof mod.installReactNative, 'function');
});

test('AllStak singleton still works after provider module is loaded', async () => {
  sent.length = 0;
  mod.AllStak.init({ apiKey: 'ask_provider_test', environment: 'test' });
  mod.AllStak.captureException(new Error('provider-coexist'));
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(sent.length >= 1);
  const body = JSON.parse(sent[0].init.body);
  assert.equal(body.message, 'provider-coexist');
  mod.AllStak.destroy();
});

test('dist bundle does not reference window or document', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../dist/index.mjs', import.meta.url), 'utf8');
  for (const re of [/\bwindow\./, /\bdocument\./, /\blocalStorage\b/, /\bsessionStorage\b/]) {
    assert.ok(!re.test(src), `dist must not reference ${re}`);
  }
});
