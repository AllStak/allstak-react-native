/**
 * Runtime tests for AllStakProvider that actually mount the provider via
 * react-test-renderer and exercise its full lifecycle:
 *
 *   - render passes children through
 *   - render error inside child is caught by AllStakErrorBoundary
 *   - static fallback renders
 *   - functional fallback receives { error, resetError }
 *   - resetError() clears error state and re-renders children
 *   - onError callback fires with error + componentStack
 *   - capturedException is shipped with `source: AllStakProvider.ErrorBoundary`
 *   - destroyOnUnmount=false leaves the SDK alive across unmount
 *   - destroyOnUnmount=true tears it down
 *   - remount-while-alive REUSES the existing instance (no double init)
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

// Mock fetch so the transport doesn't try to talk to a real ingest host.
const sent = [];
const mockFetch = async (url, init) => {
  sent.push({ url, init });
  return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
};
Object.defineProperty(globalThis, 'fetch', {
  get() { return mockFetch; },
  configurable: false,
});

// Silence error-boundary noise during the test that intentionally throws.
const origConsoleError = console.error;
let suppressErrors = false;
console.error = (...args) => {
  if (suppressErrors) return;
  origConsoleError(...args);
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
}

function Boom() {
  throw new Error('render-time boom');
}

test('renders children when no error', () => {
  ResetState();
  const tree = TestRenderer.create(
    React.createElement(
      AllStakProvider,
      { apiKey: 'ask_test_1' },
      React.createElement('div', null, 'OK'),
    ),
  );
  const json = tree.toJSON();
  assert.equal(json.type, 'div');
  assert.deepEqual(json.children, ['OK']);
  tree.unmount();
});

test('static fallback renders when child throws', () => {
  ResetState();
  suppressErrors = true;
  const tree = TestRenderer.create(
    React.createElement(
      AllStakProvider,
      {
        apiKey: 'ask_test_2',
        fallback: React.createElement('span', null, 'crashed'),
      },
      React.createElement(Boom),
    ),
  );
  suppressErrors = false;
  const json = tree.toJSON();
  assert.equal(json.type, 'span');
  assert.deepEqual(json.children, ['crashed']);
  tree.unmount();
});

test('functional fallback receives { error, resetError } and resetError() recovers', async () => {
  ResetState();
  let capturedReset = null;
  let capturedError = null;
  let throwOnNextRender = true;

  function Conditional() {
    if (throwOnNextRender) throw new Error('toggleable');
    return React.createElement('p', null, 'recovered');
  }

  suppressErrors = true;
  const tree = TestRenderer.create(
    React.createElement(
      AllStakProvider,
      {
        apiKey: 'ask_test_3',
        fallback: ({ error, resetError }) => {
          capturedError = error;
          capturedReset = resetError;
          return React.createElement('span', null, `oops:${error.message}`);
        },
      },
      React.createElement(Conditional),
    ),
  );
  suppressErrors = false;

  assert.equal(tree.toJSON().children[0], 'oops:toggleable');
  assert.ok(capturedError instanceof Error);
  assert.equal(capturedError.message, 'toggleable');
  assert.equal(typeof capturedReset, 'function');

  // Make the next render succeed, then reset.
  throwOnNextRender = false;
  act(() => { capturedReset(); });

  const json = tree.toJSON();
  assert.equal(json.type, 'p');
  assert.deepEqual(json.children, ['recovered']);
  tree.unmount();
});

test('onError callback fires with error and componentStack', () => {
  ResetState();
  const calls = [];
  suppressErrors = true;
  const tree = TestRenderer.create(
    React.createElement(
      AllStakProvider,
      {
        apiKey: 'ask_test_4',
        fallback: React.createElement('span', null, 'x'),
        onError: (error, componentStack) => calls.push({ error, componentStack }),
      },
      React.createElement(Boom),
    ),
  );
  suppressErrors = false;
  assert.equal(calls.length, 1);
  assert.equal(calls[0].error.message, 'render-time boom');
  // componentStack may be undefined in test renderer but should be string-or-undefined
  assert.ok(calls[0].componentStack === undefined || typeof calls[0].componentStack === 'string');
  tree.unmount();
});

test('captured exception is shipped with source=AllStakProvider.ErrorBoundary', async () => {
  ResetState();
  suppressErrors = true;
  const tree = TestRenderer.create(
    React.createElement(
      AllStakProvider,
      { apiKey: 'ask_test_5', fallback: React.createElement('span', null, 'x') },
      React.createElement(Boom),
    ),
  );
  suppressErrors = false;
  // Allow microtasks to flush the transport.
  await new Promise((r) => setTimeout(r, 60));
  const errorEvents = sent.filter((s) => s.url.endsWith('/ingest/v1/errors'));
  assert.ok(errorEvents.length >= 1, 'expected at least one error ingest call');
  const body = JSON.parse(errorEvents[0].init.body);
  assert.equal(body.message, 'render-time boom');
  assert.equal(body.metadata.source, 'AllStakProvider.ErrorBoundary');
  assert.equal(body.platform, 'react-native');
  tree.unmount();
});

test('destroyOnUnmount=false (default) keeps SDK alive after unmount', () => {
  ResetState();
  let tree;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        AllStakProvider,
        { apiKey: 'ask_test_6' },
        React.createElement('div', null, 'a'),
      ),
    );
  });
  assert.ok(AllStak._getInstance(), 'SDK should be initialized');
  act(() => { tree.unmount(); });
  assert.ok(AllStak._getInstance(), 'SDK should still be alive after unmount with default settings');
});

test('destroyOnUnmount=true tears down on unmount', () => {
  ResetState();
  let tree;
  act(() => {
    tree = TestRenderer.create(
      React.createElement(
        AllStakProvider,
        { apiKey: 'ask_test_7', destroyOnUnmount: true },
        React.createElement('div', null, 'a'),
      ),
    );
  });
  assert.ok(AllStak._getInstance(), 'SDK should be initialized');
  act(() => { tree.unmount(); });
  assert.equal(AllStak._getInstance(), null, 'SDK should be destroyed after unmount');
});

test('remount with default settings reuses the same SDK instance — no double init', () => {
  ResetState();
  let tree1, tree2;
  act(() => {
    tree1 = TestRenderer.create(
      React.createElement(
        AllStakProvider,
        { apiKey: 'ask_test_8' },
        React.createElement('div', null, 'a'),
      ),
    );
  });
  const firstInstance = AllStak._getInstance();
  const firstSession = AllStak.getSessionId();
  act(() => { tree1.unmount(); });

  act(() => {
    tree2 = TestRenderer.create(
      React.createElement(
        AllStakProvider,
        { apiKey: 'ask_test_8' },
        React.createElement('div', null, 'b'),
      ),
    );
  });
  const secondInstance = AllStak._getInstance();
  const secondSession = AllStak.getSessionId();

  assert.equal(secondInstance, firstInstance, 'instance must be the same object');
  assert.equal(secondSession, firstSession, 'session id must persist across remount');
  act(() => { tree2.unmount(); });
});

test('manual AllStak.captureException works after provider mount', async () => {
  ResetState();
  const tree = TestRenderer.create(
    React.createElement(
      AllStakProvider,
      { apiKey: 'ask_test_9' },
      React.createElement('div', null, 'a'),
    ),
  );
  sent.length = 0;
  AllStak.captureException(new Error('manual'));
  await new Promise((r) => setTimeout(r, 50));
  const errorEvents = sent.filter((s) => s.url.endsWith('/ingest/v1/errors'));
  assert.ok(errorEvents.length >= 1);
  const body = JSON.parse(errorEvents[0].init.body);
  assert.equal(body.message, 'manual');
  tree.unmount();
});
