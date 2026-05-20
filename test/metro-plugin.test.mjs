import { test } from 'node:test';
import assert from 'node:assert/strict';

const metro = await import('../dist/metro.mjs');

test('@allstak/react-native/metro exports React Native Metro helpers', () => {
  assert.equal(typeof metro.withAllStakConfig, 'function');
  assert.equal(typeof metro.getAllStakExpoConfig, 'function');
  assert.equal(typeof metro.addDebugIdToBundle, 'function');
});

test('withAllStakConfig wraps a custom serializer and exposes allstakBundleCallback', async () => {
  const config = metro.withAllStakConfig({
    serializer: {
      customSerializer(_entryPoint, _preModules, _graph, options) {
        assert.equal(typeof options.allstakBundleCallback, 'function');
        const bundle = options.allstakBundleCallback({ modules: [[1, 'console.log("x");']], post: '' });
        return { code: bundle.post, map: [] };
      },
    },
  });

  const result = await config.serializer.customSerializer('index.js', [], {}, {});
  assert.match(result.code, /\/\/# debugId=[0-9a-f-]{36}/);
});

test('addDebugIdToBundle is idempotent', () => {
  const first = metro.addDebugIdToBundle({ modules: [[1, 'console.log("x");']], post: '' });
  const second = metro.addDebugIdToBundle(first);
  const a = first.post.match(/debugId=([0-9a-f-]{36})/)[1];
  const b = second.post.match(/debugId=([0-9a-f-]{36})/)[1];
  assert.equal(a, b);
});
