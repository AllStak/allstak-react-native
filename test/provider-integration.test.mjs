/**
 * Integration tests for AllStakProvider — verifies the provider correctly
 * wires up things that DON'T require the `react-native` module at runtime
 * (which can't be loaded inside a Node-ESM test bundle):
 *
 *   - ErrorUtils.setGlobalHandler is called and the captured handler ships
 *     errors with source=react-native-ErrorUtils
 *   - Provider doesn't crash when react-native isn't available (no-op
 *     fallback path)
 *   - debug:true emits exactly one [AllStak] Initialized line per
 *     provider lifecycle
 *
 * Coverage of `installReactNative`'s react-native-dependent paths
 * (Platform tags, AppState, rejection-tracking) lives in
 * instrumentation.test.mjs and architecture.test.mjs.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch.
const sent = [];
Object.defineProperty(globalThis, 'fetch', {
  get() {
    return async (url, init) => {
      sent.push({ url, init });
      return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  },
  configurable: false,
});

// Install fake ErrorUtils on globalThis BEFORE we import the SDK.
let installedErrorHandler = null;
let prevErrorHandler = () => {};
globalThis.ErrorUtils = {
  getGlobalHandler: () => prevErrorHandler,
  setGlobalHandler: (h) => { installedErrorHandler = h; },
};

const { default: TestRenderer, act } = await import('react-test-renderer');
const React = await import('react');

const {
  AllStakProvider,
  AllStak,
  __resetProviderInstanceForTest,
} = await import('../dist/index.mjs');

function ResetState() {
  AllStak.destroy();
  __resetProviderInstanceForTest();
  sent.length = 0;
  installedErrorHandler = null;
}

test('provider installs the global ErrorUtils handler', () => {
  ResetState();
  let tree;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        AllStakProvider,
        { apiKey: 'ask_int_1' },
        React.createElement('div', null, 'a'),
      ),
    );
  });
  assert.ok(installedErrorHandler, 'ErrorUtils.setGlobalHandler should have been called');
  assert.equal(typeof installedErrorHandler, 'function');
  act(() => { tree.unmount(); });
});

test('a global JS error routed through ErrorUtils is captured with source=react-native-ErrorUtils', async () => {
  ResetState();
  let tree;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        AllStakProvider,
        { apiKey: 'ask_int_2' },
        React.createElement('div', null, 'a'),
      ),
    );
  });

  installedErrorHandler(new Error('global fatal'), true);
  await new Promise((r) => setTimeout(r, 50));
  const errorEvents = sent.filter((s) => s.url.endsWith('/ingest/v1/errors'));
  assert.ok(errorEvents.length >= 1);
  const body = JSON.parse(errorEvents[errorEvents.length - 1].init.body);
  assert.equal(body.message, 'global fatal');
  assert.equal(body.metadata.source, 'react-native-ErrorUtils');
  assert.equal(body.metadata.fatal, 'true');
  act(() => { tree.unmount(); });
});

test('provider does NOT crash when react-native module is unavailable (Node test env)', () => {
  ResetState();
  // The SDK's lazy require('react-native') should fail silently — provider
  // mount must succeed regardless.
  let tree;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        AllStakProvider,
        { apiKey: 'ask_int_3' },
        React.createElement('div', null, 'OK'),
      ),
    );
  });
  assert.equal(tree.toJSON().type, 'div');
  assert.deepEqual(tree.toJSON().children, ['OK']);
  act(() => { tree.unmount(); });
});

test('debug:true logs exactly one [AllStak] Initialized line per provider lifecycle', () => {
  ResetState();
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    let tree;
    act(() => {
      tree = TestRenderer.create(
        React.createElement(
          AllStakProvider,
          { apiKey: 'ask_int_4', debug: true },
          React.createElement('div', null, 'a'),
        ),
      );
    });
    const initLines = lines.filter((l) => l.startsWith('[AllStak] Initialized'));
    assert.equal(initLines.length, 1, `expected 1 init line, got ${initLines.length}`);
    act(() => { tree.unmount(); });
  } finally {
    console.log = orig;
  }
});

test('debug:true on a remount logs Reusing rather than Initialized', () => {
  ResetState();
  const lines = [];
  const orig = console.log;
  console.log = (...args) => lines.push(args.join(' '));
  try {
    let tree1, tree2;
    act(() => {
      tree1 = TestRenderer.create(
        React.createElement(
          AllStakProvider,
          { apiKey: 'ask_int_5', debug: true },
          React.createElement('div', null, 'a'),
        ),
      );
    });
    act(() => { tree1.unmount(); });
    const beforeRemount = lines.length;
    act(() => {
      tree2 = TestRenderer.create(
        React.createElement(
          AllStakProvider,
          { apiKey: 'ask_int_5', debug: true },
          React.createElement('div', null, 'b'),
        ),
      );
    });
    const remountLines = lines.slice(beforeRemount);
    const reusingLines = remountLines.filter((l) => l.startsWith('[AllStak] Reusing'));
    const initLines = remountLines.filter((l) => l.startsWith('[AllStak] Initialized'));
    assert.equal(reusingLines.length, 1, `expected 1 reuse line, got ${reusingLines.length}: ${JSON.stringify(remountLines)}`);
    assert.equal(initLines.length, 0, 'should NOT log Initialized on remount');
    act(() => { tree2.unmount(); });
  } finally {
    console.log = orig;
  }
});
